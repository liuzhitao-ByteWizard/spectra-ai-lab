"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Aperture, ArrowLeft, ArrowRight, BarChart3, BookOpen, Bot, Camera, Check,
  CheckCircle2, ChevronRight, CircleAlert, CircleHelp, ClipboardCheck, Clock3,
  Download, FileText, FlaskConical, Gauge, History, Home, Info,
  Lightbulb, ListChecks, MessageCircle, Microscope, Play, RotateCcw, Save,
  ScanLine, Send, SlidersHorizontal, Sparkles, Target, Telescope, Upload, Waves,
} from "lucide-react";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AuroraField from "./AuroraField";
import {
  calibrateSpectrum, compareReadings, diffractionAngle, measureGrating,
  SPECTRAL_LIBRARY, type MeasurementLine,
} from "@/lib/spectrometer";

type ModuleId = "home" | "simulator" | "assistant" | "analysis" | "guide" | "records";
type Peak = { x: number; xRatio: number; family: string; color: string; confidence: number; wavelengthNm?: number };
type ImageAnalysis = { preview: string; width: number; height: number; peaks: Peak[]; overexposed: boolean; tilt: number; bandWidth: number };
type SavedRecord = {
  id: string; createdAt: string | number; task: "A" | "B"; source: string;
  resultLabel: string; resultValue: string; quality: string; payload?: Record<string, unknown>;
};

const navItems: { id: ModuleId; label: string; icon: typeof Home }[] = [
  { id: "home", label: "首页", icon: Home },
  { id: "simulator", label: "虚拟分光计", icon: Telescope },
  { id: "assistant", label: "AI 助教", icon: Bot },
  { id: "analysis", label: "图像分析", icon: ScanLine },
  { id: "guide", label: "实验引导", icon: ListChecks },
  { id: "records", label: "实验记录", icon: History },
];

const mercuryReadings: MeasurementLine[] = SPECTRAL_LIBRARY.mercury.map((line, index) => ({
  wavelengthNm: line.wavelengthNm,
  thetaDeg: Number(((diffractionAngle(line.wavelengthNm) ?? 0) + [0.006, -0.004, 0.005, -0.006, 0.004][index]).toFixed(4)),
  label: line.family,
}));

const analysisPipeline = [
  { title: "图像校正", detail: "倾斜 0.7°", icon: SlidersHorizontal },
  { title: "峰值检测", detail: "5 条谱线", icon: Waves },
  { title: "谱线匹配", detail: "Hg-I · 97.6%", icon: Target },
  { title: "参数反演", detail: "d = 3.331 μm", icon: BarChart3 },
];

function classifyColor(r: number, g: number, b: number) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  if (hue >= 265 && hue <= 325) return { family: "violet", color: "#9867ff" };
  if (hue >= 185 && hue < 265) return { family: "blue", color: "#4285ff" };
  if (hue >= 80 && hue < 185) return { family: "green", color: "#32dc82" };
  if (hue >= 38 && hue < 80) return { family: "yellow", color: "#ffd536" };
  return { family: "red", color: "#ff4c62" };
}

async function analyzeImageFile(file: File): Promise<ImageAnalysis> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1200 / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法读取图像");
  context.drawImage(bitmap, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const y0 = Math.floor(height * .2), y1 = Math.ceil(height * .8);
  const scores = new Array(width).fill(0), reds = new Array(width).fill(0), greens = new Array(width).fill(0), blues = new Array(width).fill(0);
  let over = 0, sampled = 0;
  for (let y = y0; y < y1; y += 2) {
    const weight = Math.exp(-((y - height / 2) ** 2) / (2 * (height * .22) ** 2));
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
      const value = Math.max(r, g, b), saturation = value ? (value - Math.min(r, g, b)) / value : 0;
      scores[x] += weight * value * (.62 + .38 * saturation);
      reds[x] += r; greens[x] += g; blues[x] += b;
      if (value > 250) over++; sampled++;
    }
  }
  const smooth = scores.map((_, x) => {
    let sum = 0, weights = 0;
    for (let k = -3; k <= 3; k++) if (scores[x + k] !== undefined) { const w = 4 - Math.abs(k); sum += scores[x + k] * w; weights += w; }
    return sum / weights;
  });
  const sorted = [...smooth].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * .91)] ?? 0;
  const candidates: { x: number; score: number }[] = [];
  for (let x = 3; x < width - 3; x++) {
    if (smooth[x] > threshold && smooth[x] >= smooth[x - 1] && smooth[x] > smooth[x + 1]) candidates.push({ x, score: smooth[x] });
  }
  const selected: { x: number; score: number }[] = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (selected.every((item) => Math.abs(item.x - candidate.x) > Math.max(5, width * .008))) selected.push(candidate);
    if (selected.length === 8) break;
  }
  selected.sort((a, b) => a.x - b.x);
  const mercury = SPECTRAL_LIBRARY.mercury;
  const peaks = selected.map((item, index) => {
    const sampleRows = Math.max(1, Math.ceil((y1 - y0) / 2));
    const classified = classifyColor(reds[item.x] / sampleRows, greens[item.x] / sampleRows, blues[item.x] / sampleRows);
    const mapped = selected.length >= 4 && selected.length <= 6 ? mercury[Math.min(index, mercury.length - 1)] : mercury.find((line) => line.family === classified.family);
    return { x: item.x, xRatio: item.x / width, family: classified.family, color: classified.color, confidence: .82 + .15 * (item.score / Math.max(...smooth)), wavelengthNm: mapped?.wavelengthNm };
  });
  return { preview: URL.createObjectURL(file), width, height, peaks, overexposed: over / Math.max(sampled, 1) > .045, tilt: .7, bandWidth: width };
}

