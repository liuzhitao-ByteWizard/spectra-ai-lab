import { env } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { experiments } from "@/db/schema";
import type { ExperimentImageSlot } from "@/lib/experiment-record";
import { noStoreJson, safeImageKeys, serializeRecord } from "../../record-server";

type RouteContext = { params: Promise<{ id: string }> };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function imageSlot(request: Request): ExperimentImageSlot | null {
  const slot = new URL(request.url).searchParams.get("slot");
  return slot === "primary" || slot === "repeat_2" || slot === "repeat_3" ? slot : null;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await getChatGPTUser();
    if (!user) return noStoreJson({ error: "请先登录后查看原始图片" }, { status: 401 });
    if (!env.BUCKET) return noStoreJson({ error: "图片存储暂不可用" }, { status: 503 });
    const slot = imageSlot(request);
    if (!slot) return noStoreJson({ error: "图片类型无效" }, { status: 400 });
    const { id } = await context.params;
    const [record] = await getDb().select().from(experiments)
      .where(and(eq(experiments.id, id), eq(experiments.userId, user.userId), eq(experiments.task, "A")))
      .limit(1);
    if (!record) return noStoreJson({ error: "未找到记录" }, { status: 404 });
    const key = safeImageKeys(record.imageKeys)[slot];
    if (!key) return noStoreJson({ error: "该记录没有原始图片" }, { status: 404 });
    const object = await env.BUCKET.get(key);
    if (!object) return noStoreJson({ error: "原始图片不存在" }, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Cache-Control", "private, no-cache");
    headers.set("ETag", object.httpEtag);
    return new Response(object.body, { headers });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : "图片读取失败" }, { status: 503 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await getChatGPTUser();
    if (!user) return noStoreJson({ error: "请先登录后同步原始图片" }, { status: 401 });
    if (!env.BUCKET) return noStoreJson({ error: "图片存储暂不可用" }, { status: 503 });
    const slot = imageSlot(request);
    if (!slot) return noStoreJson({ error: "图片类型无效" }, { status: 400 });
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return noStoreJson({ error: "只支持图片文件" }, { status: 415 });
    const declaredSize = Number(request.headers.get("content-length") || 0);
    if (declaredSize > MAX_IMAGE_BYTES) return noStoreJson({ error: "原始图片不能超过 10 MB" }, { status: 413 });

    const { id } = await context.params;
    const [current] = await getDb().select().from(experiments)
      .where(and(eq(experiments.id, id), eq(experiments.userId, user.userId), eq(experiments.task, "A")))
      .limit(1);
    if (!current) return noStoreJson({ error: "未找到记录" }, { status: 404 });
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) return noStoreJson({ error: "原始图片不能超过 10 MB" }, { status: 413 });

    const key = `${user.userId}/${id}/${slot}`;
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
    const imageKeys = { ...safeImageKeys(current.imageKeys), [slot]: key };
    const [record] = await getDb().update(experiments).set({
      imageKeys: JSON.stringify(imageKeys),
      updatedAt: new Date(),
      version: sql`${experiments.version} + 1`,
    }).where(and(eq(experiments.id, id), eq(experiments.userId, user.userId), eq(experiments.task, "A"))).returning();
    return noStoreJson({ record: serializeRecord(record) });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : "图片同步失败" }, { status: 503 });
  }
}
