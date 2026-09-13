import { eq } from "drizzle-orm";
import { getSiteUser } from "@/app/site-auth";
import { getDb } from "@/db";
import { experimentJourneys } from "@/db/schema";
import { emptyJourney, mergeJourney } from "@/lib/experiment-journey";
import { noStoreJson } from "../records/record-server";

export async function GET() {
  try {
    const user = await getSiteUser();
    if (!user) return noStoreJson({ error: "请先登录后恢复实验流程" }, { status: 401 });
    const [row] = await getDb().select().from(experimentJourneys)
      .where(eq(experimentJourneys.userId, user.userId)).limit(1);
    const journey = row ? mergeJourney(JSON.parse(row.payload)) : structuredClone(emptyJourney);
    return noStoreJson({ journey: { ...journey, updatedAt: row?.updatedAt.getTime() ?? 0 } });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : "实验流程暂不可用" }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  try {
    const user = await getSiteUser();
    if (!user) return noStoreJson({ error: "请先登录后保存实验流程" }, { status: 401 });
    const body = await request.json() as { journey?: unknown };
    const journey = mergeJourney(body.journey);
    const now = new Date();
    journey.updatedAt = now.getTime();
    const payload = JSON.stringify(journey);
    if (payload.length > 100_000) return noStoreJson({ error: "流程数据过大" }, { status: 413 });
    await getDb().insert(experimentJourneys).values({ userId: user.userId, payload, updatedAt: now })
      .onConflictDoUpdate({ target: experimentJourneys.userId, set: { payload, updatedAt: now } });
    return noStoreJson({ journey });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : "流程保存失败" }, { status: 503 });
  }
}

export async function DELETE() {
  try {
    const user = await getSiteUser();
    if (!user) return noStoreJson({ error: "请先登录后重置实验流程" }, { status: 401 });
    await getDb().delete(experimentJourneys).where(eq(experimentJourneys.userId, user.userId));
    return noStoreJson({ journey: structuredClone(emptyJourney) });
  } catch (error) {
    return noStoreJson({ error: error instanceof Error ? error.message : "实验流程重置失败" }, { status: 503 });
  }
}
