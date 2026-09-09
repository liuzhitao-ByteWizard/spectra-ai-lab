export async function GET() {
  return Response.json({
    mode: "offline",
    faq: [
      { category: "原理", question: "为什么要测左右两侧？", answer: "左右位置取半差可以削弱零位误差。" },
      { category: "操作", question: "为什么黄光是两条？", answer: "它们是 576.96 nm 与 579.07 nm 两条相近汞谱线。" },
      { category: "误差", question: "过曝有什么影响？", answer: "过曝会拓宽亮线并移动检测峰位。" },
      { category: "算法", question: "AI 如何认线？", answer: "融合亮度、颜色和竖线段候选，再用物理拟合残差选择配对。" },
    ],
  });
}
