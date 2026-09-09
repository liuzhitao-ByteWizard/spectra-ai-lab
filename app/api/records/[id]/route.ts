import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { experiments } from "@/db/schema";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const [record] = await getDb().select().from(experiments).where(eq(experiments.id, id)).limit(1);
    if (!record) return Response.json({ error: "未找到记录" }, { status: 404 });
    return Response.json({ record: { ...record, payload: JSON.parse(record.payload) } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "读取失败" }, { status: 503 });
  }
}
