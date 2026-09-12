import { getChatGPTUser } from "@/app/chatgpt-auth";

const referenceNotes = [
  "汞灯黄色谱线包含 576.96 nm 与 579.07 nm 两条相近跃迁。实验中应先放大并分别对中，再记录各自读数。",
  "图像测量必须先独立定位零级 x0，再用单侧一级已知汞线拟合 x_i=x0+L tan(arcsin(lambda_i/d))。",
  "测光栅常数时，对每条已知波长计算 sinθ，再用 λ=d·sinθ 做过原点加权拟合；斜率给出 d。",
  "过曝会把窄谱线扩成宽亮带，使峰位和黄双线间距失真。应降低曝光，直到谱线中心仍有亮度梯度。",
  "全部谱线同向偏移应先复核零级；蓝紫端系统残差可作为镜头畸变诊断，但不应增加自由参数掩盖 d–L 相关性。",
];

const systemPrompt = `你是一个通用型 AI 助手，同时具备大学物理分光计与光栅实验的专业辅导能力。
你可以回答用户提出的各类安全、合法问题，包括通用知识、学习辅导、写作整理、编程分析、生活建议和物理实验；不要把非物理问题强行引向物理实验。
回答应简洁、准确、自然。信息不足时先说明缺少什么；涉及实时信息或高风险结论时，明确提醒用户进一步核实。
当问题与分光计实验有关时，先指出学生所处的实验步骤和判断依据，再给下一步提示；不要伪造实验读数或替学生跳过观察和判断。下方课程参考知识仅在相关物理实验问题中使用。
输出可以使用 Markdown 加粗和列表；列表中的每一项必须单独成行，并在列表前后留空行。
数学公式一律使用网页可直接显示的 Unicode 写法，例如“λ = d·sinθ”，不要输出 LaTeX 命令或反斜杠。

课程参考知识：
${referenceNotes.map((note, index) => `${index + 1}. ${note}`).join("\n")}`;

type DeepSeekResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
};

function normalizeAnswer(content: string) {
  return content
    .replace(/\\\(|\\\)|\\\[|\\\]/g, "")
    .replace(/\\lambda\b/g, "λ")
    .replace(/\\theta\b/g, "θ")
    .replace(/\\sin\b/g, "sin")
    .replace(/\\cdot\b/g, "·");
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录后使用 AI 助教" }, { status: 401 });

  const body = (await request.json()) as { question?: string };
  const question = body.question?.trim() ?? "";

  if (!question) {
    return Response.json({ error: "请输入问题" }, { status: 400 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "AI 助教尚未配置服务密钥" },
      { status: 503 },
    );
  }

  const requestBody = JSON.stringify({
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    thinking: { type: "disabled" },
    max_tokens: 1200,
    stream: false,
  });

  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: requestBody,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt === 0) continue;
      return Response.json(
        { error: "AI 服务响应超时，请稍后重试" },
        { status: 504 },
      );
    }

    if (response.ok || ![408, 429, 500, 502, 503, 504].includes(response.status)) {
      break;
    }
  }

  if (!response) {
    return Response.json({ error: "AI 服务暂时不可用" }, { status: 502 });
  }

  let data: DeepSeekResponse = {};
  try {
    data = (await response.json()) as DeepSeekResponse;
  } catch {
    return Response.json({ error: "AI 服务返回了无效响应，请稍后重试" }, { status: 502 });
  }
  if (!response.ok) {
    console.error("DeepSeek API request failed", response.status, data.error?.message);
    return Response.json(
      { error: "AI 服务暂时不可用，请稍后重试" },
      { status: 502 },
    );
  }

  const content = data.choices?.[0]?.message?.content?.trim();
  const answer = content ? normalizeAnswer(content) : "";
  if (!answer) {
    return Response.json(
      { error: "AI 助教没有返回有效答案，请换一种问法" },
      { status: 502 },
    );
  }

  return Response.json({
    answer,
    sources: ["AI 助教 · 物理实验与通用问答"],
    offline: false,
  });
}
