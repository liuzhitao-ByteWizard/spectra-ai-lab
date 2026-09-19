"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bot, EyeOff, Lightbulb, MapPin, Send, X } from "lucide-react";
import AssistantAnswer from "./AssistantAnswer";
import { classifyAuraQuestion, type AuraUsageEventInput } from "@/lib/aura-usage";
import type { ExperimentJourney } from "@/lib/experiment-journey";
import {
  captureAuraAction,
  collectAuraPageContext,
  formatAuraContextForModel,
  getAuraSuggestion,
  tryAnswerAuraLocally,
  type AuraInteractedAction,
  type AuraModuleId,
  type AuraPageContext,
  type AuraSuggestion,
} from "@/lib/aura-page-context";

type Message = { role: "user" | "assistant"; text: string; source?: string };
type Pos = { x: number; y: number };
type HintBubble = AuraSuggestion & { id: number };

const AUTO_HINT_DISABLED_KEY = "spectra-aura-auto-hints-disabled";
const AUTO_HINT_COUNT_KEY = "spectra-aura-auto-hint-count";
const MAX_AUTO_HINTS = 3;
const HINT_INTERVAL_MS = 15_000;
const HINT_IDLE_MS = 90_000;
const HINT_COOLDOWN_MS = 180_000;
const HINT_VISIBLE_MS = 8_000;

function readSessionBool(key: string) {
  try { return window.sessionStorage.getItem(key) === "1"; } catch { return false; }
}

