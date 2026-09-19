export type AuraUsageModuleId = "home" | "simulator" | "assistant" | "analysis" | "records";
export type AuraUsageMode = "local" | "online" | "mixed";
export type AuraUsageEventMode = "local" | "online" | "unavailable";
export type AuraUsagePromptType = "next-step" | "button-help" | "progress" | "page" | "disabled-button" | "custom";
export type AuraUsageAction =
  | "assistant_opened"
  | "auto_hint_shown"
  | "hint_opened"
  | "hint_navigation"
  | "question_answered_locally"
  | "question_answered_online"
  | "online_login_required"
  | "online_request_failed";

export type AuraUsageEvent = {
  at: string;
  module: AuraUsageModuleId;
  action: AuraUsageAction;
  promptType?: AuraUsagePromptType;
  mode?: AuraUsageEventMode;
  targetModule?: AuraUsageModuleId;
};

export type AuraUsageEventInput = Omit<AuraUsageEvent, "at"> & { at?: string };
export type AuraUsage = {
  version: 1;
  used: boolean;
  interactionCount: number;
  firstUsedAt?: string;
  lastUsedAt?: string;
  lastModule?: AuraUsageModuleId;
  lastPromptType?: AuraUsagePromptType;
  mode?: AuraUsageMode;
  events: AuraUsageEvent[];
};

export const MAX_AURA_USAGE_EVENTS = 40;

const MODULE_LABELS: Record<AuraUsageModuleId, string> = {
  home: "首页",
  simulator: "虚拟分光计",
  assistant: "互动课堂",
  analysis: "图像分析",
  records: "实验记录",
};

const ACTION_LABELS: Record<AuraUsageAction, string> = {
  assistant_opened: "打开 AURA 对话",
  auto_hint_shown: "显示页面提示",
  hint_opened: "通过提示打开 AURA",
  hint_navigation: "按提示跳转模块",
  question_answered_locally: "本地页面问答",
  question_answered_online: "在线 AI 问答",
  online_login_required: "请求在线问答但未登录",
  online_request_failed: "在线 AI 请求失败",
};

const PROMPT_LABELS: Record<AuraUsagePromptType, string> = {
  "next-step": "下一步建议",
  "button-help": "按钮说明",
  progress: "实验进度",
  page: "页面状态",
  "disabled-button": "按钮不可用原因",
  custom: "自定义问题",
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isModule(value: unknown): value is AuraUsageModuleId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MODULE_LABELS, value);
}

function isAction(value: unknown): value is AuraUsageAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ACTION_LABELS, value);
}

function isPromptType(value: unknown): value is AuraUsagePromptType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROMPT_LABELS, value);
}

function isEventMode(value: unknown): value is AuraUsageEventMode {
  return value === "local" || value === "online" || value === "unavailable";
}

function normalizeTimestamp(value: unknown) {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return new Date(0).toISOString();
}

function normalizeEvent(value: unknown): AuraUsageEvent | null {
  const event = objectValue(value);
  if (!isModule(event.module) || !isAction(event.action)) return null;
  const result: AuraUsageEvent = {
    at: normalizeTimestamp(event.at),
    module: event.module,
    action: event.action,
  };
  if (isPromptType(event.promptType)) result.promptType = event.promptType;
  if (isEventMode(event.mode)) result.mode = event.mode;
  if (isModule(event.targetModule)) result.targetModule = event.targetModule;
  return result;
}

function normalizeMode(value: unknown, events: AuraUsageEvent[]): AuraUsageMode | undefined {
  if (value === "mixed") return "mixed";
  const modes = new Set(events.map((event) => event.mode).filter((mode): mode is AuraUsageEventMode => Boolean(mode)));
  const hasLocal = modes.has("local") || (value === "local" && modes.size === 0);
  const hasOnline = modes.has("online") || (value === "online" && modes.size === 0);
  if (hasLocal && hasOnline) return "mixed";
  if (hasLocal) return "local";
  if (hasOnline) return "online";
  return undefined;
}

