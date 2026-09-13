import { and, eq } from "drizzle-orm";
import { getSiteUser } from "@/app/site-auth";
import { getDb } from "@/db";
import { experiments } from "@/db/schema";
import { noStoreJson, parseRecordBody, serializeRecord } from "../record-server";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await getSiteUser();
    if (!user) return noStoreJson({ error: "请先登录后读取实验记录" }, { status: 401 });
    const { id } = await context.params;
    const [record] = await getDb().select().from(experiments)
      .where(and(eq(experiments.id, id), eq(experiments.userId, user.userId), eq(experiments.task, "A")))
      .limit(1);
    if (!record) return noStoreJson({ error: "未找到记录" }, { status: 404 });
    return noStoreJson({ record: serializeRecord(record) });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : "读取失败" }, { status: 503 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const user = await getSiteUser();
    if (!user) return noStoreJson({ error: "请先登录后更新实验记录" }, { status: 401 });
    const { id } = await context.params;
    const body = (await request.json()) as Record<string, unknown>;
    const baseVersion = Number(body.baseVersion);
    const mutationId = typeof body.mutationId === "string" ? body.mutationId.slice(0, 80) : crypto.randomUUID();
    if (!Number.isInteger(baseVersion) || baseVersion < 1) {
      return noStoreJson({ error: "同步版本无效" }, { status: 400 });
    }

    const [current] = await getDb().select().from(experiments)
      .where(and(eq(experiments.id, id), eq(experiments.userId, user.userId), eq(experiments.task, "A")))
      .limit(1);
    if (!current) return noStoreJson({ error: "未找到记录" }, { status: 404 });
    if (current.lastMutationId === mutationId) return noStoreJson({ record: serializeRecord(current) });
    if (current.version !== baseVersion) {
      return noStoreJson({ error: "另一台设备已保存更新，已采用最新版本", record: serializeRecord(current) }, { status: 409 });
    }

    const values = parseRecordBody(body);
    const [record] = await getDb().update(experiments).set({
      ...values,
      updatedAt: new Date(),
      version: baseVersion + 1,
      lastMutationId: mutationId,
    }).where(and(
      eq(experiments.id, id),
      eq(experiments.userId, user.userId),
      eq(experiments.task, "A"),
      eq(experiments.version, baseVersion),
    )).returning();

    if (!record) {
      const [latest] = await getDb().select().from(experiments)
        .where(and(eq(experiments.id, id), eq(experiments.userId, user.userId), eq(experiments.task, "A")))
        .limit(1);
      return noStoreJson({ error: "另一台设备已保存更新，已采用最新版本", record: latest ? serializeRecord(latest) : undefined }, { status: 409 });
    }
    return noStoreJson({ record: serializeRecord(record) });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 503;
    return noStoreJson({ error: error instanceof Error ? error.message : "更新失败" }, { status });
  }
}