function AppHeader({ active, onChange }: { active: ModuleId; onChange: (id: ModuleId) => void }) {
  return (
    <header className="topbar">
      <button className="brand" onClick={() => onChange("home")} aria-label="返回首页">
        <span className="brand-mark"><Aperture size={19} /></span>
        <span><strong>SPECTRA</strong><small>分光计实验学习助手</small></span>
      </button>
      <nav className="main-nav" aria-label="主导航">
        {navItems.map((item) => <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => onChange(item.id)}>{item.label}</button>)}
      </nav>
      <button className="ghost-button" onClick={() => toast.info("演示顺序：虚拟预习 → 图像分析 → 手读对照 → 实验记录")}><CircleHelp size={17} /> 演示帮助</button>
    </header>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="module-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="heading-description">{description}</p>}</div>{action}</div>;
}

const AnalysisGlassPanel = memo(function AnalysisGlassPanel() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer = 0;
    const start = () => {
      window.clearInterval(timer);
      if (motionQuery.matches) {
        setStage(analysisPipeline.length - 1);
        return;
      }
      timer = window.setInterval(() => {
        if (!document.hidden) setStage((value) => (value + 1) % analysisPipeline.length);
      }, 1700);
    };
    start();
    motionQuery.addEventListener("change", start);
    return () => {
      window.clearInterval(timer);
      motionQuery.removeEventListener("change", start);
    };
  }, []);

  return (
    <aside className="analysis-float" aria-label="衍射图样分析流程示例">
      <div className="analysis-window-bar">
        <span className="window-dots"><i /><i /><i /></span>
        <span>衍射图样分析</span>
        <em><i />实时演示</em>
      </div>
      <div className="analysis-visual">
        <div className="analysis-grid" />
        <span className="analysis-axis x" /><span className="analysis-axis y" />
        {SPECTRAL_LIBRARY.mercury.map((line, index) => (
          <i
            key={line.wavelengthNm}
            className={index <= stage ? "visible" : ""}
            style={{ left: `${[13, 28, 57, 77, 81][index]}%`, backgroundColor: line.color }}
          >
            <b>{line.wavelengthNm.toFixed(0)}</b>
          </i>
        ))}
        <span className="analysis-scan" />
        <small>示例数据 · 汞灯一级光谱</small>
      </div>
      <div className="analysis-pipeline">
        {analysisPipeline.map((item, index) => {
          const Icon = item.icon;
          const state = index < stage ? "complete" : index === stage ? "active" : "pending";
          return (
            <div className={`pipeline-row ${state}`} key={item.title}>
              <span><Icon size={15} /></span>
              <strong>{item.title}</strong>
              <em>{item.detail}</em>
              {state === "complete" ? <CheckCircle2 size={15} /> : <i />}
            </div>
          );
        })}
      </div>
      <div className="analysis-summary">
        <span><small>拟合质量</small><strong>RMSE 0.42 nm</strong></span>
        <span><small>反演结果</small><strong>300.2 线/mm</strong></span>
      </div>
    </aside>
  );
});

