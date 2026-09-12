import { env } from "cloudflare:workers";
import { and, count, eq } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { experiments } from "@/db/schema";
import { noStoreJson, safeImageKeys } from "../../records/record-server";

const CONFIRMATION = "PERMANENTLY_DELETE_MY_TASK_B";

export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return noStoreJson({ error: "仅当前站点所有者可以执行清理" }, { status: 401 });
    const body = await request.json() as { confirm?: string };
    if (body.confirm !== CONFIRMATION) return noStoreJson({ error: "缺少永久清理确认口令" }, { status: 400 });
    if (!env.BUCKET) return noStoreJson({ error: "图片存储不可用，未删除任何数据库记录" }, { status: 503 });

    const rows = await getDb().select().from(experiments)
      .where(and(eq(experiments.userId, user.userId), eq(experiments.task, "B")));
    const deletedImages: string[] = [];
    const deletedRecords: string[] = [];
    const failures: { id: string; key?: string; error: string }[] = [];

    for (const row of rows) {
      const keys = Object.values(safeImageKeys(row.imageKeys));
      let imagesRemoved = true;
      for (const key of keys) {
        try {
          await env.BUCKET.delete(key);
          const remains = await env.BUCKET.head(key);
          if (remains) throw new Error("删除后对象仍存在");
          deletedImages.push(key);
        } catch (error) {
          imagesRemoved = false;
          failures.push({ id: row.id, key, error: error instanceof Error ? error.message : "图片删除失败" });
        }
      }
      if (!imagesRemoved) continue;
      await getDb().delete(experiments).where(and(eq(experiments.id, row.id), eq(experiments.userId, user.userId), eq(experiments.task, "B")));
      deletedRecords.push(row.id);
    }

    const [{ remaining }] = await getDb().select({ remaining: count() }).from(experiments)
      .where(and(eq(experiments.userId, user.userId), eq(experiments.task, "B")));
    return noStoreJson({ found: rows.length, deletedRecordCount: deletedRecords.length, deletedImageCount: deletedImages.length, remaining, deletedRecords, deletedImages, failures, verified: remaining === 0 && failures.length === 0 });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : "清理失败" }, { status: 503 });
  }
}
