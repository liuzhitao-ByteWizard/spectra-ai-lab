"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Bot, EyeOff, MapPin, Send, X } from "lucide-react";
import AssistantAnswer from "./AssistantAnswer";
import type { ExperimentJourney } from "@/lib/experiment-journey";

type Message = { role: "user" | "assistant"; text: string; source?: string };
type Pos = { x: number; y: number };

function FloatingAssistant({ journey, authenticated }: { journey: ExperimentJourney; authenticated: boolean }) {
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: "你好！我是 AURA，你的 AI 助教。我重点辅导分光计与光栅实验，也可以帮你理解课程知识、润色文字和分析编程问题。直接告诉我你现在遇到的困难吧！", source: "AURA · 物理实验与通用问答" },
  ]);
  const [sending, setSending] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const wasDragged = useRef(false);

  useEffect(() => {
    setPos({ x: window.innerWidth - 76, y: window.innerHeight - 76 });
  }, []);

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

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    wasDragged.current = false;
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    wasDragged.current = true;
    const nx = e.clientX - dragOffset.current.x;
    const ny = e.clientY - dragOffset.current.y;
    setPos({
      x: Math.max(8, Math.min(window.innerWidth - 60, nx)),
      y: Math.max(8, Math.min(window.innerHeight - 60, ny)),
    });
  }, [dragging]);

  const onPointerUp = useCallback(() => { setDragging(false); }, []);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const menuW = 150, menuH = 80;
    const x = Math.min(e.clientX, window.innerWidth - menuW - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
    setMenu({ x: Math.max(8, x), y: Math.max(8, y) });
  }, []);

  const handleBtnClick = useCallback(() => {
    if (wasDragged.current) { wasDragged.current = false; return; }
    setOpen(!open);
    setMenu(null);
  }, [open]);

  const resetPos = useCallback(() => {
    setPos({ x: window.innerWidth - 76, y: window.innerHeight - 76 });
    setMenu(null);
  }, []);

  const ask = useCallback(async (preset?: string) => {
    if (!authenticated) return;
    const value = (preset ?? question).trim();
    if (!value || sending) return;
    setMessages((items) => [...items, { role: "user", text: value }]);
    setQuestion("");
    setSending(true);
    const context = `当前实验状态：预习${journey.prelab.capturedLines >= 2 ? "已完成" : "未完成"}；照片${journey.capture.imageCount}张，曝光${journey.capture.exposureOk ? "通过" : "未通过"}，清晰度${journey.capture.sharpnessOk ? "通过" : "未通过"}；零级参考${journey.capture.zeroReferenceCaptured ? "已上传" : "未上传"}，φ₀${journey.capture.zeroReadingDeg ?? "未填写"}°；匹配参考线${journey.identification.matchedLines}条；反演${journey.inversion.reportable ? "可报告" : `被阻塞：${journey.inversion.blockReason}`}。助教只能解释，不能更改完成状态。`;
    try {
      const response = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: `${context}\n\n学生问题：${value}` }),
      });
      const data = await response.json() as { answer?: string; sources?: string[]; error?: string };
      if (!response.ok || !data.answer) throw new Error(data.error || "AURA 暂时不可用");
      setMessages((items) => [...items, { role: "assistant", text: data.answer!, source: data.sources?.[0] }]);
    } catch (error) {
      setMessages((items) => [...items, { role: "assistant", text: error instanceof Error ? error.message : "AURA 暂时不可用，请稍后重试。", source: "系统提示" }]);
    } finally {
      setSending(false);
    }
  }, [authenticated, journey, question, sending]);

  if (!pos) return null;

  if (hidden) {
    return (
      <button className="floating-restore-btn" onClick={() => setHidden(false)} aria-label="显示 AURA">
        <Bot size={16} />
      </button>
    );
  }

  const panelLeft = Math.min(pos.x, window.innerWidth - 372);
  const panelBottom = window.innerHeight - pos.y + 12;

  return (
    <>
      {open && (
        <div className="floating-chat-panel aura-panel" style={{ left: panelLeft, bottom: panelBottom, top: "auto", right: "auto" }}>
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
                <small>物理实验 · 通用问答</small>
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
            {sending && <div className="floating-msg assistant"><div className="floating-msg-bubble"><p>AURA 正在思考…</p></div></div>}
          </div>
          <form className="floating-chat-input" onSubmit={(e) => { e.preventDefault(); ask(); }}>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={authenticated ? "输入问题…" : "请先登录"}
              disabled={!authenticated}
            />
            <button type="submit" aria-label="发送" disabled={!authenticated || sending}><Send size={15} /></button>
          </form>
        </div>
      )}

      {menu && (
        <div className="floating-context-menu" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => { setHidden(true); setOpen(false); setMenu(null); }}>
            <EyeOff size={14} /> 隐藏 AURA
          </button>
          <button onClick={resetPos}>
            <MapPin size={14} /> 重置位置
          </button>
        </div>
      )}

      <button
        ref={btnRef}
        className={`floating-assistant-btn ${dragging ? "dragging" : ""}`}
        style={{ position: "fixed", left: pos.x, top: pos.y, bottom: "auto", right: "auto", touchAction: "none" }}
        onClick={handleBtnClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
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
            {/* outer glow */}
            <circle cx="32" cy="34" r="28" fill="url(#auraGlow)" />
            {/* water drop body — pointed top, round bottom */}
            <path d="M32 8 C32 8 18 24 18 36 C18 44.8 24.3 52 32 52 C39.7 52 46 44.8 46 36 C46 24 32 8 32 8Z" fill="url(#auraBody)" opacity=".92" />
            {/* inner jelly highlight */}
            <path d="M32 12 C32 12 22 25 22 36 C22 42.6 26.5 48 32 48 C37.5 48 42 42.6 42 36 C42 25 32 12 32 12Z" fill="url(#auraInner)" />
            {/* circuit line accent */}
            <path d="M26 38 Q28 34 32 36 Q36 38 38 34" stroke="#a5f3fc" strokeWidth=".7" fill="none" opacity=".5" strokeLinecap="round" />
            <path d="M28 42 Q30 40 34 42" stroke="#c4b5fd" strokeWidth=".6" fill="none" opacity=".4" strokeLinecap="round" />
            {/* star sparkle inside */}
            <circle cx="35" cy="40" r=".6" fill="#fff" opacity=".7" />
            <circle cx="28" cy="43" r=".4" fill="#fff" opacity=".5" />
            <circle cx="37" cy="33" r=".5" fill="#fff" opacity=".6" />
            {/* ring eyes */}
            <circle cx="26" cy="34" r="5" stroke="#fff" strokeWidth="2" fill="none" opacity=".95" />
            <circle cx="26" cy="34" r="1.8" fill="#fff" />
            <circle cx="38" cy="34" r="5" stroke="#fff" strokeWidth="2" fill="none" opacity=".95" />
            <circle cx="38" cy="34" r="1.8" fill="#fff" />
            {/* eye glow */}
            <circle cx="26" cy="34" r="7" fill="#22d3ee" opacity=".2" filter="url(#auraBlur)" />
            <circle cx="38" cy="34" r="7" fill="#22d3ee" opacity=".2" filter="url(#auraBlur)" />
            {/* tiny mouth */}
            <path d="M30 40 Q32 42 34 40" stroke="#fff" strokeWidth="1" fill="none" strokeLinecap="round" opacity=".7" />
            {/* stubby arms */}
            <ellipse cx="16" cy="40" rx="4" ry="6" fill="url(#auraBody)" opacity=".8" transform="rotate(-15 16 40)" />
            <ellipse cx="48" cy="40" rx="4" ry="6" fill="url(#auraBody)" opacity=".8" transform="rotate(15 48 40)" />
            {/* floating crystal accents */}
            <polygon points="52,12 54,16 52,18 50,16" fill="#c4b5fd" opacity=".7" />
            <polygon points="12,18 13.5,21 12,22.5 10.5,21" fill="#a5f3fc" opacity=".6" />
            {/* top shine */}
            <ellipse cx="28" cy="18" rx="3" ry="5" fill="#fff" opacity=".15" transform="rotate(-10 28 18)" />
          </svg>
        </span>
        <span className="floating-assistant-tip">AURA</span>
      </button>
    </>
  );
}

export default memo(FloatingAssistant);
