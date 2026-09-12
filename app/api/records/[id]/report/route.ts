import { and, eq } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { experiments } from "@/db/schema";
import { serializeRecord } from "../../record-server";
import { buildExperimentReportHtml } from "../../report-html";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await getChatGPTUser();
    if (!user) return new Response("请先登录后查看实验报告", { status: 401 });
    const { id } = await context.params;
    const [record] = await getDb().select().from(experiments)
      .where(and(eq(experiments.id, id), eq(experiments.userId, user.userId), eq(experiments.task, "A")))
      .limit(1);
    if (!record) return new Response("未找到实验记录", { status: 404 });
    return new Response(buildExperimentReportHtml(serializeRecord(record)), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "报告生成失败", { status: 503 });
  }
}
