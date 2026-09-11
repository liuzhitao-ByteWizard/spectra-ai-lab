"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Aperture, ArrowLeft, ArrowRight, BarChart3, BookOpen, Bot, Camera, Check,
  CheckCircle2, ChevronRight, CircleAlert, CircleHelp, ClipboardCheck, Clock3,
  Download, FileText, FlaskConical, History, Home,
  Lightbulb, ListChecks, MessageCircle, Microscope, Play, RotateCcw, Save,
  ScanLine, Send, SlidersHorizontal, Target, Telescope, Upload, Waves,
} from "lucide-react";
import { toast } from "sonner";
import Image from "next/image";
import { Toaster } from "@/components/ui/sonner";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AssistantAnswer from "./AssistantAnswer";
import AuroraField from "./AuroraField";
import {
  calibrateSpectrum, diffractionAngle, fitGratingFromPixels, measureGrating,
  SPECTRAL_LIBRARY, type MeasurementLine,
} from "@/lib/spectrometer";
import {
  RecordRequestError, requestRecordJson, type ExperimentImageSlot,
  type ExperimentTask, type RecordSnapshot, type SavedRecord,
} from "@/lib/experiment-record";

type ModuleId = "home" | "simulator" | "assistant" | "analysis" | "guide" | "records";
type Peak = { x: number; xRatio: number; family: string; color: string; confidence: number; prominence: number; widthPx: number; wavelengthNm?: number };
type DetectorOptions = { prominence: number; minDistancePx: number };
type SpectrumSource = {
  preview: string | null; fileName: string; width: number; height: number;
  rawIntensity: number[]; chromaIntensity: number[]; red: number[]; green: number[]; blue: number[];
  overexposed: boolean; tilt: number; bandWidth: number; sample?: boolean;
};
type ImageAnalysis = SpectrumSource & { smoothIntensity: number[]; peaks: Peak[] };
type ReferenceMarker = { wavelengthNm: number; xRatio: number };
type UnknownLineResult = { index: number; x: number; xRatio: number; wavelengthNm: number; uncertaintyNm: number; status: "范围内" | "外推" };
const navItems: { id: ModuleId; label: string; icon: typeof Home }[] = [
  { id: "home", label: "首页", icon: Home },
  { id: "simulator", label: "虚拟分光计", icon: Telescope },
  { id: "assistant", label: "AI 助教", icon: Bot },
  { id: "analysis", label: "图像分析", icon: ScanLine },
  { id: "guide", label: "实验引导", icon: ListChecks },
  { id: "records", label: "实验记录", icon: History },
];

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

function smoothIntensity(values: number[], radius = 1) {
  return values.map((_, x) => {
    let sum = 0, weights = 0;
    for (let k = -radius; k <= radius; k++) if (values[x + k] !== undefined) {
      const weight = radius + 1 - Math.abs(k); sum += values[x + k] * weight; weights += weight;
    }
    return sum / Math.max(weights, 1);
  });
}

function classifyPeakColor(source: SpectrumSource, x: number) {
  const index = Math.round(x);
  const radius = 14;
  const sideIndexes = Array.from({ length: radius * 2 }, (_, offset) => index - radius + offset)
    .filter((sample) => sample >= 0 && sample < source.width && Math.abs(sample - index) > 2);
  const background = (channel: number[]) => sideIndexes.reduce((sum, sample) => sum + (channel[sample] ?? 0), 0) / Math.max(sideIndexes.length, 1);
  const r = Math.max(0, (source.red[index] ?? 0) - background(source.red));
  const g = Math.max(0, (source.green[index] ?? 0) - background(source.green));
  const b = Math.max(0, (source.blue[index] ?? 0) - background(source.blue));
  return r + g + b > 2 ? classifyColor(r, g, b) : classifyColor(source.red[index] ?? 0, source.green[index] ?? 0, source.blue[index] ?? 0);
}

function detectSpectrumPeaks(source: SpectrumSource, options: DetectorOptions): ImageAnalysis {
  // Radius 1 keeps the 576.96/579.07 nm doublet separated.  The former
  // seven-pixel kernel merged it into one broad peak on phone photos.
  const smooth = smoothIntensity(source.rawIntensity, 1);
  const smoothChroma = smoothIntensity(source.chromaIntensity, 1);
  const candidates: { x: number; score: number; prominence: number; widthPx: number }[] = [];
  const minDistance = Number.isFinite(options.minDistancePx) ? Math.min(64, Math.max(2, options.minDistancePx)) : 3;
  const requiredProminence = Number.isFinite(options.prominence) ? Math.min(.2, Math.max(.004, options.prominence)) : .018;
  const radius = Math.max(10, minDistance * 4);
  for (let x = 2; x < smooth.length - 2; x++) {
    if (smooth[x] < smooth[x - 1] || smooth[x] <= smooth[x + 1]) continue;
    const left = smooth.slice(Math.max(0, x - radius), x);
    const right = smooth.slice(x + 1, Math.min(smooth.length, x + radius + 1));
    const baseline = Math.max(Math.min(...left), Math.min(...right));
    const prominence = smooth[x] - baseline;
    const chromaLeft = smoothChroma.slice(Math.max(0, x - radius), x);
    const chromaRight = smoothChroma.slice(x + 1, Math.min(smooth.length, x + radius + 1));
    const chromaBaseline = Math.max(Math.min(...chromaLeft), Math.min(...chromaRight));
    const chromaProminence = smoothChroma[x] - chromaBaseline;
    const halfHeight = baseline + prominence * .5;
    let leftEdge = x, rightEdge = x;
    while (leftEdge > Math.max(0, x - radius) && smooth[leftEdge] > halfHeight) leftEdge--;
    while (rightEdge < Math.min(smooth.length - 1, x + radius) && smooth[rightEdge] > halfHeight) rightEdge++;
    const widthPx = rightEdge - leftEdge;
    // Camera spectra form a small luminous band. Single-pixel bright/dark
    // reticles can be locally prominent but have neither chromatic support nor
    // enough width, so they are rejected without assuming a fixed line count.
    const spectralShape = widthPx >= 1.5 && chromaProminence >= Math.max(.0025, prominence * .1);
    if (prominence >= requiredProminence && smooth[x] >= .035 && spectralShape) {
      const denominator = smooth[x - 1] - 2 * smooth[x] + smooth[x + 1];
      const offset = Math.abs(denominator) > 1e-8 ? Math.max(-.5, Math.min(.5, .5 * (smooth[x - 1] - smooth[x + 1]) / denominator)) : 0;
      candidates.push({ x: x + offset, score: smooth[x], prominence, widthPx });
    }
  }
  const selected: typeof candidates = [];
  for (const candidate of candidates.sort((a, b) => (b.prominence + b.score * .2) - (a.prominence + a.score * .2))) {
    const near = selected.find((item) => Math.abs(item.x - candidate.x) < minDistance);
    if (!near) selected.push(candidate);
    else {
      const first = classifyPeakColor(source, near.x);
      const second = classifyPeakColor(source, candidate.x);
      const lo = Math.ceil(Math.min(near.x, candidate.x));
      const hi = Math.floor(Math.max(near.x, candidate.x));
      const valley = smooth.slice(lo, hi + 1).reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
      const separated = Math.min(near.score, candidate.score) - valley > Math.max(.003, requiredProminence * .18);
      // A resolved yellow doublet is physically meaningful and must not be
      // discarded merely because its pixel spacing is below the generic NMS.
      if (first.family === "yellow" && second.family === "yellow" && separated) selected.push(candidate);
    }
    if (selected.length === 16) break;
  }
  selected.sort((a, b) => a.x - b.x);
  const peaks = selected.map((item) => {
    const classified = classifyPeakColor(source, item.x);
    const mapped = SPECTRAL_LIBRARY.mercury.find((line) => line.family === classified.family);
    return {
      x: item.x, xRatio: item.x / Math.max(source.width, 1), family: classified.family,
      color: classified.color, confidence: Math.min(.99, .68 + item.prominence * 3.2 + item.score * .14), prominence: item.prominence, widthPx: item.widthPx, wavelengthNm: mapped?.wavelengthNm,
    };
  });
  return { ...source, smoothIntensity: smooth, peaks };
}