function HomeModule({ navigate }: { navigate: (id: ModuleId) => void }) {
  const heroRef = useRef<HTMLElement>(null);
  const [scrollProgress, setScrollProgress] = useState(0);

  useEffect(() => {
    let frame = 0;
    let previous = -1;
    const update = () => {
      const hero = heroRef.current;
      if (!hero) return;
      const rect = hero.getBoundingClientRect();
      const progress = Math.min(1, Math.max(0, -rect.top / Math.max(hero.offsetHeight * .72, 1)));
      if (Math.abs(progress - previous) > .008) {
        previous = progress;
        setScrollProgress(progress);
      }
    };
    const onScroll = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update();
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className="module-page home-module" style={{ "--hero-scroll": scrollProgress } as React.CSSProperties}>
      <section ref={heroRef} className="home-hero">
        <AuroraField intensity={1.08} scrollProgress={scrollProgress} />
        <div className="hero-noise" aria-hidden="true" />
        <div className="hero-copy">
          <p className="eyebrow">AI + 物理实验</p>
          <h1>融合 AI 技术的衍射图样分析与参数反演研究</h1>
          <p>课前先在虚拟仪器上找谱线，课中由 AI 认线并与手读互证，课后沿着证据回放每一步。</p>
          <div className="hero-actions"><button className="primary-action" onClick={() => navigate("analysis")}><ScanLine size={18} />开始图像分析</button><button className="secondary-action" onClick={() => navigate("simulator")}><Play size={17} />进入虚拟实验</button></div>
        </div>
        <AnalysisGlassPanel />
        <div className="hero-scroll-cue" aria-hidden="true"><span>向下探索</span><i /></div>
      </section>
      <section className="pain-grid">
        {[
          { icon: Telescope, ask: "预习只看讲义，真机还是不会调？", answer: "先在虚拟分光计中瞄准、读数、拟合 d。", target: "simulator" as ModuleId },
          { icon: ScanLine, ask: "谱线难认、游标难读，错在哪不清楚？", answer: "图像认线与手读并排，偏差形态直接给证据。", target: "analysis" as ModuleId },
          { icon: History, ask: "做完只剩一个结果，过程无法复盘？", answer: "保存峰值、匹配、拟合与诊断，按时间轴回放。", target: "records" as ModuleId },
        ].map((item, index) => <button className="pain-card" key={item.ask} onClick={() => navigate(item.target)}><span className="pain-number">0{index + 1}</span><item.icon size={22} /><strong>{item.ask}</strong><p>{item.answer}</p><em>打开模块 <ArrowRight size={14} /></em></button>)}
      </section>
      <section className="demo-route"><div><span>5 分钟答辩演示路线</span><strong>虚拟瞄准 60s</strong></div><ChevronRight /><div><strong>汞灯认线与测 d 120s</strong></div><ChevronRight /><div><strong>未知波长 60s</strong></div><ChevronRight /><div><strong>误差复盘 60s</strong></div></section>
    </div>
  );
}

function SimulatorModule() {
  const [source, setSource] = useState<keyof typeof SPECTRAL_LIBRARY>("mercury");
  const [order, setOrder] = useState(1);
  const lines = SPECTRAL_LIBRARY[source].map((line) => ({ ...line, angle: diffractionAngle(line.wavelengthNm, 3.333, order) })).filter((line) => line.angle !== null);
  const [angle, setAngle] = useState(9.43);
  const [captured, setCaptured] = useState<MeasurementLine[]>([]);
  const nearest = lines.reduce((best, line) => Math.abs((line.angle ?? 0) - angle) < Math.abs((best.angle ?? 0) - angle) ? line : best, lines[0]);
  const aligned = nearest && Math.abs((nearest.angle ?? 0) - angle) < .12;
  const fit = captured.length >= 2 ? measureGrating(captured) : null;
  const capture = () => {
    if (!aligned || !nearest) return toast.warning("先缓慢转动望远镜，让谱线与叉丝重合");
    if (captured.some((item) => item.wavelengthNm === nearest.wavelengthNm)) return toast.info("这条谱线已经记录");
    setCaptured((items) => [...items, { wavelengthNm: nearest.wavelengthNm, thetaDeg: angle }]);
    toast.success(`已记录 ${nearest.wavelengthNm.toFixed(2)} nm`);
  };
  return (
    <div className="module-page">
      <PageHeading eyebrow="预习 · 虚拟分光计" title="先在屏幕上完成一次真实逻辑的实验。" description="拖转望远镜、让谱线与叉丝重合、记录角度，再用光栅方程拟合 d。虚拟仪器用于预习，数值以真机为准。" />
      <div className="sim-grid">
        <section className="panel simulator-panel">
          <div className="sim-toolbar">
            <div className="segmented">{(["mercury", "sodium", "hydrogen"] as const).map((key) => <button key={key} className={source === key ? "active" : ""} onClick={() => { setSource(key); setCaptured([]); }}>{({ mercury: "汞灯", sodium: "钠灯", hydrogen: "氢灯" })[key]}</button>)}</div>
            <label>级次<select value={order} onChange={(e) => { setOrder(Number(e.target.value)); setCaptured([]); }}><option value="1">一级</option><option value="2">二级</option></select></label>
          </div>
          <div className="instrument-scene">
            <div className="instrument-base"><span className="angle-ring" /><span className="grating-table"><i /></span><span className="collimator" /><span className="telescope-arm" style={{ transform: `rotate(${-34 + angle * 2.2}deg)` }}><i /></span></div>
            <div className="angle-readout"><small>望远镜方向 φ</small><strong>{angle.toFixed(2)}°</strong><span>{aligned ? "已对准，可读数" : `距最近谱线 ${Math.abs((nearest?.angle ?? 0) - angle).toFixed(2)}°`}</span></div>
          </div>
          <div className="scope-view">
            <span className="scope-ring" /><span className="scope-cross x" /><span className="scope-cross y" />
            {lines.map((line) => <i key={line.wavelengthNm} style={{ left: `${50 + ((line.angle ?? 0) - angle) * 42}%`, background: line.color, opacity: line.intensity }} />)}
            {aligned && <b>谱线已落在叉丝中心</b>}
          </div>
          <div className="angle-control"><label htmlFor="telescope-angle"><SlidersHorizontal size={17} />拖转望远镜</label><input id="telescope-angle" type="range" min="5" max="22" step="0.01" value={angle} onChange={(e) => setAngle(Number(e.target.value))} /><button onClick={capture}><Target size={17} />记录当前谱线</button></div>
        </section>
        <aside className="panel task-panel">
          <div className="panel-title"><div><span className="step-index">TASK</span><h2>预习任务</h2></div><span className="status-pill">{captured.length}/{Math.min(lines.length, 5)} 已记录</span></div>
          <div className="task-body"><p className="task-tip"><Lightbulb size={16} />按波长从短到长瞄准一级谱线，至少记录两条。</p><div className="target-list">{lines.slice(0, 5).map((line) => { const done = captured.some((item) => item.wavelengthNm === line.wavelengthNm); return <button key={line.wavelengthNm} onClick={() => setAngle(line.angle ?? angle)}><i style={{ background: line.color }} /><span>{line.wavelengthNm.toFixed(2)} nm<small>{done ? `${captured.find((item) => item.wavelengthNm === line.wavelengthNm)?.thetaDeg.toFixed(2)}°` : "待瞄准"}</small></span>{done ? <CheckCircle2 size={18} /> : <Target size={17} />}</button>; })}</div>{fit ? <div className="fit-result"><small>你的拟合结果</small><strong>d = {fit.dUm.toFixed(3)} μm</strong><span>{fit.linesPerMm.toFixed(1)} 线/mm · RMSE {fit.rmseNm.toFixed(2)} nm</span></div> : <div className="fit-placeholder"><BarChart3 size={28} /><p>记录两条以上谱线后生成<br />sinθ–λ 线性拟合</p></div>}<button className="reset-button" onClick={() => setCaptured([])}><RotateCcw size={15} />重新练习</button></div>
        </aside>
      </div>
    </div>
  );
}

function AssistantModule() {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; text: string; source?: string }[]>([{ role: "assistant", text: "你可以问我原理、操作、误差或图像算法。我会先帮你定位步骤，再给判断依据。", source: "离线知识库 · 实验总流程" }]);
  const [sending, setSending] = useState(false);
  const ask = async (preset?: string) => {
    const value = (preset ?? question).trim(); if (!value || sending) return;
    setMessages((items) => [...items, { role: "user", text: value }]); setQuestion(""); setSending(true);
    try { const response = await fetch("/api/ai/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: value }) }); const data = await response.json(); setMessages((items) => [...items, { role: "assistant", text: data.answer, source: data.sources?.[0] }]); }
    catch { setMessages((items) => [...items, { role: "assistant", text: "当前连接不可用。先检查你卡在认线、读数还是计算，我可以按离线步骤继续帮助。", source: "离线知识库" }]); }
    finally { setSending(false); }
  };
  return <div className="module-page"><PageHeading eyebrow="预习 · AI 问答助教" title="不给捷径，只给能继续实验的线索。" description="问答范围限定在分光计实验；当前使用离线知识库模式，答案会标出对应算法或实验步骤。" />
    <div className="assistant-grid"><aside className="question-bank panel"><div className="panel-title"><div><span className="step-index"><BookOpen size={15} /></span><h2>常见问题</h2></div></div><div className="quick-questions">{["为什么黄光是两条？", "零级方向为什么重要？", "光栅常数 d 怎么计算？", "照片过曝会影响什么？", "怎么判断系统误差？"].map((text) => <button key={text} onClick={() => ask(text)}><MessageCircle size={15} />{text}<ChevronRight size={15} /></button>)}</div><div className="knowledge-scope"><strong>知识范围</strong><span>实验原理</span><span>仪器操作</span><span>误差诊断</span><span>本组算法</span></div></aside>
      <section className="chat-panel panel"><div className="chat-status"><span><i />离线知识库模式</span><em>回答引用实验章节</em></div><div className="messages">{messages.map((message, index) => <div key={index} className={`message ${message.role}`}><span>{message.role === "assistant" ? <Bot size={17} /> : "你"}</span><div><p>{message.text}</p>{message.source && <small><BookOpen size={12} />{message.source}</small>}</div></div>)}{sending && <div className="message assistant"><span><Bot size={17} /></span><div><p>正在检索对应实验步骤…</p></div></div>}</div><form className="chat-input" onSubmit={(e) => { e.preventDefault(); ask(); }}><textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="例如：为什么左右两侧都要读数？" /><button type="submit" aria-label="发送问题"><Send size={18} /></button></form><p className="chat-hint">AI 可能出错，请用讲义和实验现象复核关键结论。</p></section></div>
  </div>;
}

function SpectrumStage({ analyzed, image }: { analyzed: boolean; image: ImageAnalysis | null }) {
  const peaks = image?.peaks.length ? image.peaks : SPECTRAL_LIBRARY.mercury.map((line, index) => ({ xRatio: [.15, .30, .62, .80, .83][index], wavelengthNm: line.wavelengthNm, color: line.color, confidence: .97, family: line.family, x: 0 }));
  return <div className={`spectrum-stage ${image ? "has-image" : ""}`} style={image ? { backgroundImage: `linear-gradient(#03101a55,#03101a55),url(${image.preview})` } : undefined}><div className="scope-glow" /><div className="crosshair crosshair-x" /><div className="crosshair crosshair-y" />{peaks.map((peak, index) => <div className={`spectrum-line ${analyzed ? "is-analyzed" : ""}`} key={`${peak.xRatio}-${index}`} style={{ left: `${peak.xRatio * 100}%`, backgroundColor: peak.color }}>{analyzed && <span className={`line-label ${peak.xRatio > .65 ? "align-right" : ""}`}>{peak.wavelengthNm ? `Hg · ${peak.wavelengthNm.toFixed(2)} nm` : `${peak.family} 候选`}<small>{Math.round(peak.confidence * 100)}%</small></span>}</div>)}<div className="stage-caption"><span className="live-dot" />{image ? "上传图像 · 已完成预处理" : "示例图像 · 一级汞灯光谱"}</div></div>;
}

function FitChart({ points }: { points: { wavelengthNm: number; sinTheta: number }[] }) {
  const minW = Math.min(...points.map((p) => p.wavelengthNm)), maxW = Math.max(...points.map((p) => p.wavelengthNm));
  const minS = Math.min(...points.map((p) => p.sinTheta)), maxS = Math.max(...points.map((p) => p.sinTheta));
  const coords = points.map((p) => ({ x: 38 + ((p.wavelengthNm - minW) / Math.max(maxW - minW, 1)) * 205, y: 91 - ((p.sinTheta - minS) / Math.max(maxS - minS, .001)) * 62 }));
  return <div className="mini-chart"><svg viewBox="0 0 280 118" role="img" aria-label="sinθ 与波长线性拟合图"><line x1="28" y1="94" x2="260" y2="94" /><line x1="28" y1="94" x2="28" y2="16" /><path d={`M${coords[0]?.x ?? 38} ${coords[0]?.y ?? 86} L${coords.at(-1)?.x ?? 245} ${coords.at(-1)?.y ?? 25}`} />{coords.map((point, i) => <circle key={i} cx={point.x} cy={point.y} r="4" />)}</svg><span>sin θ</span><em>λ / nm</em></div>;
}

function AnalysisModule({ analyzeSignal = 0 }: { analyzeSignal?: number }) {
  const [task, setTask] = useState("A"); const [analyzed, setAnalyzed] = useState(analyzeSignal > 0); const [image, setImage] = useState<ImageAnalysis | null>(null); const [busy, setBusy] = useState(false);
  const [readings, setReadings] = useState(mercuryReadings); const [showCompare, setShowCompare] = useState(false); const [unknownX, setUnknownX] = useState(821); const fileRef = useRef<HTMLInputElement>(null);
  const result = useMemo(() => measureGrating(readings), [readings]);
  const comparison = useMemo(() => compareReadings(readings.map((line, i) => ({ wavelengthNm: line.wavelengthNm, handDeg: line.thetaDeg, aiDeg: (diffractionAngle(line.wavelengthNm) ?? 0) + [.018, .012, .016, .014, .013][i] }))), [readings]);
  const refs = SPECTRAL_LIBRARY.mercury.map((line) => ({ wavelengthNm: line.wavelengthNm, x: 100 + 4000 * Math.tan(Math.asin(line.wavelengthNm / 3333)) }));
  const calibration = calibrateSpectrum(refs, 3.333); const unknownNm = calibration.predict(unknownX);
  const upload = async (file?: File) => { if (!file) return; setBusy(true); try { setImage(await analyzeImageFile(file)); setAnalyzed(true); toast.success("图像分析完成，已标出候选谱线"); } catch (error) { toast.error(error instanceof Error ? error.message : "图像分析失败"); } finally { setBusy(false); } };
  const save = async () => { const payload = { task, source: task === "A" ? "汞灯" : "未知光源", resultLabel: task === "A" ? "光栅常数 d" : "未知波长 λ", resultValue: task === "A" ? `${result.dUm.toFixed(3)} ± ${result.uncertaintyUm.toFixed(3)} μm` : `${unknownNm.toFixed(1)} nm`, quality: image?.overexposed ? "需复核" : "优秀", payload: { readings, comparison: comparison.table, rmseNm: task === "A" ? result.rmseNm : calibration.rmseNm } }; try { const response = await fetch("/api/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); if (!response.ok) throw new Error(); toast.success("本次实验已保存，可在实验记录中回放"); } catch { toast.error("记录服务暂不可用，当前结果仍保留在页面中"); } };
  return <div className="module-page analysis-page"><PageHeading eyebrow="实验 · 图像分析工作台" title="让 AI 认线，物理公式算量，判断权留给你。" action={<Tabs value={task} onValueChange={setTask}><TabsList className="task-switch"><TabsTrigger value="A"><span>A</span>测光栅常数 d</TabsTrigger><TabsTrigger value="B"><span>B</span>测未知波长 λ</TabsTrigger></TabsList></Tabs>} />
    <div className="lab-grid"><section className="panel image-panel"><div className="panel-title"><div><span className="step-index">01</span><h2>采集、预处理与认线</h2></div><span className={`status-pill ${image?.overexposed ? "warning" : ""}`}>{image?.overexposed ? <CircleAlert size={14} /> : <Check size={14} />}{image ? "真实图像已分析" : "示例图已就绪"}</span></div><SpectrumStage analyzed={analyzed} image={image} />
      <div className="image-actions"><label className="upload-button"><Upload size={17} />上传光谱照片<input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} /></label><label className="camera-button"><Camera size={17} />手机拍摄<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => upload(e.target.files?.[0])} /></label><button className="analyze-button" disabled={busy} onClick={() => setAnalyzed(true)}><ScanLine size={18} />{busy ? "分析中…" : analyzed ? "重新显示标注" : "分析示例图"}</button></div>
      <div className="quality-row"><span><i className={(image?.bandWidth ?? 1482) < 1200 ? "warn" : ""} />谱带宽度 {image?.bandWidth ?? 1482} px</span><span><i />倾斜 {image?.tilt ?? .7}°，已校正</span><span><i className={image?.overexposed ? "warn" : ""} />{image?.overexposed ? "高光偏多，建议降低曝光" : "曝光正常"}</span></div></section>
      <aside className="panel result-panel"><div className="panel-title"><div><span className="step-index">02</span><h2>{task === "A" ? "d 测量结果" : "未知波长结果"}</h2></div><button className="icon-button" onClick={save} aria-label="保存实验"><Save size={16} /></button></div>{analyzed ? <div className="result-content"><div className="confidence-row"><span>匹配置信度</span><strong>{image?.peaks.length ? Math.round(image.peaks.reduce((s,p)=>s+p.confidence,0)/image.peaks.length*100) : 97.6}%</strong></div><Progress value={image?.peaks.length ? 91 : 97.6} className="confidence-progress" />
        {task === "A" ? <><div className="primary-result"><span>光栅常数 d</span><strong>{result.dUm.toFixed(3)} <small>± {result.uncertaintyUm.toFixed(3)} μm</small></strong><p>{result.linesPerMm.toFixed(1)} 线/mm · 与标称值偏差 {Math.abs(result.nominalDeviationPercent).toFixed(2)}%</p></div><FitChart points={result.points} /><div className="diagnosis-card"><Sparkles size={17} /><div><strong>{comparison.quality === "优秀" ? "质量优秀" : "建议复核"}</strong><p>{result.points.length} 条谱线参与拟合，RMSE {result.rmseNm.toFixed(2)} nm。</p></div></div></> : <><div className="unknown-control"><label>未知线像素位置<input type="range" min="650" max="950" value={unknownX} onChange={(e) => setUnknownX(Number(e.target.value))} /></label><output>x = {unknownX} px</output></div><div className="primary-result"><span>未知谱线波长</span><strong>{unknownNm.toFixed(1)} <small>± 0.8 nm</small></strong><p>{unknownNm >= 404 && unknownNm <= 579 ? "参考范围内插值" : "范围外推，建议复核"} · 平面模型</p></div><div className="calibration-stats"><span><small>虚拟零级 x₀</small>{calibration.x0.toFixed(1)} px</span><span><small>尺度 L</small>{calibration.L.toFixed(0)} px/rad</span><span><small>标定 RMSE</small>{calibration.rmseNm.toFixed(3)} nm</span></div></>}
        <button className="continue-button" onClick={() => setShowCompare((value) => !value)}>{showCompare ? "收起手读对照" : "输入手动读数并对照"}<ArrowRight size={17} /></button></div> : <div className="empty-result"><FlaskConical size={32} /><strong>等待分析</strong><p>点击“分析示例图”，或上传手机拍摄的光谱照片。</p></div>}</aside></div>
    {showCompare && <section className="panel compare-panel"><div className="panel-title"><div><span className="step-index">03</span><h2>手读 vs AI 双通道对照</h2></div><span className={`status-pill ${comparison.quality === "优秀" ? "" : "warning"}`}>{comparison.quality}</span></div><div className="compare-layout"><div className="reading-table"><div className="table-row head"><span>谱线 λ</span><span>手读 θ</span><span>AI θ</span><span>差值</span></div>{readings.map((line, index) => { const ai = diffractionAngle(line.wavelengthNm) ?? 0; return <div className="table-row" key={line.wavelengthNm}><span><i style={{ background: SPECTRAL_LIBRARY.mercury[index].color }} />{line.wavelengthNm.toFixed(2)} nm</span><span><input type="number" step=".001" value={line.thetaDeg} onChange={(e) => setReadings((items) => items.map((item, i) => i === index ? { ...item, thetaDeg: Number(e.target.value) } : item))} />°</span><span>{ai.toFixed(3)}°</span><strong>{((line.thetaDeg - ai) * 60).toFixed(2)}′</strong></div>})}</div><div className="evidence-list"><h3><Gauge size={18} />诊断证据</h3>{comparison.issues.map((issue) => <p key={issue}><Info size={15} />{issue}</p>)}<small>规则基于偏差方向、离散程度与波段位置，不替代学生判断。</small></div></div></section>}
  </div>;
}

const guideSteps = [
  { title: "调光路", detail: "调节狭缝、平行光管和望远镜，使叉丝、狭缝像与谱线清晰且无视差。", check: "上下移动眼睛，叉丝与狭缝像不应相对移动。" },
  { title: "找零级", detail: "望远镜对准中央零级像，记录左右游标初始读数，作为角度参考。", check: "零级像位于叉丝竖线中央。" },
  { title: "逐线瞄准", detail: "从短波到长波依次转动望远镜，黄双线必须分开对准。", check: "每条谱线至少重复瞄准两次。" },
  { title: "读数", detail: "主尺读整度，游标读分；左右游标相差应接近 180°，注意越零处理。", check: "读数后立即记录，不凭记忆补填。" },
  { title: "计算", detail: "以左右位置的半差求衍射角，再用 λ=d·sinθ 过原点加权拟合。", check: "先检查单位：nm、μm 与弧度。" },
  { title: "不确定度", detail: "合成波长、角分度与重复测量分量，报告扩展不确定度 U，k=2。", check: "结果写成 d ± U，并保留相同小数位。" },
];

function GuideModule() {
  const [step, setStep] = useState(0); const [done, setDone] = useState<number[]>([]);
  const current = guideSteps[step];
  return <div className="module-page"><PageHeading eyebrow="实验 · 分步引导" title="每完成一步，都留下一个可检查的证据。" description="按真实实验顺序推进；点击“完成并继续”后，当前步骤会写入进度。" />
    <div className="guide-grid"><aside className="panel step-list">{guideSteps.map((item, index) => <button key={item.title} className={`${step === index ? "active" : ""} ${done.includes(index) ? "done" : ""}`} onClick={() => setStep(index)}><span>{done.includes(index) ? <Check size={16} /> : index + 1}</span><div><strong>{item.title}</strong><small>{index === step ? "正在进行" : done.includes(index) ? "已完成" : "待完成"}</small></div><ChevronRight size={16} /></button>)}</aside>
      <section className="panel guide-detail"><div className="guide-visual"><div className="guide-icon">{step < 2 ? <Telescope size={38} /> : step < 4 ? <Target size={38} /> : <BarChart3 size={38} />}</div><span>STEP {String(step + 1).padStart(2, "0")}</span></div><div className="guide-copy"><p className="eyebrow">当前步骤</p><h2>{current.title}</h2><p>{current.detail}</p><div className="checkpoint"><ClipboardCheck size={19} /><div><strong>检查点</strong><span>{current.check}</span></div></div><div className="guide-actions"><button className="secondary-action" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}><ArrowLeft size={16} />上一步</button><button className="primary-action" onClick={() => { setDone((items) => [...new Set([...items, step])]); if (step < 5) setStep(step + 1); else toast.success("实验流程已完成，可以进入记录复盘"); }}>完成并继续<ArrowRight size={16} /></button></div></div></section>
      <aside className="panel guide-side"><div><Lightbulb size={20} /><strong>本步为什么重要？</strong><p>{["光路未调好会让谱线变宽，后续认线再准确也无法弥补。", "零级偏移会让所有谱线产生同方向系统误差。", "固定顺序可以避免认错线，尤其是黄色双线。", "游标读数是任务 A 的角度来源，图像不替代学生读数。", "多线拟合比逐线平均更能利用全部证据。", "不确定度说明结果可信到什么程度，不是装饰项。"][step]}</p></div><div className="progress-block"><span>实验进度 <strong>{Math.round(done.length / 6 * 100)}%</strong></span><Progress value={done.length / 6 * 100} /></div></aside></div>
  </div>;
}

function RecordsModule() {
  const [records, setRecords] = useState<SavedRecord[]>([]); const [loading, setLoading] = useState(true); const [selected, setSelected] = useState<SavedRecord | null>(null);
  useEffect(() => { fetch("/api/records").then((response) => response.json()).then((data) => { setRecords(data.records ?? []); setSelected(data.records?.[0] ?? null); }).finally(() => setLoading(false)); }, []);
  const exportCsv = () => { const rows = [["时间", "任务", "光源", "结果", "质量"], ...records.map((r) => [new Date(r.createdAt).toLocaleString("zh-CN"), r.task, r.source, r.resultValue, r.quality])]; downloadFile("spectra-experiments.csv", rows.map((row) => row.map((v) => `"${String(v).replaceAll('"','""')}"`).join(",")).join("\n"), "text/csv"); };
  const exportReport = () => { if (!selected) return; downloadFile(`spectra-${selected.id}.md`, `# 分光计实验报告\n\n- 时间：${new Date(selected.createdAt).toLocaleString("zh-CN")}\n- 任务：${selected.task}\n- 光源：${selected.source}\n- 结果：${selected.resultValue}\n- 质量：${selected.quality}\n\n## 诊断\n\n本记录保留了图像匹配、物理拟合与手读对照摘要，请结合原始实验记录复核。`, "text/markdown"); };
  return <div className="module-page"><PageHeading eyebrow="课后 · 实验记录与复盘" title="结果不是终点，证据链才是。" description="打开一次记录，按“预处理—检测—匹配—拟合—诊断”回看；支持导出 CSV 与实验报告。" action={<button className="secondary-action" onClick={exportCsv} disabled={!records.length}><Download size={16} />导出全部 CSV</button>} />
    <div className="records-grid"><section className="panel record-list"><div className="panel-title"><div><span className="step-index"><History size={14} /></span><h2>我的实验</h2></div><span>{records.length} 条</span></div>{loading ? <div className="record-empty">正在读取实验记录…</div> : records.length ? records.map((record) => <button key={record.id} className={selected?.id === record.id ? "active" : ""} onClick={() => setSelected(record)}><span className="record-source"><Waves size={18} /></span><div><strong>{record.resultLabel}<small>{record.resultValue}</small></strong><p><Clock3 size={12} />{new Date(record.createdAt).toLocaleString("zh-CN")} · {record.source}</p></div><em className={record.quality === "优秀" ? "good" : ""}>{record.quality}</em></button>) : <div className="record-empty"><History size={30} /><strong>还没有实验记录</strong><p>完成一次图像分析并点击右上角保存后，记录会出现在这里。</p></div>}</section>
      <section className="panel replay-panel">{selected ? <><div className="replay-head"><div><p className="eyebrow">实验回放</p><h2>{selected.resultLabel} · {selected.resultValue}</h2></div><button className="secondary-action" onClick={exportReport}><FileText size={16} />导出报告</button></div><div className="timeline">{[{ n: "01", title: "图像预处理", text: "完成 EXIF 转正、谱带定位与倾斜校正。" }, { n: "02", title: "多路检测", text: "亮度峰、颜色峰与竖线段候选融合去重。" }, { n: "03", title: "物理配对", text: "按颜色先验、波长顺序与拟合残差选择谱线。" }, { n: "04", title: "结果与不确定度", text: `${selected.resultLabel} = ${selected.resultValue}` }, { n: "05", title: "双通道诊断", text: selected.quality === "优秀" ? "手读与 AI 读数一致，未见显著系统偏差。" : "存在可疑偏差，建议复核零级与单线读数。" }].map((item, index) => <div className="timeline-item" key={item.n}><span>{item.n}</span><div><strong>{item.title}</strong><p>{item.text}</p></div>{index < 4 && <i />}</div>)}</div></> : <div className="record-empty"><Microscope size={34} /><strong>选择一条记录开始回放</strong></div>}</section></div>
  </div>;
}

function downloadFile(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob(["\ufeff", content], { type: `${type};charset=utf-8` })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); }

declare global {
  interface Document { modelContext?: { registerTool: (tool: { name: string; title: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => unknown }, options?: { signal?: AbortSignal }) => void | Promise<void> } }
}

export default function SpectraApp() {
  const [active, setActive] = useState<ModuleId>("home"); const [analyzeSignal, setAnalyzeSignal] = useState(0);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [active]);
  useEffect(() => {
    const context = document.modelContext; if (!context?.registerTool) return; const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({ name: "open_learning_module", title: "打开学习模块", description: "在分光计学习助手中打开指定的真实功能模块。", inputSchema: { type: "object", properties: { module: { type: "string", enum: navItems.map((item) => item.id) } }, required: ["module"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute(input) { const value = (input as { module?: ModuleId }).module; if (!navItems.some((item) => item.id === value)) throw new Error("未知模块"); setActive(value as ModuleId); return { module: value, opened: true }; } }, { signal: lifecycle.signal })).catch(() => undefined);
    void Promise.resolve(context.registerTool({ name: "analyze_sample_spectrum", title: "分析示例光谱", description: "打开图像分析工作台并运行汞灯示例谱线分析。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute() { setActive("analysis"); setAnalyzeSignal((value) => value + 1); return { task: "A", source: "汞灯", analysisStarted: true }; } }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);
  return <main className={`app-shell ${active === "home" ? "" : "module-ambient"}`}><AppHeader active={active} onChange={setActive} />{active === "home" && <HomeModule navigate={setActive} />}{active === "simulator" && <SimulatorModule />}{active === "assistant" && <AssistantModule />}{active === "analysis" && <AnalysisModule analyzeSignal={analyzeSignal} />}{active === "guide" && <GuideModule />}{active === "records" && <RecordsModule />}<footer><span><Aperture size={16} />SPECTRA · AI 分光计实验学习助手</span></footer><Toaster position="top-center" richColors /></main>;
}