function mergeMode(current: AuraUsageMode | undefined, next?: AuraUsageEventMode): AuraUsageMode | undefined {
  if (next === "unavailable") return current;
  if (!next) return current;
  if (!current || current === next) return next;
  return "mixed";
}

export function emptyAuraUsage(): AuraUsage {
  return { version: 1, used: false, interactionCount: 0, events: [] };
}

export function normalizeAuraUsage(value: unknown): AuraUsage {
  const input = objectValue(value);
  const rawEvents = Array.isArray(input.events) ? input.events : [];
  const events = rawEvents.map(normalizeEvent).filter((event): event is AuraUsageEvent => Boolean(event)).slice(-MAX_AURA_USAGE_EVENTS);
  const interactionCount = typeof input.interactionCount === "number" && Number.isFinite(input.interactionCount)
    ? Math.max(events.length, Math.floor(input.interactionCount))
    : events.length;
  const used = input.used === true || interactionCount > 0 || events.length > 0;
  const firstUsedAt = typeof input.firstUsedAt === "string" && Number.isFinite(Date.parse(input.firstUsedAt)) ? new Date(input.firstUsedAt).toISOString() : events[0]?.at;
  const lastUsedAt = typeof input.lastUsedAt === "string" && Number.isFinite(Date.parse(input.lastUsedAt)) ? new Date(input.lastUsedAt).toISOString() : events.at(-1)?.at;
  const lastModule = isModule(input.lastModule) ? input.lastModule : events.at(-1)?.module;
  const lastPromptType = isPromptType(input.lastPromptType) ? input.lastPromptType : [...events].reverse().find((event) => event.promptType)?.promptType;
  const mode = normalizeMode(input.mode, events);
  const result: AuraUsage = { version: 1, used, interactionCount, events };
  if (firstUsedAt) result.firstUsedAt = firstUsedAt;
  if (lastUsedAt) result.lastUsedAt = lastUsedAt;
  if (lastModule) result.lastModule = lastModule;
  if (lastPromptType) result.lastPromptType = lastPromptType;
  if (mode) result.mode = mode;
  return result;
}

export function appendAuraUsageEvent(current: unknown, input: AuraUsageEventInput): AuraUsage {
  const previous = normalizeAuraUsage(current);
  const event = normalizeEvent({ ...input, at: input.at ?? new Date().toISOString() }) ?? {
    at: input.at ?? new Date().toISOString(),
    module: input.module,
    action: input.action,
  };
  const events = [...previous.events, event].slice(-MAX_AURA_USAGE_EVENTS);
  const result: AuraUsage = {
    version: 1,
    used: true,
    interactionCount: previous.interactionCount + 1,
    firstUsedAt: previous.firstUsedAt ?? event.at,
    lastUsedAt: event.at,
    lastModule: event.module,
    mode: mergeMode(previous.mode, event.mode),
    events,
  };
  const lastPromptType = event.promptType ?? previous.lastPromptType;
  if (lastPromptType) result.lastPromptType = lastPromptType;
  return result;
}

export function classifyAuraQuestion(value: string): AuraUsagePromptType {
  if (/点不了|不能点|禁用|不可用|灰/.test(value)) return "disabled-button";
  if (/下一步|接下来|先做什么|应该做什么|怎么做/.test(value)) return "next-step";
  if (/按钮|点击|什么意思/.test(value)) return "button-help";
  if (/进度|状态|完成到|现在到/.test(value)) return "progress";
  if (/页面|模块|这里|当前/.test(value)) return "page";
  return "custom";
}

export function auraUsageModuleLabel(module: AuraUsageModuleId | undefined) {
  return module ? MODULE_LABELS[module] : "未记录";
}

export function auraUsageActionLabel(action: AuraUsageAction) {
  return ACTION_LABELS[action];
}

export function auraUsagePromptLabel(promptType: AuraUsagePromptType | undefined) {
  return promptType ? PROMPT_LABELS[promptType] : "未记录";
}