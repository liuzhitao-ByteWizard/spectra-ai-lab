export type ExperimentTask = "A" | "B";
export type ExperimentStatus = "draft" | "completed" | "needs_review";
export type ExperimentImageSlot = "primary" | "repeat_2" | "repeat_3" | "reference" | "unknown";

export type ExperimentPayload = Record<string, unknown>;

export type SavedRecord = {
  id: string;
  createdAt: string | number;
  updatedAt: string | number;
  version: number;
  task: ExperimentTask;
  source: string;
  resultLabel: string;
  resultValue: string;
  quality: string;
  status: ExperimentStatus;
  steps: string[];
  diagnosis: string;
  imageUrls: Partial<Record<ExperimentImageSlot, string>>;
  payload: ExperimentPayload;
};

export type RecordSnapshot = Pick<
  SavedRecord,
  "task" | "source" | "resultLabel" | "resultValue" | "quality" | "status" | "steps" | "diagnosis" | "payload"
>;

export class RecordRequestError extends Error {
  status: number;
  record?: SavedRecord;

  constructor(message: string, status: number, record?: SavedRecord) {
    super(message);
    this.name = "RecordRequestError";
    this.status = status;
    this.record = record;
  }
}

function retryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

export async function requestRecordJson<T>(input: RequestInfo | URL, init?: RequestInit, attempts = 3, onRetry?: (attempt: number) => void): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(input, { ...init, cache: "no-store" });
      const data = await response.json().catch(() => ({})) as { error?: string; record?: SavedRecord };
      if (response.ok) return data as T;
      const error = new RecordRequestError(data.error || "记录服务暂不可用", response.status, data.record);
      if (!retryableStatus(response.status) || attempt === attempts - 1) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof RecordRequestError && !retryableStatus(error.status)) throw error;
      lastError = error;
      if (attempt === attempts - 1) break;
    }
    onRetry?.(attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error("记录服务暂不可用");
}