function autoMatchMercuryPeaks(image: ImageAnalysis): ReferenceMarker[] {
  if (image.peaks.length < SPECTRAL_LIBRARY.mercury.length) return [];
  const peaks = [...image.peaks].sort((a, b) => a.x - b.x).slice(0, 16);
  const lines = [...SPECTRAL_LIBRARY.mercury].sort((a, b) => a.wavelengthNm - b.wavelengthNm);
  const best: { value: { score: number; markers: ReferenceMarker[] } | null } = { value: null };

  const visit = (start: number, chosen: Peak[]) => {
    if (chosen.length === lines.length) {
      for (const direction of [1, -1]) {
        const mappedLines = direction === 1 ? lines : [...lines].reverse();
        let score = 0;
        for (let index = 0; index < chosen.length; index++) {
          const expected = mappedLines[index].family;
          const actual = chosen[index].family;
          const familyPenalty = expected === actual ? 0 :
            ((expected === "violet" && actual === "blue") || (expected === "blue" && actual === "violet")) ? .55 : 2.4;
          score += familyPenalty + (1 - chosen[index].confidence) * .45;
        }
        // The mercury yellow doublet should be adjacent and relatively close.
        const yellow = chosen.filter((_, index) => mappedLines[index].family === "yellow");
        if (yellow.length === 2) score += Math.min(2, Math.abs(yellow[1].x - yellow[0].x) / Math.max(image.width * .08, 1));
        const meanWavelength = mappedLines.reduce((sum, line) => sum + line.wavelengthNm, 0) / mappedLines.length;
        const meanX = chosen.reduce((sum, peak) => sum + peak.x, 0) / chosen.length;
        const covariance = chosen.reduce((sum, peak, index) => sum + (mappedLines[index].wavelengthNm - meanWavelength) * (peak.x - meanX), 0);
        const variance = mappedLines.reduce((sum, line) => sum + (line.wavelengthNm - meanWavelength) ** 2, 0);
        const slope = covariance / Math.max(variance, 1e-9);
        const geometryRmsePx = Math.sqrt(chosen.reduce((sum, peak, index) => {
          const predictedX = meanX + slope * (mappedLines[index].wavelengthNm - meanWavelength);
          return sum + (peak.x - predictedX) ** 2;
        }, 0) / chosen.length);
        score += geometryRmsePx / Math.max(image.width * .012, 1);
        const markers = chosen.map((peak, index) => ({ wavelengthNm: mappedLines[index].wavelengthNm, xRatio: peak.xRatio }));
        if (!best.value || score < best.value.score) best.value = { score, markers };
      }
      return;
    }
    for (let index = start; index <= peaks.length - (lines.length - chosen.length); index++) visit(index + 1, [...chosen, peaks[index]]);
  };
  visit(0, []);
  const winner = best.value;
  return winner && winner.score < 4.2 ? winner.markers.sort((a, b) => a.xRatio - b.xRatio) : [];
}

function applyMercuryFiveLineModel(image: ImageAnalysis) {
  const markers = autoMatchMercuryPeaks(image);
  if (markers.length !== SPECTRAL_LIBRARY.mercury.length) return image;
  const peaks = markers.map((marker) => image.peaks.reduce((closest, peak) =>
    Math.abs(peak.xRatio - marker.xRatio) < Math.abs(closest.xRatio - marker.xRatio) ? peak : closest,
  image.peaks[0]));
  return { ...image, peaks: [...new Map(peaks.map((peak) => [peak.x, peak])).values()].sort((a, b) => a.x - b.x) };
}

function buildSampleSource(): SpectrumSource {
  const width = 1000, height = 560;
  const positions = SPECTRAL_LIBRARY.mercury.map((line) => Math.round(100 + 4000 * Math.tan(Math.asin(line.wavelengthNm / 3333))));
  const rawIntensity = Array.from({ length: width }, (_, x) => {
    const signal = positions.reduce((sum, position, index) => sum + SPECTRAL_LIBRARY.mercury[index].intensity * Math.exp(-((x - position) ** 2) / 18), 0);
    return Math.min(1, .025 + signal);
  });
  const chromaIntensity = [...rawIntensity];
  const red = new Array(width).fill(28), green = new Array(width).fill(42), blue = new Array(width).fill(58);
  positions.forEach((position, index) => {
    const hex = SPECTRAL_LIBRARY.mercury[index].color;
    red[position] = Number.parseInt(hex.slice(1, 3), 16); green[position] = Number.parseInt(hex.slice(3, 5), 16); blue[position] = Number.parseInt(hex.slice(5, 7), 16);
  });
  return { preview: null, fileName: "汞灯一级光谱示例", width, height, rawIntensity, chromaIntensity, red, green, blue, overexposed: false, tilt: .7, bandWidth: width, sample: true };
}

async function analyzeImageFile(file: File): Promise<SpectrumSource> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2400 / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法读取图像");
  context.drawImage(bitmap, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const y0 = Math.floor(height * .2), y1 = Math.ceil(height * .8);
  const scores = new Array(width).fill(0), chromas = new Array(width).fill(0), reds = new Array(width).fill(0), greens = new Array(width).fill(0), blues = new Array(width).fill(0);
  let over = 0, sampled = 0, totalWeight = 0;
  for (let y = y0; y < y1; y += 2) {
    const weight = Math.exp(-((y - height / 2) ** 2) / (2 * (height * .22) ** 2));
    totalWeight += weight;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
      const value = Math.max(r, g, b), chroma = value - Math.min(r, g, b);
      scores[x] += weight * (.38 * value + .62 * chroma);
      chromas[x] += weight * chroma;
      reds[x] += r; greens[x] += g; blues[x] += b;
      if (value > 250) over++; sampled++;
    }
  }
  const sampleRows = Math.max(1, Math.ceil((y1 - y0) / 2));
  return {
    preview: URL.createObjectURL(file), fileName: file.name, width, height,
    rawIntensity: scores.map((value) => Math.min(1, value / Math.max(totalWeight * 255, 1))),
    chromaIntensity: chromas.map((value) => Math.min(1, value / Math.max(totalWeight * 255, 1))),
    red: reds.map((value) => value / sampleRows), green: greens.map((value) => value / sampleRows), blue: blues.map((value) => value / sampleRows),
    overexposed: over / Math.max(sampled, 1) > .045, tilt: .7, bandWidth: width,
  };
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
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; text: string; source?: string }[]>([{ role: "assistant", text: "你好，我是你的 AI 助教。我重点辅导分光计与光栅实验，也可以帮助你理解课程知识、润色文字和分析编程问题。直接告诉我你现在遇到的困难。", source: "AI 助教 · 物理实验与通用问答" }]);
  const [sending, setSending] = useState(false);
  const ask = async (preset?: string) => {
    const value = (preset ?? question).trim(); if (!value || sending) return;
    setMessages((items) => [...items, { role: "user", text: value }]); setQuestion(""); setSending(true);
    try { const response = await fetch("/api/ai/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: value }) }); const data = await response.json() as { answer?: string; sources?: string[]; error?: string }; if (!response.ok || !data.answer) throw new Error(data.error || "AI 助教暂时不可用"); setMessages((items) => [...items, { role: "assistant", text: data.answer!, source: data.sources?.[0] }]); }
    catch (error) { setMessages((items) => [...items, { role: "assistant", text: error instanceof Error ? error.message : "AI 助教暂时不可用，请稍后重试。", source: "系统提示" }]); }
    finally { setSending(false); }
  };
  return <div className="module-page"><PageHeading eyebrow="AI 助教 · 物理实验与通用问答" title="从分光计实验到学习生活，都可以问我。" description="重点辅导分光计与光栅实验，也支持课程答疑、知识讲解、写作润色、编程分析和日常问题解答。" />
    <div className="assistant-grid"><aside className="question-bank panel"><div className="panel-title"><div><span className="step-index"><BookOpen size={15} /></span><h2>试试这样问</h2></div></div><div className="quick-questions">{["为什么黄光是两条？", "帮我制定一份复习计划", "解释一个陌生概念", "帮我润色一段文字", "给我一个编程思路"].map((text) => <button key={text} onClick={() => ask(text)}><MessageCircle size={15} />{text}<ChevronRight size={15} /></button>)}</div><div className="knowledge-scope"><strong>能力范围</strong><span>分光计实验</span><span>物理实验</span><span>课程答疑</span><span>写作润色</span><span>编程分析</span></div></aside>
      <section className="chat-panel panel"><div className="chat-status"><span><i />AI 助教在线</span><em>物理实验 · 通用问答</em></div><div className="messages">{messages.map((message, index) => <div key={index} className={`message ${message.role}`}><span>{message.role === "assistant" ? <Bot size={17} /> : "你"}</span><div>{message.role === "assistant" ? <AssistantAnswer>{message.text}</AssistantAnswer> : <p>{message.text}</p>}{message.source && <small><BookOpen size={12} />{message.source}</small>}</div></div>)}{sending && <div className="message assistant"><span><Bot size={17} /></span><div><p>AI 助教正在分析问题…</p></div></div>}</div><form className="chat-input" onSubmit={(e) => { e.preventDefault(); ask(); }}><textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="问分光计实验、课程、写作、编程或日常问题…" /><button type="submit" aria-label="发送问题"><Send size={18} /></button></form><p className="chat-hint">AI 可能出错，重要信息请结合可靠来源核实。</p></section></div>
  </div>;
}

function lineColor(wavelengthNm: number) {
  return SPECTRAL_LIBRARY.mercury.find((line) => line.wavelengthNm === wavelengthNm)?.color ?? "#2185ee";
}

function SpectrumStage({ image, markers = [], onMark, caption }: { image: ImageAnalysis | null; markers?: ReferenceMarker[]; onMark?: (xRatio: number) => void; caption: string }) {
  if (!image) return <div className="spectrum-stage spectrum-empty"><Upload size={34} /><strong>等待光谱照片</strong><p>建议使用一级光谱，谱线清晰、不过曝，并保持画幅水平。</p></div>;
  const imageFit = image.width / image.height >= 16 / 9 ? "fit-width" : "fit-height";
  const overlay = <>
    <div className="crosshair crosshair-x" />
    {image.peaks.map((peak, index) => <i className="detected-spectrum-line" key={`${peak.x}-${index}`} style={{ left: `${peak.xRatio * 100}%`, backgroundColor: peak.color }}><small>{index + 1}</small></i>)}
    {markers.map((marker, index) => <span className={`reference-marker ${index > 0 && Math.abs(marker.xRatio - markers[index - 1].xRatio) < .05 ? "is-offset" : ""}`} key={marker.wavelengthNm} style={{ left: `${marker.xRatio * 100}%`, borderColor: lineColor(marker.wavelengthNm) }}><b>{marker.wavelengthNm.toFixed(2)} nm</b><small>{Math.round(marker.xRatio * image.width)} px</small></span>)}
  </>;
  return <div className="spectrum-stage has-image">
    <div className={`spectrum-image-frame ${imageFit} ${image.sample ? "sample-frame" : ""}`} style={{ aspectRatio: `${image.width} / ${image.height}` }} onClick={(event) => { if (!onMark) return; const rect = event.currentTarget.getBoundingClientRect(); onMark(Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))); }}>
      {image.preview ? <><Image className="spectrum-photo" src={image.preview} alt="上传的光谱照片" fill unoptimized sizes="(max-width: 1050px) 100vw, 72vw" /><div className="spectrum-photo-shade" aria-hidden="true" /></> : <div className="sample-spectrum">{image.peaks.map((peak) => <i key={peak.x} style={{ left: `${peak.xRatio * 100}%`, backgroundColor: peak.color }} />)}</div>}
      {overlay}
    </div>
    <div className="stage-caption"><span className="live-dot" />{caption}</div>
  </div>;
}

