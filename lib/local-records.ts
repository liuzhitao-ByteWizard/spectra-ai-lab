import type { ExperimentImageSlot, RecordSnapshot, SavedRecord } from "./experiment-record";
import { normalizeAuraUsage } from "./aura-usage";

const DB_NAME = "spectra-local-records";
const DB_VERSION = 1;
const RECORDS_STORE = "records";
const IMAGES_STORE = "images";
const IMAGE_SLOTS: ExperimentImageSlot[] = ["zero_reference", "primary", "repeat_2", "repeat_3"];

type StoredRecord = Omit<SavedRecord, "imageUrls">;
type StoredImage = {
  recordId: string;
  slot: ExperimentImageSlot;
  blob: Blob;
  type: string;
  updatedAt: number;
};
type BackupImageMap = Partial<Record<ExperimentImageSlot, string>>;
type BackupRecord = StoredRecord & { images?: BackupImageMap };
type BackupPayload = {
  format: "spectra-experiment-backup";
  system: "spectra-parameter-inversion";
  version: 1;
  exportedAt: string;
  records: BackupRecord[];
};

let databasePromise: Promise<IDBDatabase> | null = null;

function notifyLocalRecordsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("spectra-local-records-changed"));
}

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("当前浏览器不支持本地记录存储"));
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(RECORDS_STORE)) {
          database.createObjectStore(RECORDS_STORE, { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains(IMAGES_STORE)) {
          const images = database.createObjectStore(IMAGES_STORE, { keyPath: ["recordId", "slot"] });
          images.createIndex("recordId", "recordId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("本地记录数据库打开失败"));
    });
  }
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地记录操作失败"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地记录事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地记录事务已取消"));
  });
}

function storedRecord(record: SavedRecord): StoredRecord {
  return {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
    task: record.task,
    source: record.source,
    resultLabel: record.resultLabel,
    resultValue: record.resultValue,
    quality: record.quality,
    status: record.status,
    steps: record.steps,
    diagnosis: record.diagnosis,
    payload: record.payload,
  };
}

function withImageUrls(record: StoredRecord, images: StoredImage[]): SavedRecord {
  const imageUrls: Partial<Record<ExperimentImageSlot, string>> = {};
  for (const image of images) {
    if (IMAGE_SLOTS.includes(image.slot) && image.blob instanceof Blob) {
      imageUrls[image.slot] = URL.createObjectURL(image.blob);
    }
  }
  return { ...record, imageUrls };
}

async function readStoredRecords(database: IDBDatabase) {
  return requestResult(database.transaction(RECORDS_STORE, "readonly").objectStore(RECORDS_STORE).getAll()) as Promise<StoredRecord[]>;
}

async function readStoredImages(database: IDBDatabase, recordId?: string) {
  const store = database.transaction(IMAGES_STORE, "readonly").objectStore(IMAGES_STORE);
  if (recordId) return requestResult(store.index("recordId").getAll(recordId)) as Promise<StoredImage[]>;
  return requestResult(store.getAll()) as Promise<StoredImage[]>;
}

export async function listLocalRecords(limit = 100) {
  const database = await openDatabase();
  const [records, images] = await Promise.all([readStoredRecords(database), readStoredImages(database)]);
  const byRecord = new Map<string, StoredImage[]>();
  for (const image of images) {
    const list = byRecord.get(image.recordId) ?? [];
    list.push(image);
    byRecord.set(image.recordId, list);
  }
  return records
    .sort((left, right) => Number(new Date(right.updatedAt)) - Number(new Date(left.updatedAt)))
    .slice(0, limit)
    .map((record) => withImageUrls(record, byRecord.get(record.id) ?? []));
}

export async function deleteLocalRecord(recordId: string) {
  const database = await openDatabase();
  const imageKeys = await requestResult(
    database.transaction(IMAGES_STORE, "readonly").objectStore(IMAGES_STORE).index("recordId").getAllKeys(recordId),
  );
  const transaction = database.transaction([RECORDS_STORE, IMAGES_STORE], "readwrite");
  transaction.objectStore(RECORDS_STORE).delete(recordId);
  const imageStore = transaction.objectStore(IMAGES_STORE);
  for (const key of imageKeys) imageStore.delete(key);
  await transactionDone(transaction);
  notifyLocalRecordsChanged();
}

