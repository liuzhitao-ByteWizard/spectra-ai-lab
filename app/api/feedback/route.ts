import { and, eq, gt, sql } from "drizzle-orm";
import { getSiteUser } from "@/app/site-auth";
import { getDb } from "@/db";
import { feedbackMessages } from "@/db/schema";

const CATEGORIES = new Set(["功能建议", "问题反馈", "内容建议", "其他"]);
const MAX_MESSAGE_LENGTH = 1200;
const MAX_CONTACT_LENGTH = 120;
const MAX_PAGE_LENGTH = 160;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;

function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body, { ...init, headers });
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function fingerprintRequest(request: Request) {
  const forwarded = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "unknown";
  const userAgent = request.headers.get("user-agent") || "";
  const bytes = new TextEncoder().encode(`${forwarded}|${userAgent}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (cleanText(body.website, 200)) return noStoreJson({ success: true }, { status: 201 });

    const message = cleanText(body.message, MAX_MESSAGE_LENGTH);
    if (message.length < 5) return noStoreJson({ error: "请至少输入 5 个字符的建议内容" }, { status: 400 });
    if (message.length > MAX_MESSAGE_LENGTH) return noStoreJson({ error: "留言内容不能超过 1200 个字符" }, { status: 400 });

    const categoryValue = cleanText(body.category, 20);
    const category = CATEGORIES.has(categoryValue) ? categoryValue : "其他";
    const contact = cleanText(body.contact, MAX_CONTACT_LENGTH);
    const page = cleanText(body.page, MAX_PAGE_LENGTH);
    const user = await getSiteUser().catch(() => null);
    const fingerprint = await fingerprintRequest(request);
    const cutoff = new Date(Date.now() - WINDOW_MS);
    const db = getDb();
    const [usage] = await db
      .select({ total: sql<number>`count(*)` })
      .from(feedbackMessages)
      .where(and(eq(feedbackMessages.fingerprint, fingerprint), gt(feedbackMessages.createdAt, cutoff)));

    if (Number(usage?.total ?? 0) >= MAX_PER_WINDOW) {
      return noStoreJson({ error: "留言提交过于频繁，请稍后再试" }, { status: 429 });
    }

    const id = crypto.randomUUID();
    await db.insert(feedbackMessages).values({
      id,
      category,
      message,
      contact,
      page,
      userId: user?.userId ?? null,
      userEmail: user?.email ?? null,
      fingerprint,
      userAgent: cleanText(request.headers.get("user-agent"), 300),
      createdAt: new Date(),
    });
    return noStoreJson({ success: true, id }, { status: 201 });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : 503;
    return noStoreJson({ error: error instanceof Error ? error.message : "留言提交失败" }, { status });
  }
}