function MarkerPicker({ selected, setSelected, markers, onClear, onRemove, image, onCandidate }: { selected: number; setSelected: (value: number) => void; markers: ReferenceMarker[]; onClear: () => void; onRemove: (wavelengthNm: number) => void; image: ImageAnalysis | null; onCandidate: (xRatio: number) => void }) {
  return <div className="marker-picker">
    <div className="marker-picker-head"><label>选择要标记的汞灯谱线<select value={selected} onChange={(event) => setSelected(Number(event.target.value))}>{SPECTRAL_LIBRARY.mercury.map((line) => <option value={line.wavelengthNm} key={line.wavelengthNm}>{line.wavelengthNm.toFixed(2)} nm · {line.family}</option>)}</select></label><button onClick={onClear} disabled={!markers.length}>清空</button></div>
    <p>系统会优先自动匹配 5 条汞灯谱线；也可选择标准波长后点击照片或候选峰进行修正。</p>
    {image && <div className="candidate-strip" aria-label="检测到的候选峰">{image.peaks.map((peak, index) => <button key={`${peak.x}-${index}`} onClick={() => onCandidate(peak.xRatio)}><i style={{ background: peak.color }} />峰 {index + 1}<small>{peak.x.toFixed(1)}px</small></button>)}</div>}
    <div className="selected-markers">{markers.length ? markers.map((marker) => <button key={marker.wavelengthNm} onClick={() => onRemove(marker.wavelengthNm)} title="移除此标记"><i style={{ background: lineColor(marker.wavelengthNm) }} />{marker.wavelengthNm.toFixed(2)} nm<span>×</span></button>) : <span>尚未选择谱线；任务 A 至少需要 4 条，建议完整标记 5 条。</span>}</div>
  </div>;
}

function IntensityChart({ image, markers = [], title }: { image: ImageAnalysis | null; markers?: ReferenceMarker[]; title: string }) {
  if (!image) return <div className="chart-empty"><Waves size={30} /><span>完成图像读取后显示强度曲线</span></div>;
  const step = Math.max(1, Math.ceil(image.smoothIntensity.length / 260));
  const points = image.smoothIntensity.filter((_, index) => index % step === 0).map((value, index, values) => `${20 + index / Math.max(values.length - 1, 1) * 760},${184 - value * 145}`).join(" ");
  return <div className="intensity-chart"><svg viewBox="0 0 800 210" role="img" aria-label={title}><line x1="20" y1="184" x2="780" y2="184" /><line x1="20" y1="35" x2="780" y2="35" /><line x1="20" y1="85" x2="780" y2="85" /><line x1="20" y1="135" x2="780" y2="135" /><polyline points={points} />{image.peaks.map((peak, index) => <line className="peak-guide" key={`${peak.x}-${index}`} x1={20 + peak.xRatio * 760} x2={20 + peak.xRatio * 760} y1="40" y2="184" style={{ stroke: peak.color }} />)}{markers.map((marker) => <g key={marker.wavelengthNm}><circle cx={20 + marker.xRatio * 760} cy="28" r="5" style={{ fill: lineColor(marker.wavelengthNm) }} /><text x={20 + marker.xRatio * 760} y="18">{marker.wavelengthNm.toFixed(0)}</text></g>)}</svg><div><span>0 px</span><strong>横向像素位置 x</strong><span>{image.width} px</span></div></div>;
}

function ProcessingTimeline({ image, selectedCount, resultText }: { image: ImageAnalysis | null; selectedCount: number; resultText: string }) {
  const steps = [
    { icon: Upload, title: "图像读取", detail: image ? `${image.width} × ${image.height}px · ${image.fileName}` : "等待上传原始照片" },
    { icon: SlidersHorizontal, title: "强度提取", detail: image ? `中央 60% 谱带 · 倾斜校正 ${image.tilt.toFixed(1)}°` : "生成横向亮度剖面" },
    { icon: Waves, title: "峰值检测", detail: image ? `${image.peaks.length} 个有效峰 · ${image.overexposed ? "高光偏多" : "曝光正常"}` : "色彩对比、峰宽与邻峰联合筛选" },
    { icon: BarChart3, title: "物理计算", detail: selectedCount >= 3 ? resultText : `${selectedCount}/3 条参考线已标记` },
  ];
  return <div className="processing-timeline">{steps.map((item, index) => { const Icon = item.icon; return <div key={item.title} className={image && (index < 3 || selectedCount >= 3) ? "complete" : ""}><span><Icon size={18} /></span><small>0{index + 1}</small><strong>{item.title}</strong><p>{item.detail}</p></div>; })}</div>;
}

type SyncPhase = "loading" | "idle" | "pending" | "saving" | "retrying" | "synced" | "error";
type PendingImages = Record<ExperimentTask, Partial<Record<ExperimentImageSlot, File>>>;