function readSessionNumber(key: string) {
  try {
    const value = Number(window.sessionStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch { return 0; }
}

function writeSessionValue(key: string, value: string) {
  try { window.sessionStorage.setItem(key, value); } catch { /* Storage can be disabled. */ }
}

function FloatingAssistant({
  journey,
  authenticated,
  activeModule,
  localRecordCount,
  onNavigate,
  onAuraUsage,
}: {
  journey: ExperimentJourney;
  authenticated: boolean;
  activeModule: AuraModuleId;
  localRecordCount: number | null;
  onNavigate: (id: AuraModuleId) => void;
  onAuraUsage: (event: AuraUsageEventInput) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: "你好！我是 AURA，你的 AI 助教。我能读取当前页面上的模块、按钮和实验状态，可以帮你判断下一步、解释按钮含义，也能继续辅导分光计与光栅实验。", source: "AURA · 页面感知助教" },
  ]);
  const [sending, setSending] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hintBubble, setHintBubble] = useState<HintBubble | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragStart = useRef({ x: 0, y: 0 });
  const activePointerIdRef = useRef<number | null>(null);
  const wasDragged = useRef(false);
  const lastInteractedActionRef = useRef<AuraInteractedAction | null>(null);
  const lastActivityRef = useRef(Date.now());
  const lastHintAtRef = useRef(0);
  const hintCountRef = useRef(0);
  const hintDisabledRef = useRef(false);
  const hintBubbleVisibleRef = useRef(false);
  const bubbleTimerRef = useRef<number | null>(null);
  const suggestionRef = useRef<AuraSuggestion>({ text: "先选择页面上的主要操作按钮开始实验。" });

  const trackAuraUsage = useCallback((event: Omit<AuraUsageEventInput, "module">) => {
    onAuraUsage({ ...event, module: activeModule });
  }, [activeModule, onAuraUsage]);

  const buildContext = useCallback(() => collectAuraPageContext({
    module: activeModule,
    journey,
    localRecordCount,
    lastInteractedAction: lastInteractedActionRef.current,
  }), [activeModule, journey, localRecordCount]);

  useEffect(() => {
    setPos({ x: window.innerWidth - 76, y: window.innerHeight - 76 });
    hintDisabledRef.current = readSessionBool(AUTO_HINT_DISABLED_KEY);
    hintCountRef.current = readSessionNumber(AUTO_HINT_COUNT_KEY);
  }, []);

  useEffect(() => {
    const context = buildContext();
    suggestionRef.current = getAuraSuggestion(context);
  }, [buildContext]);

  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); };
  }, [menu]);

  useEffect(() => {
    let lastHoverCapture = 0;
    const markActivity = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".aura-hint-bubble, .floating-chat-panel, .floating-context-menu")) return;
      lastActivityRef.current = Date.now();
      hintBubbleVisibleRef.current = false;
      setHintBubble(null);
      if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
    };
    const capture = (event: Event) => {
      const action = captureAuraAction(event.target);
      if (action) lastInteractedActionRef.current = action;
    };
    const onPointerDown = (event: PointerEvent) => { markActivity(event); capture(event); };
    const onFocusIn = (event: FocusEvent) => { markActivity(event); capture(event); };
    const onPointerOver = (event: PointerEvent) => {
      const now = Date.now();
      if (now - lastHoverCapture < 180) return;
      lastHoverCapture = now;
      capture(event);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      markActivity(event);
      if (event.key === "Escape") {
        setHintBubble(null);
        setMenu(null);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("pointerover", onPointerOver, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("pointerover", onPointerOver, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  useEffect(() => {
    if (hintDisabledRef.current || hidden || open || sending) return;
    let disposed = false;
    let initialTimer = 0;
    let intervalTimer = 0;

    const showHint = (initial: boolean) => {
      if (disposed || hintDisabledRef.current || hintBubbleVisibleRef.current || open || hidden || sending) return;
      const now = Date.now();
      if (!initial && now - lastActivityRef.current < HINT_IDLE_MS) return;
      if (lastHintAtRef.current && now - lastHintAtRef.current < HINT_COOLDOWN_MS) return;
      if (hintCountRef.current >= MAX_AUTO_HINTS) return;
      const context = buildContext();
      const suggestion = getAuraSuggestion(context);
      suggestionRef.current = suggestion;
      hintCountRef.current += 1;
      lastHintAtRef.current = now;
      hintBubbleVisibleRef.current = true;
      writeSessionValue(AUTO_HINT_COUNT_KEY, String(hintCountRef.current));
      trackAuraUsage({ action: "auto_hint_shown" });
      setHintBubble({ ...suggestion, id: now });
      if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = window.setTimeout(() => {
        hintBubbleVisibleRef.current = false;
        setHintBubble(null);
      }, HINT_VISIBLE_MS);
    };

    initialTimer = window.setTimeout(() => showHint(true), 10_000);
    intervalTimer = window.setInterval(() => showHint(false), HINT_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalTimer);
    };
  }, [buildContext, hidden, open, sending, trackAuraUsage]);

  useEffect(() => () => {
    if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
  }, []);

  const appendPageContextMessage = useCallback((context: AuraPageContext, overrideText?: string) => {
    const suggestion = getAuraSuggestion(context);
    suggestionRef.current = suggestion;
    const text = overrideText
      ? `我已经读取当前页面。${overrideText}`
      : `我现在看到你在「${context.moduleLabel}」。${suggestion.text}`;
    setMessages((items) => [
      ...items.filter((message) => message.source !== "AURA · 当前页面"),
      { role: "assistant", text, source: "AURA · 当前页面" },
    ]);
  }, []);

  const openAssistant = useCallback((overrideText?: string, source: "button" | "hint" = "button") => {
    const context = buildContext();
    trackAuraUsage({ action: source === "hint" ? "hint_opened" : "assistant_opened" });
    appendPageContextMessage(context, overrideText);
    lastActivityRef.current = Date.now();
    hintBubbleVisibleRef.current = false;
    setHintBubble(null);
    setOpen(true);
    setMenu(null);
  }, [appendPageContextMessage, buildContext, trackAuraUsage]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || activePointerIdRef.current !== null) return;
    const button = btnRef.current;
    const rect = button?.getBoundingClientRect();
    if (!button || !rect) return;
    activePointerIdRef.current = e.pointerId;
    wasDragged.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    button.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    if (e.pointerType === "mouse" && (e.buttons & 1) !== 1) {
      activePointerIdRef.current = null;
      setDragging(false);
      return;
    }
    if (!wasDragged.current) {
      const distance = Math.hypot(e.clientX - dragStart.current.x, e.clientY - dragStart.current.y);
      if (distance < 5) return;
      wasDragged.current = true;
      setDragging(true);
    }
    const nx = e.clientX - dragOffset.current.x;
    const ny = e.clientY - dragOffset.current.y;
    setPos({
      x: Math.max(8, Math.min(window.innerWidth - 60, nx)),
      y: Math.max(8, Math.min(window.innerHeight - 60, ny)),
    });
  }, []);

  const clearPointerDrag = useCallback((pointerId?: number) => {
    if (pointerId !== undefined && activePointerIdRef.current !== pointerId) return;
    activePointerIdRef.current = null;
    setDragging(false);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const button = btnRef.current;
    if (button?.hasPointerCapture(e.pointerId)) button.releasePointerCapture(e.pointerId);
    clearPointerDrag(e.pointerId);
  }, [clearPointerDrag]);

  const onPointerCancel = useCallback((e: React.PointerEvent) => {
    clearPointerDrag(e.pointerId);
  }, [clearPointerDrag]);

  const onLostPointerCapture = useCallback((e: React.PointerEvent) => {
    clearPointerDrag(e.pointerId);
  }, [clearPointerDrag]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const menuW = 150, menuH = 80;
    const x = Math.min(e.clientX, window.innerWidth - menuW - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
    setMenu({ x: Math.max(8, x), y: Math.max(8, y) });
  }, []);

  const handleBtnClick = useCallback(() => {
    if (wasDragged.current) { wasDragged.current = false; return; }
    if (open) setOpen(false);
    else openAssistant();
  }, [open, openAssistant]);

  const resetPos = useCallback(() => {
    setPos({ x: window.innerWidth - 76, y: window.innerHeight - 76 });
    setMenu(null);
  }, []);

  const dismissAutoHints = useCallback(() => {
    hintDisabledRef.current = true;
    hintBubbleVisibleRef.current = false;
    writeSessionValue(AUTO_HINT_DISABLED_KEY, "1");
    setHintBubble(null);
  }, []);

  const ask = useCallback(async (preset?: string) => {
    const value = (preset ?? question).trim();
    if (!value || sending) return;
    const context = buildContext();
    const localAnswer = tryAnswerAuraLocally(value, context);
    const promptType = classifyAuraQuestion(value);
    setMessages((items) => [...items, { role: "user", text: value }]);
    setQuestion("");
    lastActivityRef.current = Date.now();
    if (localAnswer) {
      trackAuraUsage({ action: "question_answered_locally", mode: "local", promptType });
      setMessages((items) => [...items, { role: "assistant", text: localAnswer, source: "AURA · 当前页面" }]);
      return;
    }
    if (!authenticated) {
      trackAuraUsage({ action: "online_login_required", mode: "unavailable", promptType });
      setMessages((items) => [...items, {
        role: "assistant",
        text: "这个问题需要连接在线 AI 后才能深入回答。我现在可以先解释当前按钮、页面状态和下一步；你可以试着问“下一步做什么”或“这个按钮是什么意思”。",
        source: "AURA · 本地页面助教",
      }]);
      return;
    }

    setSending(true);
    const serialized = formatAuraContextForModel(context).slice(0, 2500);
    const safeQuestion = value.slice(0, Math.max(200, 3900 - serialized.length));
    try {
      const response = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: `${serialized}\n\n学生问题：${safeQuestion}` }),
      });
      const data = await response.json() as { answer?: string; sources?: string[]; error?: string };
      if (!response.ok || !data.answer) throw new Error(data.error || "AURA 暂时不可用");
      trackAuraUsage({ action: "question_answered_online", mode: "online", promptType });
      setMessages((items) => [...items, { role: "assistant", text: data.answer!, source: data.sources?.[0] }]);
    } catch (error) {
      trackAuraUsage({ action: "online_request_failed", mode: "online", promptType });
      setMessages((items) => [...items, { role: "assistant", text: error instanceof Error ? error.message : "AURA 暂时不可用，请稍后重试。", source: "系统提示" }]);
    } finally {
      setSending(false);
    }
  }, [authenticated, buildContext, question, sending, trackAuraUsage]);

  if (!pos) return null;

  if (hidden) {
    return (
      <button className="floating-restore-btn" data-aura-root onClick={() => { setHidden(false); lastActivityRef.current = Date.now(); }} aria-label="显示 AURA">
        <Bot size={16} />
      </button>
    );
  }

  const panelLeft = Math.min(pos.x, window.innerWidth - 372);
  const panelBottom = window.innerHeight - pos.y + 12;
  const bubbleRight = Math.max(12, window.innerWidth - pos.x + 10);
  const bubbleBottom = Math.max(80, window.innerHeight - pos.y + 12);
  const currentModuleLabel = collectAuraPageContext({ module: activeModule, journey, localRecordCount, lastInteractedAction: null }).moduleLabel;

  return (
    <>
      {hintBubble && !open && (
        <div className="aura-hint-bubble" data-aura-root style={{ right: bubbleRight, bottom: bubbleBottom }}>
          <button className="aura-hint-close" onClick={() => setHintBubble(null)} aria-label="关闭提示"><X size={14} /></button>
          <p className="aura-hint-kicker"><Lightbulb size={14} />AURA · 当前页面提示</p>
          <p className="aura-hint-text">{hintBubble.text}</p>
          <div className="aura-hint-actions">
            <button className="aura-hint-primary" onClick={() => openAssistant(hintBubble.text, "hint")}>问问 AURA <ArrowRight size={14} /></button>
            {hintBubble.target && hintBubble.target !== activeModule && (
              <button onClick={() => { trackAuraUsage({ action: "hint_navigation", targetModule: hintBubble.target }); onNavigate(hintBubble.target!); setHintBubble(null); }}>{hintBubble.actionLabel ?? "带我去"}</button>
            )}
          </div>
          <button className="aura-hint-mute" onClick={dismissAutoHints}>本会话不再自动提示</button>
        </div>
      )}

      {open && (
        <div className="floating-chat-panel aura-panel" data-aura-root style={{ left: panelLeft, bottom: panelBottom, top: "auto", right: "auto" }}>
          <div className="floating-chat-header aura-header">
            <div className="floating-chat-title">
              <span className="floating-chat-avatar-sm aura-avatar-sm">
                <svg viewBox="0 0 48 48" width="20" height="20" fill="none">
                  <ellipse cx="24" cy="28" rx="13" ry="15" fill="url(#auraSm)" />
                  <circle cx="19" cy="26" r="3.5" stroke="#fff" strokeWidth="1.8" fill="none" />
                  <circle cx="19" cy="26" r="1.2" fill="#fff" />
                  <circle cx="29" cy="26" r="3.5" stroke="#fff" strokeWidth="1.8" fill="none" />
                  <circle cx="29" cy="26" r="1.2" fill="#fff" />
                  <defs><linearGradient id="auraSm" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#22D3EE"/><stop offset="1" stopColor="#8B5CF6"/></linearGradient></defs>
                </svg>
              </span>
              <div>
                <strong>AURA AI 助教</strong>
                <small>{currentModuleLabel} · 页面感知</small>
              </div>
            </div>
            <button className="floating-chat-close" onClick={() => setOpen(false)} aria-label="关闭聊天"><X size={16} /></button>
          </div>
          <div className="floating-chat-messages" ref={messagesRef}>
            {messages.map((message, index) => (
              <div key={index} className={`floating-msg ${message.role}`}>
                <div className="floating-msg-bubble">
                  {message.role === "assistant" ? <AssistantAnswer>{message.text}</AssistantAnswer> : <p>{message.text}</p>}
                  {message.source && <small>{message.source}</small>}
                </div>
              </div>
            ))}
            {sending && <div className="floating-msg assistant"><div className="floating-msg-bubble"><p>AURA 正在结合当前页面思考…</p></div></div>}
          </div>
          <div className="aura-quick-prompts" aria-label="快捷提问">
            <button onClick={() => void ask("下一步做什么？")}>下一步做什么</button>
            <button onClick={() => void ask("这个按钮是什么意思？")}>解释当前按钮</button>
            <button onClick={() => void ask("现在实验进度如何？")}>检查实验状态</button>
          </div>
          <form className="floating-chat-input" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
            <input
              value={question}
              maxLength={1200}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={authenticated ? "询问当前页面或实验问题…" : "问页面、按钮或下一步…"}
            />
            <button type="submit" aria-label="发送" disabled={!question.trim() || sending}><Send size={15} /></button>
          </form>
        </div>
      )}

      {menu && (
        <div className="floating-context-menu" data-aura-root style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => { setHidden(true); setOpen(false); setMenu(null); setHintBubble(null); }}>
            <EyeOff size={14} /> 隐藏 AURA
          </button>
          <button onClick={resetPos}>
            <MapPin size={14} /> 重置位置
          </button>
        </div>
      )}

      <button
        ref={btnRef}
        data-aura-root
        className={`floating-assistant-btn ${dragging ? "dragging" : ""}`}
        style={{ position: "fixed", left: pos.x, top: pos.y, bottom: "auto", right: "auto", touchAction: "none" }}
        onClick={handleBtnClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onLostPointerCapture}
        onContextMenu={onContextMenu}
        aria-label={open ? "关闭 AURA" : "打开 AURA"}
      >
        <span className="floating-assistant-face aura-face" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="40" height="40" fill="none">
            <defs>
              <radialGradient id="auraBody" cx="45%" cy="40%" r="50%">
                <stop offset="0%" stopColor="#67e8f9" />
                <stop offset="45%" stopColor="#22d3ee" />
                <stop offset="100%" stopColor="#8b5cf6" />
              </radialGradient>
              <radialGradient id="auraGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#22d3ee" stopOpacity=".35" />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="auraInner" cx="50%" cy="45%" r="40%">
                <stop offset="0%" stopColor="#a5f3fc" stopOpacity=".3" />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity=".1" />
              </radialGradient>
              <filter id="auraBlur"><feGaussianBlur stdDeviation="1.2"/></filter>
            </defs>
            <circle cx="32" cy="34" r="28" fill="url(#auraGlow)" />
            <path d="M32 8 C32 8 18 24 18 36 C18 44.8 24.3 52 32 52 C39.7 52 46 44.8 46 36 C46 24 32 8 32 8Z" fill="url(#auraBody)" opacity=".92" />
            <path d="M32 12 C32 12 22 25 22 36 C22 42.6 26.5 48 32 48 C37.5 48 42 42.6 42 36 C42 25 32 12 32 12Z" fill="url(#auraInner)" />
            <path d="M26 38 Q28 34 32 36 Q36 38 38 34" stroke="#a5f3fc" strokeWidth=".7" fill="none" opacity=".5" strokeLinecap="round" />
            <path d="M28 42 Q30 40 34 42" stroke="#c4b5fd" strokeWidth=".6" fill="none" opacity=".4" strokeLinecap="round" />
            <circle cx="35" cy="40" r=".6" fill="#fff" opacity=".7" />
            <circle cx="28" cy="43" r=".4" fill="#fff" opacity=".5" />
            <circle cx="37" cy="33" r=".5" fill="#fff" opacity=".6" />
            <circle cx="26" cy="34" r="5" stroke="#fff" strokeWidth="2" fill="none" opacity=".95" />
            <circle cx="26" cy="34" r="1.8" fill="#fff" />
            <circle cx="38" cy="34" r="5" stroke="#fff" strokeWidth="2" fill="none" opacity=".95" />
            <circle cx="38" cy="34" r="1.8" fill="#fff" />
            <circle cx="26" cy="34" r="7" fill="#22d3ee" opacity=".2" filter="url(#auraBlur)" />
            <circle cx="38" cy="34" r="7" fill="#22d3ee" opacity=".2" filter="url(#auraBlur)" />
            <path d="M30 40 Q32 42 34 40" stroke="#fff" strokeWidth="1" fill="none" strokeLinecap="round" opacity=".7" />
            <ellipse cx="16" cy="40" rx="4" ry="6" fill="url(#auraBody)" opacity=".8" transform="rotate(-15 16 40)" />
            <ellipse cx="48" cy="40" rx="4" ry="6" fill="url(#auraBody)" opacity=".8" transform="rotate(15 48 40)" />
            <polygon points="52,12 54,16 52,18 50,16" fill="#c4b5fd" opacity=".7" />
            <polygon points="12,18 13.5,21 12,22.5 10.5,21" fill="#a5f3fc" opacity=".6" />
            <ellipse cx="28" cy="18" rx="3" ry="5" fill="#fff" opacity=".15" transform="rotate(-10 28 18)" />
          </svg>
        </span>
        <span className="floating-assistant-tip">AURA</span>
      </button>
    </>
  );
}

export default memo(FloatingAssistant);