export async function saveLocalRecord(
  snapshot: RecordSnapshot,
  images: Partial<Record<ExperimentImageSlot, File>>,
  existing: { id: string; version: number } | null,
) {
  const database = await openDatabase();
  const now = Date.now();
  const previous = existing?.id
    ? await requestResult(database.transaction(RECORDS_STORE, "readonly").objectStore(RECORDS_STORE).get(existing.id)) as StoredRecord | undefined
    : undefined;
  const record: StoredRecord = {
    ...snapshot,
    id: previous?.id ?? existing?.id ?? crypto.randomUUID(),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    version: (previous?.version ?? existing?.version ?? 0) + 1,
  };
  const transaction = database.transaction([RECORDS_STORE, IMAGES_STORE], "readwrite");
  transaction.objectStore(RECORDS_STORE).put(record);
  const imageStore = transaction.objectStore(IMAGES_STORE);
  for (const [slot, file] of Object.entries(images) as [ExperimentImageSlot, File][]) {
    imageStore.put({ recordId: record.id, slot, blob: file, type: file.type || "image/jpeg", updatedAt: now } satisfies StoredImage);
  }
  await transactionDone(transaction);
  notifyLocalRecordsChanged();
  const savedImages = await readStoredImages(database, record.id);
  return withImageUrls(record, savedImages);
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("图片备份失败"));
    reader.readAsDataURL(blob);
  });
}

export async function exportLocalRecordsBackup() {
  const database = await openDatabase();
  const [records, images] = await Promise.all([readStoredRecords(database), readStoredImages(database)]);
  const byRecord = new Map<string, StoredImage[]>();
  for (const image of images) {
    const list = byRecord.get(image.recordId) ?? [];
    list.push(image);
    byRecord.set(image.recordId, list);
  }
  const backupRecords: BackupRecord[] = [];
  for (const record of records) {
    const imageData: BackupImageMap = {};
    for (const image of byRecord.get(record.id) ?? []) {
      imageData[image.slot] = await blobToDataUrl(image.blob);
    }
    backupRecords.push({ ...record, images: imageData });
  }
  const payload: BackupPayload = {
    format: "spectra-experiment-backup",
    system: "spectra-parameter-inversion",
    version: 1,
    exportedAt: new Date().toISOString(),
    records: backupRecords,
  };
  return new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function dataUrlBlob(dataUrl: string, type: string) {
  return fetch(dataUrl).then((response) => response.blob()).then((blob) => blob.type ? blob : new Blob([blob], { type }));
}

export async function importLocalRecordsBackup(file: File) {
  const parsed = JSON.parse(await file.text()) as unknown;
  const payload = objectValue(parsed);
  if (!Array.isArray(payload.records)) throw new Error("备份文件格式不正确");
  const prepared: Array<{ record: StoredRecord; images: Array<{ slot: ExperimentImageSlot; blob: Blob; type: string }> }> = [];
  for (const raw of payload.records) {
    const item = objectValue(raw) as Partial<StoredRecord> & { images?: Record<string, unknown> };
    if (typeof item.id !== "string" || !item.id) continue;
    const now = Date.now();
    const status = item.status === "completed" || item.status === "needs_review" ? item.status : "draft";
    const record: StoredRecord = {
      id: item.id,
      createdAt: typeof item.createdAt === "number" || typeof item.createdAt === "string" ? item.createdAt : now,
      updatedAt: typeof item.updatedAt === "number" || typeof item.updatedAt === "string" ? item.updatedAt : now,
      version: typeof item.version === "number" && Number.isFinite(item.version) ? item.version : 1,
      task: "A",
      source: typeof item.source === "string" ? item.source : "汞灯",
      resultLabel: typeof item.resultLabel === "string" ? item.resultLabel : "实验结果",
      resultValue: typeof item.resultValue === "string" ? item.resultValue : "进行中",
      quality: typeof item.quality === "string" ? item.quality : "进行中",
      status,
      steps: stringArray(item.steps),
      diagnosis: typeof item.diagnosis === "string" ? item.diagnosis : "",
      payload: objectValue(item.payload),
    };
    const images: Array<{ slot: ExperimentImageSlot; blob: Blob; type: string }> = [];
    for (const slot of IMAGE_SLOTS) {
      const dataUrl = item.images?.[slot];
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) continue;
      const blob = await dataUrlBlob(dataUrl, "image/jpeg");
      images.push({ slot, blob, type: blob.type || "image/jpeg" });
    }
    prepared.push({ record, images });
  }

  const database = await openDatabase();
  const transaction = database.transaction([RECORDS_STORE, IMAGES_STORE], "readwrite");
  const recordStore = transaction.objectStore(RECORDS_STORE);
  const imageStore = transaction.objectStore(IMAGES_STORE);
  for (const entry of prepared) {
    recordStore.put(entry.record);
    for (const image of entry.images) {
      imageStore.put({ recordId: entry.record.id, slot: image.slot, blob: image.blob, type: image.type, updatedAt: Date.now() } satisfies StoredImage);
    }
  }
  await transactionDone(transaction);
  notifyLocalRecordsChanged();
  return prepared.length;
}