function snapshotFromRecord(record: SavedRecord): RecordSnapshot {
  return {
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

async function sourceFromSyncedImage(url: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("原始光谱图片读取失败");
  const blob = await response.blob();
  return analyzeImageFile(new File([blob], "已同步原始光谱", { type: blob.type || "image/png" }));
}

function useExperimentSync({
  task,
  enabled,
  snapshot,
  pendingImagesRef,
  onRemoteRecord,
}: {
  task: ExperimentTask;
  enabled: boolean;
  snapshot: RecordSnapshot;
  pendingImagesRef: React.MutableRefObject<PendingImages>;
  onRemoteRecord: (record: SavedRecord) => Promise<void>;
}) {
  const metaRef = useRef<Record<ExperimentTask, { id: string; version: number } | null>>({ A: null, B: null });
  const latestSnapshotRef = useRef<Partial<Record<ExperimentTask, RecordSnapshot>>>({});
  const lastSavedSignatureRef = useRef<Partial<Record<ExperimentTask, string>>>({});
  const loadedRef = useRef<Record<ExperimentTask, boolean>>({ A: false, B: false });
  const syncingRef = useRef<Record<ExperimentTask, boolean>>({ A: false, B: false });
  const suppressRef = useRef<Set<ExperimentTask>>(new Set());
  const timersRef = useRef<Partial<Record<ExperimentTask, ReturnType<typeof setTimeout>>>>({});
  const currentTaskRef = useRef(task);
  const onRemoteRecordRef = useRef(onRemoteRecord);
  const runSyncRef = useRef<(task: ExperimentTask) => Promise<void>>(async () => undefined);
  const phaseRef = useRef<SyncPhase>("loading");
  const [phase, setPhase] = useState<SyncPhase>("loading");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [loadRevision, setLoadRevision] = useState(0);

  currentTaskRef.current = task;
  onRemoteRecordRef.current = onRemoteRecord;
  latestSnapshotRef.current[task] = snapshot;

  const changePhase = useCallback((next: SyncPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const adoptRecord = useCallback(async (record: SavedRecord, notify = false) => {
    metaRef.current[record.task] = { id: record.id, version: record.version };
    suppressRef.current.add(record.task);
    await onRemoteRecordRef.current(record);
    setTimeout(() => {
      lastSavedSignatureRef.current[record.task] = JSON.stringify(latestSnapshotRef.current[record.task] ?? snapshotFromRecord(record));
      suppressRef.current.delete(record.task);
    }, 250);
    setLastSyncedAt(Number(new Date(record.updatedAt)));
    setErrorMessage("");
    if (currentTaskRef.current === record.task) changePhase("synced");
    if (notify) toast.info("检测到其他设备的更新，已载入最新版本");
  }, [changePhase]);

  const runSync = useCallback(async (taskToSync: ExperimentTask) => {
    const currentSnapshot = latestSnapshotRef.current[taskToSync];
    if (!currentSnapshot || syncingRef.current[taskToSync]) return;
    syncingRef.current[taskToSync] = true;
    if (currentTaskRef.current === taskToSync) changePhase("saving");
    const signature = JSON.stringify(currentSnapshot);
    const mutationId = crypto.randomUUID();
    try {
      const meta = metaRef.current[taskToSync];
      const response = meta
        ? await requestRecordJson<{ record: SavedRecord }>(`/api/records/${encodeURIComponent(meta.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...currentSnapshot, baseVersion: meta.version, mutationId }),
          }, 3, () => { if (currentTaskRef.current === taskToSync) changePhase("retrying"); })
        : await requestRecordJson<{ record: SavedRecord }>("/api/records", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...currentSnapshot, id: crypto.randomUUID(), mutationId }),
          }, 3, () => { if (currentTaskRef.current === taskToSync) changePhase("retrying"); });

      metaRef.current[taskToSync] = { id: response.record.id, version: response.record.version };
      let savedRecord = response.record;
      const pending = pendingImagesRef.current[taskToSync];
      for (const [slot, file] of Object.entries(pending) as [ExperimentImageSlot, File][]) {
        const imageResponse = await requestRecordJson<{ record: SavedRecord }>(
          `/api/records/${encodeURIComponent(savedRecord.id)}/image?slot=${slot}`,
          { method: "POST", headers: { "Content-Type": file.type || "image/jpeg" }, body: file },
          3,
          () => { if (currentTaskRef.current === taskToSync) changePhase("retrying"); },
        );
        savedRecord = imageResponse.record;
        metaRef.current[taskToSync] = { id: savedRecord.id, version: savedRecord.version };
        if (pendingImagesRef.current[taskToSync][slot] === file) delete pendingImagesRef.current[taskToSync][slot];
      }
      lastSavedSignatureRef.current[taskToSync] = signature;
      setLastSyncedAt(Number(new Date(savedRecord.updatedAt)));
      setErrorMessage("");
      if (currentTaskRef.current === taskToSync) changePhase("synced");
    } catch (error) {
      if (error instanceof RecordRequestError && error.status === 409 && error.record) {
        await adoptRecord(error.record, true);
      } else {
        setErrorMessage(error instanceof Error ? error.message : "自动同步失败");
        if (currentTaskRef.current === taskToSync) changePhase("error");
      }
    } finally {
      syncingRef.current[taskToSync] = false;
      const newest = latestSnapshotRef.current[taskToSync];
      if (newest && JSON.stringify(newest) !== lastSavedSignatureRef.current[taskToSync] && !suppressRef.current.has(taskToSync)) {
        if (currentTaskRef.current === taskToSync) changePhase("pending");
        setTimeout(() => void runSyncRef.current(taskToSync), 0);
      }
    }
  }, [adoptRecord, changePhase, pendingImagesRef]);
  runSyncRef.current = runSync;

  useEffect(() => {
    let cancelled = false;
    if (loadedRef.current[task]) {
      changePhase(metaRef.current[task] ? "synced" : "idle");
      return;
    }
    changePhase("loading");
    requestRecordJson<{ records: SavedRecord[] }>(`/api/records?task=${task}&limit=1`, undefined, 2)
      .then(async ({ records }) => {
        if (cancelled) return;
        if (records[0]) await adoptRecord(records[0]);
        else changePhase("idle");
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "记录读取失败");
        changePhase("error");
      })
      .finally(() => {
        if (!cancelled) {
          loadedRef.current[task] = true;
          setLoadRevision((value) => value + 1);
        }
      });
    return () => { cancelled = true; };
  }, [task, adoptRecord, changePhase]);

  useEffect(() => {
    if (!enabled || !loadedRef.current[task] || suppressRef.current.has(task)) return;
    const signature = JSON.stringify(snapshot);
    if (signature === lastSavedSignatureRef.current[task]) return;
    changePhase("pending");
    if (timersRef.current[task]) clearTimeout(timersRef.current[task]);
    timersRef.current[task] = setTimeout(() => void runSyncRef.current(task), 800);
    return () => { if (timersRef.current[task]) clearTimeout(timersRef.current[task]); };
  }, [task, enabled, snapshot, loadRevision, changePhase]);

  useEffect(() => {
    const pullLatest = async () => {
      const meta = metaRef.current[task];
      if (!meta || phaseRef.current === "pending" || phaseRef.current === "saving" || phaseRef.current === "retrying") return;
      try {
        const { record } = await requestRecordJson<{ record: SavedRecord }>(`/api/records/${encodeURIComponent(meta.id)}`, undefined, 1);
        if (record.version > meta.version) await adoptRecord(record, true);
      } catch {
        // Background refresh stays quiet; the next scheduled pull tries again.
      }
    };
    const interval = setInterval(() => void pullLatest(), 3000);
    const onFocus = () => void pullLatest();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(interval); window.removeEventListener("focus", onFocus); };
  }, [task, adoptRecord]);

  const syncNow = useCallback(() => {
    if (timersRef.current[task]) clearTimeout(timersRef.current[task]);
    return runSyncRef.current(task);
  }, [task]);

  const resetSync = useCallback(() => {
    if (timersRef.current[task]) clearTimeout(timersRef.current[task]);
    metaRef.current[task] = null;
    lastSavedSignatureRef.current[task] = undefined;
    pendingImagesRef.current[task] = {};
    setErrorMessage("");
    changePhase("idle");
  }, [task, changePhase, pendingImagesRef]);

  return { phase, lastSyncedAt, errorMessage, syncNow, resetSync };
}

function AnalysisModule({ analyzeSignal = 0 }: { analyzeSignal?: number }) {
  const [task, setTask] = useState<"A" | "B">("A");
  const [detector, setDetector] = useState<DetectorOptions>({ prominence: .018, minDistancePx: 3 });
  const [aSource, setASource] = useState<SpectrumSource | null>(() => analyzeSignal > 0 ? buildSampleSource() : null); const [bReferenceSource, setBReferenceSource] = useState<SpectrumSource | null>(null); const [bUnknownSource, setBUnknownSource] = useState<SpectrumSource | null>(null);
  const [aMarkers, setAMarkers] = useState<ReferenceMarker[]>(() => analyzeSignal > 0 ? SPECTRAL_LIBRARY.mercury.map((line) => ({ wavelengthNm: line.wavelengthNm, xRatio: (100 + 4000 * Math.tan(Math.asin(line.wavelengthNm / 3333))) / 1000 })) : []); const [bMarkers, setBMarkers] = useState<ReferenceMarker[]>([]); const [selectedWavelength, setSelectedWavelength] = useState(546.07);
  const [zeroX, setZeroX] = useState(100); const [scaleL, setScaleL] = useState(4000); const [gratingUm, setGratingUm] = useState(3.333);
  const [aComplete, setAComplete] = useState(analyzeSignal > 0); const [bCalibrated, setBCalibrated] = useState(false); const [bUnknownComplete, setBUnknownComplete] = useState(false); const [ignoredUnknown, setIgnoredUnknown] = useState<number[]>([]);
  const [busy, setBusy] = useState<"a" | "reference" | "unknown" | null>(null); const [profileView, setProfileView] = useState<"reference" | "unknown">("reference");
  const [diagnosis, setDiagnosis] = useState<Record<ExperimentTask, string>>({ A: "", B: "" });
  const pendingImagesRef = useRef<PendingImages>({ A: {}, B: {} });

  const aImage = useMemo(() => aSource ? applyMercuryFiveLineModel(detectSpectrumPeaks(aSource, detector)) : null, [aSource, detector]);
  const bReferenceImage = useMemo(() => bReferenceSource ? applyMercuryFiveLineModel(detectSpectrumPeaks(bReferenceSource, detector)) : null, [bReferenceSource, detector]);
  const bUnknownImage = useMemo(() => bUnknownSource ? detectSpectrumPeaks(bUnknownSource, detector) : null, [bUnknownSource, detector]);
  const activeImage = task === "A" ? aImage : bReferenceImage; const activeMarkers = task === "A" ? aMarkers : bMarkers;

  useEffect(() => () => { if (aSource?.preview) URL.revokeObjectURL(aSource.preview); }, [aSource?.preview]);
  useEffect(() => () => { if (bReferenceSource?.preview) URL.revokeObjectURL(bReferenceSource.preview); }, [bReferenceSource?.preview]);
  useEffect(() => () => { if (bUnknownSource?.preview) URL.revokeObjectURL(bUnknownSource.preview); }, [bUnknownSource?.preview]);

  const loadSample = () => {
    sync.resetSync();
    const sample = buildSampleSource(); const positions = SPECTRAL_LIBRARY.mercury.map((line) => ({ wavelengthNm: line.wavelengthNm, xRatio: (100 + 4000 * Math.tan(Math.asin(line.wavelengthNm / 3333))) / sample.width }));
    setTask("A"); setASource(sample); setAMarkers(positions); setZeroX(100); setScaleL(4000); setAComplete(true); setSelectedWavelength(546.07);
  };
  const upload = async (kind: "a" | "reference" | "unknown", file?: File) => {
    if (!file) return; setBusy(kind);
    try {
      const source = await analyzeImageFile(file);
      const detected = detectSpectrumPeaks(source, detector);
      const analyzed = kind === "unknown" ? detected : applyMercuryFiveLineModel(detected);
      const automaticMarkers = autoMatchMercuryPeaks(analyzed);
      if (kind === "a") { pendingImagesRef.current.A.primary = file; setASource(source); setAMarkers(automaticMarkers); setZeroX(Math.round(source.width / 2)); setScaleL(Math.round(source.width * 4)); setAComplete(false); }
      if (kind === "reference") { pendingImagesRef.current.B.reference = file; setBReferenceSource(source); setBMarkers(automaticMarkers); setBCalibrated(false); setBUnknownComplete(false); setBUnknownSource(null); }
      if (kind === "unknown") { pendingImagesRef.current.B.unknown = file; setBUnknownSource(source); setBUnknownComplete(false); setIgnoredUnknown([]); setProfileView("unknown"); }
      toast.success(automaticMarkers.length === 5 ? "已检测并自动匹配 5 条汞灯谱线" : "图像读取完成，请复核并补充参考谱线");
    } catch (error) { toast.error(error instanceof Error ? error.message : "图像分析失败"); }
    finally { setBusy(null); }
  };

  const addMarker = (ratio: number) => {
    if (!activeImage) return;
    const clickedX = ratio * activeImage.width;
    const nearest = activeImage.peaks.reduce<Peak | null>((best, peak) => !best || Math.abs(peak.x - clickedX) < Math.abs(best.x - clickedX) ? peak : best, null);
    const xRatio = nearest && Math.abs(nearest.x - clickedX) <= detector.minDistancePx ? nearest.xRatio : ratio;
    const update = (items: ReferenceMarker[]) => [...items.filter((item) => item.wavelengthNm !== selectedWavelength), { wavelengthNm: selectedWavelength, xRatio }].sort((a, b) => a.xRatio - b.xRatio);
    if (task === "A") setAMarkers(update); else setBMarkers(update);
  };
  const removeMarker = (wavelengthNm: number) => task === "A" ? setAMarkers((items) => items.filter((item) => item.wavelengthNm !== wavelengthNm)) : setBMarkers((items) => items.filter((item) => item.wavelengthNm !== wavelengthNm));

  const aResult = useMemo(() => {
    if (!aComplete || !aImage || aMarkers.length < 4) return null;
    try {
      return fitGratingFromPixels(aMarkers.map((marker) => ({ wavelengthNm: marker.wavelengthNm, x: marker.xRatio * aImage.width })), aImage.width);
    } catch { return null; }
  }, [aComplete, aImage, aMarkers]);

  const bCalibration = useMemo(() => {
    if (!bCalibrated || bMarkers.length < 3) return null;
    if (Math.max(...bMarkers.map((item) => item.xRatio)) - Math.min(...bMarkers.map((item) => item.xRatio)) < .01) return null;
    try { return calibrateSpectrum(bMarkers.map((marker) => ({ wavelengthNm: marker.wavelengthNm, x: marker.xRatio })), gratingUm); } catch { return null; }
  }, [bCalibrated, bMarkers, gratingUm]);
  const bAspectOkay = !bReferenceImage || !bUnknownImage || Math.abs((bReferenceImage.width / bReferenceImage.height) / (bUnknownImage.width / bUnknownImage.height) - 1) <= .03;
  const unknownResults = useMemo<UnknownLineResult[]>(() => {
    if (!bUnknownComplete || !bCalibration || !bUnknownImage || !bAspectOkay) return [];
    const min = Math.min(...bMarkers.map((item) => item.wavelengthNm)), max = Math.max(...bMarkers.map((item) => item.wavelengthNm));
    return bUnknownImage.peaks.map((peak, index) => { const wavelengthNm = bCalibration.predict(peak.xRatio); const status: UnknownLineResult["status"] = wavelengthNm >= min && wavelengthNm <= max ? "范围内" : "外推"; return { index, x: peak.x, xRatio: peak.xRatio, wavelengthNm, uncertaintyNm: Math.max(.4, bCalibration.rmseNm), status }; }).filter((item) => !ignoredUnknown.includes(item.index));
  }, [bUnknownComplete, bCalibration, bUnknownImage, bAspectOkay, bMarkers, ignoredUnknown]);
  const bResiduals = useMemo(() => bCalibration ? bMarkers.map((marker) => ({ wavelengthNm: marker.wavelengthNm, predicted: bCalibration.predict(marker.xRatio), residual: bCalibration.predict(marker.xRatio) - marker.wavelengthNm })) : [], [bCalibration, bMarkers]);
  const hasResult = task === "A" ? Boolean(aResult) : Boolean(bCalibration);
  const resultRmse = task === "A" ? aResult?.rmseNm : bCalibration?.rmseNm;
  const status = !activeImage ? "待上传" : activeMarkers.length < (task === "A" ? 4 : 3) ? "待选线" : hasResult ? "已完成" : "可计算";

  const recordSnapshot = useMemo<RecordSnapshot>(() => {
    const resultValue = task === "A" && aResult
      ? `${aResult.dUm.toFixed(3)} ± ${aResult.uncertaintyUm.toFixed(3)} μm`
      : task === "B" && bCalibration ? `${unknownResults.length} 条未知谱线` : "进行中";
    const needsReview = Boolean(activeImage?.overexposed || (resultRmse ?? 0) > 1.5);
    const steps = activeImage ? ["图像读取", "强度提取", "峰值检测"] : [];
    if (hasResult) steps.push("物理计算");
    if (task === "B" && bUnknownComplete) steps.push("未知谱线分析");
    const payload = task === "A" ? {
      state: { detector, zeroX, scaleL, complete: aComplete, sample: Boolean(aSource?.sample) },
      referenceMarkers: aMarkers,
      result: aResult,
      processing: { peaks: aImage?.peaks.length ?? 0, overexposed: Boolean(aImage?.overexposed) },
    } : {
      state: { detector, gratingUm, calibrated: bCalibrated, unknownComplete: bUnknownComplete, ignoredUnknown },
      referenceMarkers: bMarkers,
      calibration: bCalibration ? { x0: bCalibration.x0, L: bCalibration.L, rmseNm: bCalibration.rmseNm } : null,
      residuals: bResiduals,
      unknownLines: unknownResults,
      processing: { referencePeaks: bReferenceImage?.peaks.length ?? 0, unknownPeaks: bUnknownImage?.peaks.length ?? 0, overexposed: Boolean(activeImage?.overexposed) },
    };
    return {
      task,
      source: task === "A" ? "汞灯" : "未知光源",
      resultLabel: task === "A" ? "光栅常数 d" : "未知波长 λ",
      resultValue,
      quality: !hasResult ? "进行中" : needsReview ? "需复核" : "优秀",
      status: !hasResult ? "draft" : needsReview ? "needs_review" : "completed",
      steps,
      diagnosis: diagnosis[task],
      payload,
    };
  }, [task, aResult, bCalibration, unknownResults, activeImage, resultRmse, hasResult, bUnknownComplete, detector, zeroX, scaleL, aComplete, aSource?.sample, aMarkers, aImage?.peaks.length, gratingUm, bCalibrated, ignoredUnknown, bMarkers, bResiduals, bReferenceImage?.peaks.length, bUnknownImage?.peaks.length, diagnosis]);

  const hydrateRecord = useCallback(async (record: SavedRecord) => {
    const state = record.payload.state && typeof record.payload.state === "object" ? record.payload.state as Record<string, unknown> : {};
    const markers = Array.isArray(record.payload.referenceMarkers) ? record.payload.referenceMarkers.filter((item): item is ReferenceMarker => Boolean(item) && typeof item === "object" && typeof (item as ReferenceMarker).wavelengthNm === "number" && typeof (item as ReferenceMarker).xRatio === "number") : [];
    const savedDetector = state.detector && typeof state.detector === "object" ? state.detector as Partial<DetectorOptions> : null;
    if (savedDetector && typeof savedDetector.prominence === "number" && typeof savedDetector.minDistancePx === "number") setDetector({ prominence: savedDetector.prominence, minDistancePx: savedDetector.minDistancePx });
    setDiagnosis((value) => ({ ...value, [record.task]: record.diagnosis }));
    if (record.task === "A") {
      setAMarkers(markers);
      if (typeof state.zeroX === "number") setZeroX(state.zeroX);
      if (typeof state.scaleL === "number") setScaleL(state.scaleL);
      setAComplete(Boolean(state.complete));
      if (state.sample) setASource(buildSampleSource());
      else setASource(record.imageUrls.primary ? await sourceFromSyncedImage(record.imageUrls.primary).catch(() => null) : null);
    } else {
      setBMarkers(markers);
      if (typeof state.gratingUm === "number") setGratingUm(state.gratingUm);
      setBCalibrated(Boolean(state.calibrated));
      setBUnknownComplete(Boolean(state.unknownComplete));
      setIgnoredUnknown(Array.isArray(state.ignoredUnknown) ? state.ignoredUnknown.filter((item): item is number => typeof item === "number") : []);
      const [reference, unknown] = await Promise.all([
        record.imageUrls.reference ? sourceFromSyncedImage(record.imageUrls.reference).catch(() => null) : null,
        record.imageUrls.unknown ? sourceFromSyncedImage(record.imageUrls.unknown).catch(() => null) : null,
      ]);
      setBReferenceSource(reference);
      setBUnknownSource(unknown);
    }
  }, []);

  const sync = useExperimentSync({ task, enabled: Boolean(activeImage), snapshot: recordSnapshot, pendingImagesRef, onRemoteRecord: hydrateRecord });
  const syncLabel = sync.phase === "loading" ? "正在读取云端记录" : sync.phase === "pending" ? "有更改待同步" : sync.phase === "saving" ? "正在同步" : sync.phase === "retrying" ? "同步失败，正在重试" : sync.phase === "error" ? "同步失败" : sync.phase === "synced" && sync.lastSyncedAt ? `已同步 ${new Date(sync.lastSyncedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "自动同步已就绪";

  const runPrimary = () => {
    if (!activeImage) return toast.warning("请先上传光谱照片");
    if (activeMarkers.length < (task === "A" ? 4 : 3)) return toast.warning(task === "A" ? "自动几何拟合至少需要 4 条参考谱线，建议使用完整 5 条" : "至少标记 3 条有效参考谱线");
    if (task === "A") setAComplete(true);
    else setBCalibrated(true);
  };
  const resetTask = () => {
    sync.resetSync();
    setDiagnosis((value) => ({ ...value, [task]: "" }));
    setDetector({ prominence: .018, minDistancePx: 3 }); setSelectedWavelength(546.07);
    if (task === "A") { setASource(null); setAMarkers([]); setZeroX(100); setScaleL(4000); setAComplete(false); }
    else { setBReferenceSource(null); setBUnknownSource(null); setBMarkers([]); setGratingUm(3.333); setBCalibrated(false); setBUnknownComplete(false); setIgnoredUnknown([]); }
  };
  const visibleProfile = task === "A" ? aImage : profileView === "reference" ? bReferenceImage : bUnknownImage;
  const summary = task === "A" ? [
    ["候选峰", `${aImage?.peaks.length ?? 0} 条`], ["参考标记", `${aMarkers.length} 条`], ["光栅常数 d", aResult ? `${aResult.dUm.toFixed(3)} μm` : "—"], ["拟合 RMSE", aResult ? `${aResult.rmseNm.toFixed(3)} nm` : "—"],
  ] : [
    ["参考峰", `${bReferenceImage?.peaks.length ?? 0} 条`], ["参考标记", `${bMarkers.length} 条`], ["未知谱线", `${unknownResults.length} 条`], ["标定 RMSE", bCalibration ? `${bCalibration.rmseNm.toFixed(3)} nm` : "—"],
  ];

  return <div className="module-page analysis-page">
    <PageHeading eyebrow="实验 · 图像分析工作台" title="从光谱照片到可复核的测量结果。" description="调整检测参数、标记参考谱线，再沿强度曲线、拟合残差和处理过程检查每一步。" action={<Tabs value={task} onValueChange={(value) => setTask(value as "A" | "B")}><TabsList className="task-switch"><TabsTrigger value="A"><span>A</span>测光栅常数 d</TabsTrigger><TabsTrigger value="B"><span>B</span>测未知波长 λ</TabsTrigger></TabsList></Tabs>} />
    <div className="analysis-workbench">
      <aside className="panel parameter-panel"><div className="analysis-card-heading"><span><SlidersHorizontal size={18} /></span><div><h2>{task === "A" ? "测量参数" : "标定参数"}</h2><p>{task === "A" ? "由全部参考线联合优化 x₀、L 与 d。" : "d 作为已知约束，不参与反演。"}</p></div></div><div className="parameter-form">
        {task === "A" ? <><label>零级位置 x₀（自动优化）<input type="number" value={aResult ? Number(aResult.x0.toFixed(1)) : zeroX} onChange={(event) => setZeroX(Number(event.target.value))} disabled={Boolean(aResult)} /></label><label>成像尺度 L（自动优化）<input type="number" min="1" step="10" value={aResult ? Number(aResult.L.toFixed(1)) : scaleL} onChange={(event) => setScaleL(Number(event.target.value))} disabled={Boolean(aResult)} /></label></> : <label>光栅常数 d（μm）<input type="number" min=".1" step=".001" value={gratingUm} onChange={(event) => setGratingUm(Number(event.target.value))} /></label>}
        <label>峰值突出度 <output>{detector.prominence.toFixed(3)}</output><input type="range" min=".005" max=".2" step=".005" value={detector.prominence} onChange={(event) => setDetector((value) => ({ ...value, prominence: Number(event.target.value) }))} /></label>
        <label>最小峰间距（px）<input type="number" min="2" max="64" value={detector.minDistancePx} onChange={(event) => setDetector((value) => ({ ...value, minDistancePx: Math.min(64, Math.max(2, Number(event.target.value))) }))} /></label>
        <div className="parameter-buttons"><button className="reset-button parameter-reset" onClick={resetTask}><RotateCcw size={15} />恢复默认</button>{task === "A" && <button className="reset-button parameter-reset sample-button" onClick={loadSample}><Play size={15} />加载示例</button>}</div>
      </div></aside>
      <section className="panel calibration-panel"><div className="analysis-card-heading wide"><span><Waves size={18} /></span><div><h2>{task === "A" ? "光栅常数反演" : "汞灯参考标定"}</h2><p>{task === "A" ? "汞灯参考锁定五线；底层检测器可自适应任意数量谱线。" : "先用汞灯五线标定，再检测未知图中的任意谱线。"}</p></div><em className={`analysis-status ${status === "已完成" ? "done" : ""}`}>{status}</em></div>
        <SpectrumStage image={activeImage} markers={activeMarkers} onMark={addMarker} caption={activeImage?.sample ? "示例图像 · 一级汞灯光谱" : "参考图像 · 已完成强度提取"} />
        <MarkerPicker selected={selectedWavelength} setSelected={setSelectedWavelength} markers={activeMarkers} onClear={() => task === "A" ? setAMarkers([]) : setBMarkers([])} onRemove={removeMarker} image={activeImage} onCandidate={addMarker} />
        <div className="analysis-actions"><label className="upload-button"><Upload size={17} />上传照片<input type="file" accept="image/*" hidden onChange={(event) => upload(task === "A" ? "a" : "reference", event.target.files?.[0])} /></label><label className="camera-button"><Camera size={17} />手机拍摄<input type="file" accept="image/*" capture="environment" hidden onChange={(event) => upload(task === "A" ? "a" : "reference", event.target.files?.[0])} /></label><button className="analyze-button" disabled={Boolean(busy)} onClick={runPrimary}><Play size={17} />{busy ? "处理中…" : task === "A" ? "执行测量" : "执行标定"}</button></div>
        {activeImage && <div className="quality-row"><span><i />谱带宽度 {activeImage.bandWidth}px</span><span><i />候选峰 {activeImage.peaks.length} 条</span><span><i className={activeImage.overexposed ? "warn" : ""} />{activeImage.overexposed ? "高光偏多，建议降低曝光" : "曝光正常"}</span></div>}
        {task === "A" && aImage && aImage.peaks.length < 5 && <p className="inline-warning"><CircleAlert size={15} />当前只检测到 {aImage.peaks.length} 条候选峰；请降低突出度或确认黄双线清晰可分。</p>}
        {task === "A" && aResult && aResult.rmseNm > 2 && <p className="inline-warning"><CircleAlert size={15} />拟合 RMSE 为 {aResult.rmseNm.toFixed(2)} nm，疑似参考线配对错误，请复核标记后重新执行。</p>}
        {task === "B" && bCalibration && <div className="unknown-stage-block"><div><span className="step-index">02</span><div><h3>未知光谱分析</h3><p>保持相同机位、焦距、方向和裁剪，再上传未知光源照片。</p></div></div><SpectrumStage image={bUnknownImage} caption="未知光谱 · 候选峰已检测" /><div className="analysis-actions"><label className="upload-button"><Upload size={17} />上传未知光谱<input type="file" accept="image/*" hidden onChange={(event) => upload("unknown", event.target.files?.[0])} /></label><button className="analyze-button" disabled={!bUnknownImage || Boolean(busy) || !bAspectOkay} onClick={() => { setBUnknownComplete(true); setProfileView("unknown"); }}><ScanLine size={17} />分析未知谱线</button></div>{bUnknownImage && !bAspectOkay && <p className="inline-warning"><CircleAlert size={15} />两张照片画幅比例差异超过 3%，请使用相同拍摄设置重新拍摄。</p>}</div>}
      </section>
    </div>
    <section className="panel overview-panel"><div><h2>结果总览</h2><p>{hasResult ? "关键参数、最终结果与残差会自动同步。" : "上传图片后即开始保存实验过程，完成计算后自动更新结果。"}</p><span className={`sync-state ${sync.phase}`} aria-live="polite">{sync.phase === "error" ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}{syncLabel}</span>{sync.phase === "error" && sync.errorMessage && <small className="sync-error">{sync.errorMessage}</small>}</div><div className="overview-metrics">{summary.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div><button className="secondary-action" onClick={() => void sync.syncNow()} disabled={!activeImage || sync.phase === "saving" || sync.phase === "retrying"}><Save size={16} />{sync.phase === "error" ? "立即重试" : "立即同步"}</button></section>
    <section className="panel review-note-panel"><div className="analysis-card-heading"><span><ClipboardCheck size={18} /></span><div><h2>异常诊断与复核意见</h2><p>记录异常现象、可能原因和复核结论；输入内容会随实验记录自动同步。</p></div></div><textarea value={diagnosis[task]} maxLength={2000} onChange={(event) => setDiagnosis((value) => ({ ...value, [task]: event.target.value }))} placeholder="例如：黄色双线未完全分离，已重新调整狭缝并复测。" /></section>
    <div className="analysis-results-grid">
      <section className="panel intensity-panel"><div className="analysis-card-heading wide"><span><Waves size={18} /></span><div><h2>强度剖面与谱线标注</h2><p>曲线、候选峰和人工参考标记来自当前图像数据。</p></div>{task === "B" && bUnknownImage && <div className="profile-switch"><button className={profileView === "reference" ? "active" : ""} onClick={() => setProfileView("reference")}>汞灯参考</button><button className={profileView === "unknown" ? "active" : ""} onClick={() => setProfileView("unknown")}>未知光谱</button></div>}</div><IntensityChart image={visibleProfile} markers={task === "B" && profileView === "unknown" ? [] : activeMarkers} title="光谱横向强度剖面" /></section>
      <div className="analysis-result-stack"><section className="panel final-result-card"><div className="analysis-card-heading"><span><BarChart3 size={18} /></span><div><h2>{task === "A" ? "最终光栅结果" : "最终波长结果"}</h2><p>{task === "A" ? "亚像素定位、几何拟合与镜头像差校正。" : "列出未知图中的全部有效谱线。"}</p></div></div>{task === "A" ? aResult ? <div className="final-measure"><small>光栅常数 d</small><strong>{aResult.dUm.toFixed(3)} <em>± {aResult.uncertaintyUm.toFixed(3)} μm</em></strong><p>{aResult.linesPerMm.toFixed(1)} 线/mm · RMSE {aResult.rmseNm.toFixed(3)} nm</p><p>拟合 x₀ = {aResult.x0.toFixed(1)} px · L = {aResult.L.toFixed(1)} px/rad</p></div> : <div className="result-placeholder"><FlaskConical size={28} /><span>等待执行测量</span></div> : unknownResults.length ? <div className="unknown-results">{unknownResults.map((item) => <div key={item.index}><i style={{ background: bUnknownImage?.peaks[item.index]?.color }} /><span><strong>{item.wavelengthNm.toFixed(1)} nm</strong><small>x = {item.x}px · ±{item.uncertaintyNm.toFixed(1)} nm</small></span><em className={item.status === "外推" ? "warning" : ""}>{item.status}</em><button aria-label={`忽略 ${item.wavelengthNm.toFixed(1)} nm 谱线`} onClick={() => setIgnoredUnknown((items) => [...items, item.index])}>×</button></div>)}</div> : <div className="result-placeholder"><FlaskConical size={28} /><span>{bCalibration ? "等待上传并分析未知光谱" : "等待完成汞灯标定"}</span></div>}</section>
        <section className="panel residual-card"><div className="analysis-card-heading"><span><Target size={18} /></span><div><h2>{task === "A" ? "拟合残差复核" : "标定残差复核"}</h2><p>逐条检查预测值与参考值。</p></div></div>{task === "A" && aResult ? <div className="residual-table"><div><b>标准 λ</b><b>换算 θ</b><b>残差</b></div>{aResult.points.map((point) => <div key={point.wavelengthNm}><span>{point.wavelengthNm.toFixed(2)} nm</span><span>{point.thetaDeg.toFixed(3)}°</span><strong>{point.residualNm >= 0 ? "+" : ""}{point.residualNm.toFixed(3)} nm</strong></div>)}</div> : task === "B" && bResiduals.length ? <div className="residual-table"><div><b>标准 λ</b><b>预测 λ</b><b>残差</b></div>{bResiduals.map((item) => <div key={item.wavelengthNm}><span>{item.wavelengthNm.toFixed(2)}</span><span>{item.predicted.toFixed(2)}</span><strong>{item.residual >= 0 ? "+" : ""}{item.residual.toFixed(3)} nm</strong></div>)}</div> : <div className="result-placeholder compact"><Target size={25} /><span>完成计算后显示逐线残差</span></div>}</section></div>
    </div>
    <section className="panel process-panel"><div className="analysis-card-heading wide"><span><SlidersHorizontal size={18} /></span><div><h2>图像处理全过程</h2><p>从原始照片到物理结果，每一步都保留可复核的实际数据。</p></div></div><ProcessingTimeline image={task === "A" ? aImage : bReferenceImage} selectedCount={activeMarkers.length} resultText={task === "A" && aResult ? `d = ${aResult.dUm.toFixed(3)} μm` : bCalibration ? `RMSE ${bCalibration.rmseNm.toFixed(3)} nm` : "等待执行计算"} /></section>
  </div>;
}

const guideSteps = [
  { title: "调光路", detail: "调节狭缝、平行光管和望远镜，使叉丝、狭缝像与谱线清晰且无视差。", check: "上下移动眼睛，叉丝与狭缝像不应相对移动。", image: "/guide/01-align-optics.jpg", alt: "实验人员正在调节分光计的望远镜、载物台与棱镜", position: "center 42%", credit: "SAHAYA RAJAN S · CC0", source: "https://commons.wikimedia.org/wiki/File:Spectrometer_prism_table.jpg" },
  { title: "找零级", detail: "望远镜对准中央零级像，记录左右游标初始读数，作为角度参考。", check: "零级像位于叉丝竖线中央。", image: "/guide/02-zero-order.jpg", alt: "物理实验室中的光学实验台组件与叉丝靶", position: "center 48%", credit: "Waifer X · CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Optical_Bench_educational_Kit_-_Cuesta_College.jpg" },
  { title: "逐线瞄准", detail: "从短波到长波依次转动望远镜，黄双线必须分开对准。", check: "每条谱线至少重复瞄准两次。", image: "/guide/03-aim-lines.jpg", alt: "实验室光栅产生的真实可见光谱", position: "center 47%", credit: "NOIRLab / NSF / AURA · CC BY 4.0", source: "https://commons.wikimedia.org/wiki/File:Diffraction_grating_(noao-02613).jpg" },
  { title: "读数", detail: "主尺读整度，游标读分；左右游标相差应接近 180°，注意越零处理。", check: "读数后立即记录，不凭记忆补填。", image: "/guide/04-read-vernier.jpg", alt: "分光计主尺与游标的实拍特写", position: "center 47%", credit: "Neakhu · CC BY-SA 3.0", source: "https://commons.wikimedia.org/wiki/File:Physics_019.jpg" },
  { title: "计算", detail: "以左右位置的半差求衍射角，再用 λ=d·sinθ 过原点加权拟合。", check: "先检查单位：nm、μm 与弧度。", image: "/guide/05-calculate.jpg", alt: "实验室电脑中正在计算数据并绘制拟合曲线", position: "center 44%", credit: "MikeRun · CC BY-SA 4.0", source: "https://commons.wikimedia.org/wiki/File:Lab-notebook-spreadsheet-simulation.jpg" },
  { title: "不确定度", detail: "合成波长、角分度与重复测量分量，报告扩展不确定度 U，k=2。", check: "结果写成 d ± U，并保留相同小数位。", image: "/guide/06-uncertainty.jpg", alt: "两位实验人员对照图表复核分析结果", position: "center 52%", credit: "Linda Bartlett / NCI · Public domain", source: "https://commons.wikimedia.org/wiki/File:Scientists_examine_a_graph.jpg" },
];

function GuideModule() {
  const [step, setStep] = useState(0); const [done, setDone] = useState<number[]>([]);
  const current = guideSteps[step];
  return <div className="module-page"><PageHeading eyebrow="实验 · 分步引导" title="每完成一步，都留下一个可检查的证据。" description="按真实实验顺序推进；点击“完成并继续”后，当前步骤会写入进度。" />
    <div className="guide-grid"><aside className="panel step-list">{guideSteps.map((item, index) => <button key={item.title} className={`${step === index ? "active" : ""} ${done.includes(index) ? "done" : ""}`} onClick={() => setStep(index)}><span>{done.includes(index) ? <Check size={16} /> : index + 1}</span><div><strong>{item.title}</strong><small>{index === step ? "正在进行" : done.includes(index) ? "已完成" : "待完成"}</small></div><ChevronRight size={16} /></button>)}</aside>
      <section className="panel guide-detail"><figure className="guide-visual"><Image key={current.image} src={current.image} alt={current.alt} fill priority={step === 0} sizes="(max-width: 1100px) 100vw, 50vw" style={{ objectPosition: current.position }} /><div className="guide-photo-shade" aria-hidden="true" /><span>STEP {String(step + 1).padStart(2, "0")}</span><figcaption><span>真实实验照片</span><a href={current.source} target="_blank" rel="noreferrer">{current.credit}</a></figcaption></figure><div className="guide-copy"><p className="eyebrow">当前步骤</p><h2>{current.title}</h2><p>{current.detail}</p><div className="checkpoint"><ClipboardCheck size={19} /><div><strong>检查点</strong><span>{current.check}</span></div></div><div className="guide-actions"><button className="secondary-action" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}><ArrowLeft size={16} />上一步</button><button className="primary-action" onClick={() => { setDone((items) => [...new Set([...items, step])]); if (step < 5) setStep(step + 1); else toast.success("实验流程已完成，可以进入记录复盘"); }}>完成并继续<ArrowRight size={16} /></button></div></div></section>
      <aside className="panel guide-side"><div><Lightbulb size={20} /><strong>本步为什么重要？</strong><p>{["光路未调好会让谱线变宽，后续认线再准确也无法弥补。", "零级偏移会让所有谱线产生同方向系统误差。", "固定顺序可以避免认错线，尤其是黄色双线。", "游标读数是任务 A 的角度来源，图像不替代学生读数。", "多线拟合比逐线平均更能利用全部证据。", "不确定度说明结果可信到什么程度，不是装饰项。"][step]}</p></div><div className="progress-block"><span>实验进度 <strong>{Math.round(done.length / 6 * 100)}%</strong></span><Progress value={done.length / 6 * 100} /></div></aside></div>
  </div>;
}

function RecordsModule() {
  const [records, setRecords] = useState<SavedRecord[]>([]); const [loading, setLoading] = useState(true); const [selected, setSelected] = useState<SavedRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState(""); const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    try {
      const { records: latest } = await requestRecordJson<{ records: SavedRecord[] }>("/api/records?limit=100", undefined, 2);
      setRecords(latest);
      setSelected((current) => current ? latest.find((record) => record.id === current.id) ?? latest[0] ?? null : latest[0] ?? null);
      setLastUpdated(Date.now()); setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "实验记录读取失败");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(interval); window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  const exportCsv = () => { const rows = [["最后更新", "任务", "光源", "状态", "结果", "质量"], ...records.map((r) => [new Date(r.updatedAt).toLocaleString("zh-CN"), r.task, r.source, r.status === "draft" ? "进行中" : r.status === "needs_review" ? "需复核" : "已完成", r.resultValue, r.quality])]; downloadFile("spectra-experiments.csv", rows.map((row) => row.map((v) => `"${String(v).replaceAll('"','""')}"`).join(",")).join("\n"), "text/csv"); };
  const exportReport = () => { if (!selected) return; downloadFile(`spectra-${selected.id}.md`, `# 分光计实验报告\n\n- 创建时间：${new Date(selected.createdAt).toLocaleString("zh-CN")}\n- 最后更新：${new Date(selected.updatedAt).toLocaleString("zh-CN")}\n- 任务：${selected.task}\n- 光源：${selected.source}\n- 结果：${selected.resultValue}\n- 质量：${selected.quality}\n\n## 操作步骤\n\n${selected.steps.length ? selected.steps.map((step) => `- ${step}`).join("\n") : "暂无已完成步骤"}\n\n## 异常诊断与复核意见\n\n${selected.diagnosis || "未填写"}`, "text/markdown"); };
  const markerCount = Array.isArray(selected?.payload.referenceMarkers) ? selected.payload.referenceMarkers.length : 0;
  const imageEntries = selected ? Object.entries(selected.imageUrls) as [ExperimentImageSlot, string][] : [];
  return <div className="module-page"><PageHeading eyebrow="课后 · 实验记录与复盘" title="结果不是终点，证据链才是。" description="打开一次记录，按“预处理—检测—匹配—拟合—诊断”回看；支持导出 CSV 与实验报告。" action={<button className="secondary-action" onClick={exportCsv} disabled={!records.length}><Download size={16} />导出全部 CSV</button>} />
    <div className={`records-sync ${errorMessage ? "error" : ""}`} aria-live="polite">{errorMessage ? <><CircleAlert size={15} /><span>{errorMessage}</span><button onClick={() => void refresh()}>重新加载</button></> : <><CheckCircle2 size={15} /><span>{lastUpdated ? `云端记录已更新 · ${new Date(lastUpdated).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "正在连接云端记录"}</span></>}</div>
    <div className="records-grid"><section className="panel record-list"><div className="panel-title"><div><span className="step-index"><History size={14} /></span><h2>我的实验</h2></div><span>{records.length} 条</span></div>{loading ? <div className="record-empty">正在读取实验记录…</div> : records.length ? records.map((record) => <button key={record.id} className={selected?.id === record.id ? "active" : ""} onClick={() => setSelected(record)}><span className="record-source"><Waves size={18} /></span><div><strong>{record.resultLabel}<small>{record.resultValue}</small></strong><p><Clock3 size={12} />{new Date(record.updatedAt).toLocaleString("zh-CN")} · {record.source}</p></div><em className={record.status === "completed" ? "good" : ""}>{record.status === "draft" ? "进行中" : record.status === "needs_review" ? "需复核" : "已完成"}</em></button>) : <div className="record-empty"><History size={30} /><strong>还没有实验记录</strong><p>上传光谱图片后，实验过程会自动同步并出现在这里。</p></div>}</section>
      <section className="panel replay-panel">{selected ? <><div className="replay-head"><div><p className="eyebrow">实验回放 · 版本 {selected.version}</p><h2>{selected.resultLabel} · {selected.resultValue}</h2><small>最后同步于 {new Date(selected.updatedAt).toLocaleString("zh-CN")}</small></div><button className="secondary-action" onClick={exportReport}><FileText size={16} />导出报告</button></div><div className="record-evidence"><span><small>已完成步骤</small><strong>{selected.steps.length} 项</strong></span><span><small>参考谱线</small><strong>{markerCount} 条</strong></span><span><small>记录状态</small><strong>{selected.quality}</strong></span></div>{imageEntries.length > 0 && <div className="record-images">{imageEntries.map(([slot, url]) => <figure key={slot}><Image src={url} alt={slot === "unknown" ? "未知光谱原始图片" : "参考光谱原始图片"} width={800} height={450} unoptimized /><figcaption>{slot === "unknown" ? "未知光谱" : slot === "reference" ? "参考光谱" : "原始光谱"}</figcaption></figure>)}</div>}<div className="timeline">{selected.steps.length ? selected.steps.map((step, index) => <div className="timeline-item" key={step}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{step}</strong><p>{step === "物理计算" ? `${selected.resultLabel} = ${selected.resultValue}` : "该步骤的参数和结果已保存到云端记录。"}</p></div>{index < selected.steps.length - 1 && <i />}</div>) : <div className="record-empty compact"><History size={28} /><strong>实验尚未开始</strong></div>}</div><div className="record-diagnosis"><strong>异常诊断与复核意见</strong><p>{selected.diagnosis || "未填写异常诊断或复核意见。"}</p></div></> : <div className="record-empty"><Microscope size={34} /><strong>选择一条记录开始回放</strong></div>}</section></div>
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
  return <main className={`app-shell ${active === "home" ? "" : "module-ambient"}`}><AppHeader active={active} onChange={setActive} />{active === "home" && <HomeModule navigate={setActive} />}{active === "simulator" && <SimulatorModule />}{active === "assistant" && <AssistantModule />}{active === "analysis" && <AnalysisModule key={analyzeSignal} analyzeSignal={analyzeSignal} />}{active === "guide" && <GuideModule />}{active === "records" && <RecordsModule />}<footer><span><Aperture size={16} />SPECTRA · AI 分光计实验学习助手</span></footer><Toaster position="top-center" richColors /></main>;
}
