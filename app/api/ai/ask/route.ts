const faq = [
  { keys: ["黄光", "双线", "两条"], answer: "汞灯黄色谱线包含 576.96 nm 与 579.07 nm 两条相近跃迁。实验中应先放大并分别对中，再记录各自读数；把它们当成一条会让拟合残差变大。", source: "谱线识别 C1 / 实验步骤 3" },
  { keys: ["零级", "零位"], answer: "零级方向是入射光不发生偏转的参考方向。先对准零级，再分别测左右一级谱线并取半差，可以削弱仪器零位偏差。", source: "物理任务 E1 / 实验步骤 2" },
  { keys: ["光栅常数", "测 d", "怎么算"], answer: "对每条已知波长计算 sinθ，再用 λ=d·sinθ 做过原点加权拟合。斜率给出 d，最后结合角度分度值与重复性给出扩展不确定度 U(k=2)。", source: "物理任务 E1" },
  { keys: ["过曝", "曝光"], answer: "过曝会把窄谱线扩成宽亮带，峰位和黄双线间距都会失真。降低曝光或点暗处测光，直到谱线中心仍有亮度梯度。", source: "图像预处理 A4" },
  { keys: ["误差", "偏差"], answer: "先看偏差形态：全部谱线同向偏移多与零级或游标零位有关；蓝紫端偏差大多与弱光和像差有关；单条异常则优先复核配线与手读。", source: "双通道诊断 F4" },
];

export async function POST(request: Request) {
  const body = (await request.json()) as { question?: string };
  const question = body.question?.trim() ?? "";
  if (!question) return Response.json({ error: "请输入问题" }, { status: 400 });
  const item = faq.find((entry) => entry.keys.some((key) => question.includes(key))) ?? {
    answer: "先确认你卡在对光、认线、读数还是计算。若是读数问题，请告诉我光源、谱线颜色和当前角度；我会按实验步骤帮你定位，不直接替你跳过判断。",
    source: "离线知识库 · 实验总流程",
  };
  return Response.json({ answer: item.answer, sources: [item.source], offline: true });
}