function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function currentRecordData(record: SavedRecord) {
  const payload = objectValue(record.payload);
  const state = objectValue(payload.state);
  const result = objectValue(payload.result);
  const calibration = objectValue(result.calibration);
  const summary = objectValue(result.summary);
  const processing = objectValue(payload.processing);
  const lines = Array.isArray(result.lines) ? result.lines.map(objectValue) : [];
  const dUm = typeof calibration.dUm === "number" ? calibration.dUm : (typeof state.gratingDUm === "number" ? state.gratingDUm : null);
  const linesPerMm = typeof state.linesPerMm === "number" ? state.linesPerMm : (dUm ? 1000 / dUm : null);
  return { state, result, calibration, summary, processing, lines, dUm, linesPerMm };
}

export function buildRecordsCsv(records: SavedRecord[]) {
  const headers = [
    "记录编号", "创建时间", "最后更新", "光源", "状态", "质量", "结果标签", "结果值",
    "光栅线密度(线/mm)", "光栅常数d(μm)", "x0(px)", "L(px)", "拟合RMSE(nm)", "最大残差(nm)",
    "匹配谱线数", "候选峰数", "图像宽度(px)", "图像高度(px)", "诊断意见", "谱线明细", "AURA使用历史",
  ];
  const rows = records.map((record) => {
    const data = currentRecordData(record);
    const lineDetails = data.lines.map((line) => ({
      standardNm: line.standardNm ?? null,
      predictedNm: line.predictedNm ?? null,
      xPx: line.x ?? null,
      residualNm: line.residualNm ?? null,
      status: line.status ?? "",
    }));
    const maxResidual = typeof data.summary.maxAbsResidualNm === "number" ? data.summary.maxAbsResidualNm : null;
    const rmse = typeof data.calibration.rmseNm === "number" ? data.calibration.rmseNm : (typeof data.summary.rmseNm === "number" ? data.summary.rmseNm : null);
    return [
      record.id, new Date(record.createdAt).toISOString(), new Date(record.updatedAt).toISOString(), record.source,
      record.status === "draft" ? "进行中" : record.status === "needs_review" ? "需复核" : "已完成",
      record.quality, record.resultLabel, record.resultValue, data.linesPerMm, data.dUm, data.calibration.x0Px,
      data.calibration.effectiveLPx, rmse, maxResidual, data.lines.length, data.processing.candidateCount,
      data.summary.imageWidth, data.summary.imageHeight, record.diagnosis, JSON.stringify(lineDetails),
      normalizeAuraUsage(record.payload.assistant).used ? JSON.stringify(normalizeAuraUsage(record.payload.assistant)) : "",
    ];
  });
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function numberFromText(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function importLocalRecordsCsv(file: File) {
  const rows = parseCsv((await file.text()).replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("CSV 文件没有可导入的数据");
  const headers = rows[0].map((item) => item.trim());
  const indexOf = (name: string) => headers.indexOf(name);
  const prepared: StoredRecord[] = [];
  for (const row of rows.slice(1)) {
    const value = (name: string) => indexOf(name) >= 0 ? row[indexOf(name)] ?? "" : "";
    const id = value("记录编号") || crypto.randomUUID();
    const createdAt = value("创建时间") || new Date().toISOString();
    const updatedAt = value("最后更新") || createdAt;
    const dUm = numberFromText(value("光栅常数d(μm)"));
    const linesPerMm = numberFromText(value("光栅线密度(线/mm)")) ?? (dUm ? 1000 / dUm : null);
    const x0Px = numberFromText(value("x0(px)"));
    const effectiveLPx = numberFromText(value("L(px)"));
    const rmseNm = numberFromText(value("拟合RMSE(nm)"));
    const maxResidualNm = numberFromText(value("最大残差(nm)"));
    const imageWidth = numberFromText(value("图像宽度(px)")) ?? 0;
    const imageHeight = numberFromText(value("图像高度(px)")) ?? 0;
    let lineDetails: Array<Record<string, unknown>> = [];
    try { const parsed = JSON.parse(value("谱线明细") || "[]") as unknown; if (Array.isArray(parsed)) lineDetails = parsed.map(objectValue); } catch { lineDetails = []; }
    const lines = lineDetails.map((line) => ({
      id: `${id}-${crypto.randomUUID()}`,
      x: numberFromText(line.xPx) ?? 0,
      height: 1,
      colorName: "谱线",
      color: "#2563eb",
      matchKey: "",
      matchLabel: "谱线",
      standardNm: numberFromText(line.standardNm) ?? 0,
      predictedNm: numberFromText(line.predictedNm) ?? 0,
      residualNm: numberFromText(line.residualNm) ?? 0,
      status: typeof line.status === "string" ? line.status : "未复核",
      statusKey: "ok" as const,
      order: 1,
    }));
    const statusText = value("状态");
    const status = statusText === "已完成" ? "completed" : statusText === "需复核" ? "needs_review" : "draft";
    let assistant = normalizeAuraUsage(null);
    try { assistant = normalizeAuraUsage(JSON.parse(value("AURA使用历史") || "null")); } catch { assistant = normalizeAuraUsage(null); }
    const result = x0Px !== null || effectiveLPx !== null || lines.length ? {
      summary: { mode: "calibration", imageWidth, imageHeight, detectedCount: lines.length, usableCount: lines.length, matchedCount: lines.length, rmseNm, maxAbsResidualNm: maxResidualNm, fitQuality: value("质量"), dUm, manualCalibration: false, offlineFallback: false },
      calibration: x0Px !== null && effectiveLPx !== null && dUm !== null ? { dUm, x0Px, effectiveLPx, rmseNm: rmseNm ?? 0, sourceLineCount: lines.length, validRangeNm: [0, 0], createdAt: new Date(updatedAt).toISOString() } : undefined,
      lines, profile: [], annotations: [], detectedPeaks: [], processing: { candidateCount: numberFromText(value("候选峰数")) ?? 0, detectedCount: lines.length, usableCount: lines.length, matchedCount: lines.length, manual: false, fallbackRequired: false, fallbackMessage: "", steps: [] },
    } : null;
    prepared.push({
      id, createdAt, updatedAt, version: 1, task: "A", source: value("光源") || "汞灯光谱",
      resultLabel: value("结果标签") || "几何标定", resultValue: value("结果值") || "已导入", quality: value("质量") || "已导入", status,
      steps: ["CSV 导入", "本地记录恢复"], diagnosis: value("诊断意见"), payload: { measurementType: "known-grating-spectrum-calibration", state: { linesPerMm, gratingDUm: dUm, order: 1, complete: status === "completed" }, result, ...(assistant.used ? { assistant } : {}) },
    });
  }
  const database = await openDatabase();
  const transaction = database.transaction(RECORDS_STORE, "readwrite");
  const store = transaction.objectStore(RECORDS_STORE);
  for (const record of prepared) store.put(record);
  await transactionDone(transaction);
  notifyLocalRecordsChanged();
  return prepared.length;
}

export async function importLocalRecordsFile(file: File) {
  if (file.name.toLowerCase().endsWith(".csv") || file.type.includes("csv")) return importLocalRecordsCsv(file);
  return importLocalRecordsBackup(file);
}
