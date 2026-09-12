import { and, desc, eq, gt } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { experiments } from "@/db/schema";
import { noStoreJson, parseRecordBody, serializeRecord } from "./record-server";

export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return noStoreJson({ error: "请先登录后同步实验记录" }, { status: 401 });

    const url = new URL(request.url);
    const task = url.searchParams.get("task");
    const since = Number(url.searchParams.get("since") || 0);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
    const filters = [eq(experiments.userId, user.userId)];
    if (task && task !== "A") return noStoreJson({ error: "仅支持汞灯已知谱线测量任务" }, { status: 400 });
    filters.push(eq(experiments.task, "A"));
    if (Number.isFinite(since) && since > 0) filters.push(gt(experiments.updatedAt, new Date(since)));

    const records = await getDb().select().from(experiments)
      .where(and(...filters))
      .orderBy(desc(experiments.updatedAt))
      .limit(limit);
    return noStoreJson({ records: records.map(serializeRecord), serverTime: Date.now() });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : "记录暂不可用" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return noStoreJson({ error: "请先登录后保存实验记录" }, { status: 401 });

    const body = (await request.json()) as Record<string, unknown>;
    const id = typeof body.id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(body.id) ? body.id : crypto.randomUUID();
    const mutationId = typeof body.mutationId === "string" ? body.mutationId.slice(0, 80) : crypto.randomUUID();
    const [existing] = await getDb().select().from(experiments).where(eq(experiments.id, id)).limit(1);
    if (existing) {
      if (existing.userId === user.userId && existing.lastMutationId === mutationId) {
        return noStoreJson({ record: serializeRecord(existing) });
      }
      return noStoreJson({ error: "该记录已存在" }, { status: 409 });
    }

    const now = new Date();
    const values = parseRecordBody(body);
    const [record] = await getDb().insert(experiments).values({
      id,
      userId: user.userId,
      createdAt: now,
      updatedAt: now,
      version: 1,
      lastMutationId: mutationId,
      imageKeys: "{}",
      ...values,
    }).returning();
    return noStoreJson({ record: serializeRecord(record) }, { status: 201 });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 503;
    return noStoreJson({ error: error instanceof Error ? error.message : "保存失败" }, { status });
  }
}
