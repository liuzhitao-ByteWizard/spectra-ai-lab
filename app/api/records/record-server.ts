import type { ExperimentImageSlot, ExperimentStatus, ExperimentTask } from "@/lib/experiment-record";

type DbRecord = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  task: ExperimentTask;
  source: string;
  resultLabel: string;
  resultValue: string;
  quality: string;
  status: ExperimentStatus;
  steps: string;
  diagnosis: string;
  imageKeys: string;
  payload: string;
};

export function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function safeStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function safeImageKeys(value: string): Partial<Record<ExperimentImageSlot, string>> {
  const parsed = safeJsonObject(value);
  const result: Partial<Record<ExperimentImageSlot, string>> = {};
  for (const slot of ["zero_reference", "primary", "repeat_2", "repeat_3"] as const) {
    if (typeof parsed[slot] === "string") result[slot] = parsed[slot] as string;
  }
  return result;
}

export function serializeRecord(record: DbRecord) {
  const imageKeys = safeImageKeys(record.imageKeys);
  return {
    id: record.id,
    createdAt: record.createdAt.getTime(),
    updatedAt: record.updatedAt.getTime(),
    version: record.version,
    task: record.task,
    source: record.source,
    resultLabel: record.resultLabel,
    resultValue: record.resultValue,
    quality: record.quality,
    status: record.status,
    steps: safeStringArray(record.steps),
    diagnosis: record.diagnosis,
    imageUrls: Object.fromEntries(Object.keys(imageKeys).map((slot) => [slot, `/api/records/${encodeURIComponent(record.id)}/image?slot=${slot}&v=${record.version}`])),
    payload: safeJsonObject(record.payload),
  };
}

export function parseRecordBody(body: Record<string, unknown>) {
  if (body.task !== undefined && body.task !== "A") throw new Error("仅支持汞灯已知谱线测量任务");
  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
  const payloadText = JSON.stringify(payload);
  if (payloadText.length > 750_000) throw new Error("实验数据过大，请减少无关数据后重试");
  const rawSteps = Array.isArray(body.steps) ? body.steps : [];
  const steps = rawSteps.filter((item): item is string => typeof item === "string").slice(0, 12);
  const status: ExperimentStatus = body.status === "needs_review" ? "needs_review" : body.status === "completed" ? "completed" : "draft";
  return {
    task: "A" as ExperimentTask,
    source: typeof body.source === "string" ? body.source.slice(0, 32) : "汞灯",
    resultLabel: typeof body.resultLabel === "string" ? body.resultLabel.slice(0, 32) : "实验结果",
    resultValue: typeof body.resultValue === "string" ? body.resultValue.slice(0, 96) : "进行中",
    quality: typeof body.quality === "string" ? body.quality.slice(0, 16) : "进行中",
    status,
    steps: JSON.stringify(steps),
    diagnosis: typeof body.diagnosis === "string" ? body.diagnosis.slice(0, 2000) : "",
    payload: payloadText,
  };
}

export function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body, { ...init, headers });
}
