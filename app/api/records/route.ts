import { desc } from "drizzle-orm";
import { getDb } from "@/db";
import { experiments } from "@/db/schema";

export async function GET() {
  try {
    const records = await getDb().select().from(experiments).orderBy(desc(experiments.createdAt)).limit(30);
    return Response.json({ records: records.map((record) => ({ ...record, payload: JSON.parse(record.payload) })) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "记录暂不可用" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const id = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
    const createdAt = new Date();
    const task = body.task === "B" ? "B" : "A";
    const source = typeof body.source === "string" ? body.source.slice(0, 32) : "汞灯";
    const resultLabel = typeof body.resultLabel === "string" ? body.resultLabel.slice(0, 32) : "光栅常数 d";
    const resultValue = typeof body.resultValue === "string" ? body.resultValue.slice(0, 64) : "—";
    const quality = typeof body.quality === "string" ? body.quality.slice(0, 16) : "待复核";
    const [record] = await getDb().insert(experiments).values({
      id, createdAt, task, source, resultLabel, resultValue, quality, payload: JSON.stringify(body.payload ?? {}),
    }).returning();
    return Response.json({ record: { ...record, payload: JSON.parse(record.payload) } }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存失败" }, { status: 503 });
  }
}
