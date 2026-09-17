"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Aperture, ArrowLeft, ArrowRight, BarChart3, BookOpen, Bot, Camera,
  CheckCircle2, ChevronRight, CircleAlert, CircleHelp, ClipboardCheck, Clock3,
  Download, ExternalLink, FileText, FlaskConical, History, Home,
  LogIn, LogOut, MessageCircle, Microscope, Play, RotateCcw, Save,
  ScanLine, Send, SlidersHorizontal, Target, Telescope, Upload, Users, Waves,
} from "lucide-react";
import { toast } from "sonner";
import Image from "next/image";
import { Toaster } from "@/components/ui/sonner";
import AssistantAnswer from "./AssistantAnswer";
import AuroraField from "./AuroraField";
import FloatingAssistant from "./FloatingAssistant";
import {
  measureGrating,
  SPECTRAL_LIBRARY,
} from "@/lib/spectrometer";
import {
  RecordRequestError, requestRecordJson, type ExperimentImageSlot,
  type ExperimentTask, type RecordSnapshot, type SavedRecord,
} from "@/lib/experiment-record";
import { emptyJourney, mergeJourney, type ExperimentJourney } from "@/lib/experiment-journey";

const VirtualSpectrometer3D = dynamic(() => import("./VirtualSpectrometer3D"), {
  ssr: false,
  loading: () => <div className="virtual-lab-loading"><Telescope size={28} /><strong>正在加载三维分光计</strong><span>仪器模型与实时光路准备中…</span></div>,
});

type ModuleId = "home" | "simulator" | "assistant" | "analysis" | "records";
type Peak = { x: number; xRatio: number; family: string; color: string; confidence: number; prominence: number; widthPx: number; wavelengthNm?: number };
type DetectorOptions = { prominence: number; minDistancePx: number };
type SpectrumSource = {
  preview: string | null; fileName: string; width: number; height: number;
  rawIntensity: number[]; luminanceIntensity: number[]; chromaIntensity: number[]; red: number[]; green: number[]; blue: number[];
  overexposed: boolean; sharpnessOk: boolean; tilt: number; bandWidth: number; sample?: boolean;
};
type ImageAnalysis = SpectrumSource & { smoothIntensity: number[]; peaks: Peak[] };
type ReferenceMarker = { wavelengthNm: number; xRatio: number };
const CHINA_TIME_ZONE = "Asia/Shanghai";
const formatChinaDateTime = (value: string | number) => new Date(value).toLocaleString("zh-CN", { timeZone: CHINA_TIME_ZONE, hour12: false });
const formatChinaClock = (value: string | number) => new Date(value).toLocaleTimeString("zh-CN", { timeZone: CHINA_TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const navItems: { id: ModuleId; label: string; icon: typeof Home }[] = [
  { id: "home", label: "首页", icon: Home },
  { id: "simulator", label: "虚拟分光计", icon: Telescope },
  { id: "analysis", label: "图像分析", icon: ScanLine },
  { id: "assistant", label: "互动课堂", icon: Users },
  { id: "records", label: "实验记录", icon: History },
];

const analysisPipeline = [
  { title: "图像校正", detail: "倾斜 0.7°", icon: SlidersHorizontal },
  { title: "峰值检测", detail: "自适应条数", icon: Waves },
  { title: "谱线匹配", detail: "Hg-I · 97.6%", icon: Target },
  { title: "波长反演", detail: "未知 λ", icon: BarChart3 },
];

const degreesFromReading = (value: string) => {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && Math.abs(parsed) <= 360 ? parsed : null;
};

const circularAngleDifferenceDeg = (readingDeg: number, zeroDeg: number) => {
  const signedDifference = ((readingDeg - zeroDeg + 540) % 360) - 180;
  return Math.abs(signedDifference);
};

const lineReadingKey = (wavelengthNm: number) => wavelengthNm.toFixed(2);

function sampleVernierReadings(zeroReadingDeg = 120) {
  // The demonstration mirrors a 1′ vernier; it must not present a synthetic
  // zero-residual result as if it were an experimental measurement.
  const leastCountDeg = 1 / 60;
  return Object.fromEntries(SPECTRAL_LIBRARY.mercury.map((line) => {
    const theta = Math.asin(line.wavelengthNm / 3333.333) * 180 / Math.PI;
    return [lineReadingKey(line.wavelengthNm), (zeroReadingDeg + Math.round(theta / leastCountDeg) * leastCountDeg).toFixed(4)];
  }));
}

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
  const leftIndexes = Array.from({ length: radius - 3 }, (_, offset) => index - radius + offset)
    .filter((sample) => sample >= 0 && sample < source.width);
  const rightIndexes = Array.from({ length: radius - 3 }, (_, offset) => index + 4 + offset)
    .filter((sample) => sample >= 0 && sample < source.width);
  const mean = (channel: number[], indexes: number[]) => indexes.reduce((sum, sample) => sum + (channel[sample] ?? 0), 0) / Math.max(indexes.length, 1);
  // Use the cleaner side as background. Averaging both sides lets a close
  // neighbour contaminate colour estimation and can turn a yellow line green.
  const background = (channel: number[]) => Math.min(mean(channel, leftIndexes), mean(channel, rightIndexes));
  const core = (channel: number[]) => [index - 1, index, index + 1]
    .filter((sample) => sample >= 0 && sample < source.width)
    .reduce((sum, sample) => sum + (channel[sample] ?? 0), 0) / 3;
  const r = Math.max(0, core(source.red) - background(source.red));
  const g = Math.max(0, core(source.green) - background(source.green));
  const b = Math.max(0, core(source.blue) - background(source.blue));
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
      const lo = Math.ceil(Math.min(near.x, candidate.x));
      const hi = Math.floor(Math.max(near.x, candidate.x));
      const valley = smooth.slice(lo, hi + 1).reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
      const separated = Math.min(near.score, candidate.score) - valley > Math.max(.003, requiredProminence * .18);
      // Resolved close lines are meaningful in every colour family. Generic
      // NMS must suppress duplicate noise peaks, not merge a real doublet.
      const plausibleWidths = near.widthPx >= 1.5 && candidate.widthPx >= 1.5;
      if (separated && plausibleWidths) selected.push(candidate);
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
  if (image.peaks.length < 2) return [];
  const peaks = [...image.peaks].sort((a, b) => a.x - b.x).slice(0, 16);
  const lines = [...SPECTRAL_LIBRARY.mercury].sort((a, b) => a.wavelengthNm - b.wavelengthNm);
  const best: { value: { score: number; markers: ReferenceMarker[]; count: number } | null } = { value: null };

  const evaluate = (chosenPeaks: Peak[], chosenLines: typeof lines) => {
      for (const direction of [1, -1]) {
        const mappedLines = direction === 1 ? chosenLines : [...chosenLines].reverse();
        let score = 0;
        for (let index = 0; index < chosenPeaks.length; index++) {
          const expected = mappedLines[index].family;
          const actual = chosenPeaks[index].family;
          // Reticles may be geometrically prominent, but do not carry the hue
          // of a mercury line. Keep blue/violet tolerant and make the green
          // line and yellow doublet strict colour matches.
          const familyPenalty = expected === actual ? 0 :
            ((expected === "violet" && actual === "blue") || (expected === "blue" && actual === "violet")) ? .7 : 12;
          score += familyPenalty + (1 - chosenPeaks[index].confidence) * .45;
        }
        // The mercury yellow doublet should be adjacent and relatively close.
        const yellow = chosenPeaks.filter((_, index) => mappedLines[index].family === "yellow");
        if (yellow.length === 2) score += Math.min(2, Math.abs(yellow[1].x - yellow[0].x) / Math.max(image.width * .08, 1));
        const meanWavelength = mappedLines.reduce((sum, line) => sum + line.wavelengthNm, 0) / mappedLines.length;
        const meanX = chosenPeaks.reduce((sum, peak) => sum + peak.x, 0) / chosenPeaks.length;
        const covariance = chosenPeaks.reduce((sum, peak, index) => sum + (mappedLines[index].wavelengthNm - meanWavelength) * (peak.x - meanX), 0);
        const variance = mappedLines.reduce((sum, line) => sum + (line.wavelengthNm - meanWavelength) ** 2, 0);
        const slope = covariance / Math.max(variance, 1e-9);
        const geometryRmsePx = Math.sqrt(chosenPeaks.reduce((sum, peak, index) => {
          const predictedX = meanX + slope * (mappedLines[index].wavelengthNm - meanWavelength);
          return sum + (peak.x - predictedX) ** 2;
        }, 0) / chosenPeaks.length);
        score += geometryRmsePx / Math.max(image.width * .008, 1);
        const markers = chosenPeaks.map((peak, index) => ({ wavelengthNm: mappedLines[index].wavelengthNm, xRatio: peak.xRatio }));
        const normalizedScore = score / chosenPeaks.length;
        if (!best.value || chosenPeaks.length > best.value.count || (chosenPeaks.length === best.value.count && normalizedScore < best.value.score)) {
          if (normalizedScore < 1) best.value = { score: normalizedScore, markers, count: chosenPeaks.length };
        }
      }
  };
  const choose = <T,>(items: T[], count: number, callback: (chosen: T[]) => void, start = 0, chosen: T[] = []) => {
    if (chosen.length === count) return callback(chosen);
    for (let index = start; index <= items.length - (count - chosen.length); index++) choose(items, count, callback, index + 1, [...chosen, items[index]]);
  };
  for (let count = Math.min(lines.length, peaks.length); count >= 2; count--) {
    choose(lines, count, (chosenLines) => choose(peaks, count, (chosenPeaks) => evaluate(chosenPeaks, chosenLines)));
    if (best.value?.count === count) break;
  }
  const winner = best.value;
  return winner ? winner.markers.sort((a, b) => a.xRatio - b.xRatio) : [];
}

function buildSampleSource(): SpectrumSource {
  const width = 1000, height = 560;
  const positions = SPECTRAL_LIBRARY.mercury.map((line) => Math.round(100 + 4000 * Math.tan(Math.asin(line.wavelengthNm / 3333))));
  const rawIntensity = Array.from({ length: width }, (_, x) => {
    const signal = positions.reduce((sum, position, index) => sum + SPECTRAL_LIBRARY.mercury[index].intensity * Math.exp(-((x - position) ** 2) / 18), 0);
    return Math.min(1, .025 + signal);
  });
  const chromaIntensity = [...rawIntensity];
  const luminanceIntensity = rawIntensity.map((value, x) => Math.min(1, value + .92 * Math.exp(-((x - 100) ** 2) / 14)));
  const red = new Array(width).fill(28), green = new Array(width).fill(42), blue = new Array(width).fill(58);
  positions.forEach((position, index) => {
    const hex = SPECTRAL_LIBRARY.mercury[index].color;
    red[position] = Number.parseInt(hex.slice(1, 3), 16); green[position] = Number.parseInt(hex.slice(3, 5), 16); blue[position] = Number.parseInt(hex.slice(5, 7), 16);
  });
  return { preview: null, fileName: "一级单侧汞谱示例", width, height, rawIntensity, luminanceIntensity, chromaIntensity, red, green, blue, overexposed: false, sharpnessOk: true, tilt: .7, bandWidth: width, sample: true };
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
  const scores = new Array(width).fill(0), luminances = new Array(width).fill(0), chromas = new Array(width).fill(0), reds = new Array(width).fill(0), greens = new Array(width).fill(0), blues = new Array(width).fill(0);
  let over = 0, sampled = 0, totalWeight = 0;
  for (let y = y0; y < y1; y += 2) {
    const weight = Math.exp(-((y - height / 2) ** 2) / (2 * (height * .22) ** 2));
    totalWeight += weight;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
      const value = Math.max(r, g, b), chroma = value - Math.min(r, g, b);
      scores[x] += weight * (.38 * value + .62 * chroma);
      luminances[x] += weight * (.2126 * r + .7152 * g + .0722 * b);
      chromas[x] += weight * chroma;
      reds[x] += r; greens[x] += g; blues[x] += b;
      if (value > 250) over++; sampled++;
    }
  }
  const sampleRows = Math.max(1, Math.ceil((y1 - y0) / 2));
  const luminanceIntensity = luminances.map((value) => Math.min(1, value / Math.max(totalWeight * 255, 1)));
  const edgeEnergy = luminanceIntensity.slice(1).reduce((sum, value, index) => sum + Math.abs(value - luminanceIntensity[index]), 0) / Math.max(width - 1, 1);
  return {
    preview: URL.createObjectURL(file), fileName: file.name, width, height,
    rawIntensity: scores.map((value) => Math.min(1, value / Math.max(totalWeight * 255, 1))),
    luminanceIntensity,
    chromaIntensity: chromas.map((value) => Math.min(1, value / Math.max(totalWeight * 255, 1))),
    red: reds.map((value) => value / sampleRows), green: greens.map((value) => value / sampleRows), blue: blues.map((value) => value / sampleRows),
    overexposed: over / Math.max(sampled, 1) > .045, sharpnessOk: edgeEnergy > .0018, tilt: .7, bandWidth: width,
  };
}

function AppHeader({ active, onChange, authenticated, authHref, authLabel, viewerName }: { active: ModuleId; onChange: (id: ModuleId) => void; authenticated: boolean; authHref: string | null; authLabel: string; viewerName: string | null }) {
  return (
    <header className="topbar">
      <button className="brand" onClick={() => onChange("home")} aria-label="返回首页">
        <span className="brand-mark"><Aperture size={19} /></span>
        <span><strong>SPECTRA</strong><small>分光计实验学习助手</small></span>
      </button>
      <nav className="main-nav" aria-label="主导航">
        {navItems.map((item) => <button key={item.id} className={active === item.id ? "active" : ""} aria-current={active === item.id ? "page" : undefined} onClick={() => onChange(item.id)}>{item.label}</button>)}
      </nav>
      <div className="topbar-actions">
        <button className="ghost-button" onClick={() => toast.info("从虚拟分光计开始熟悉仪器，再使用图像分析处理真实测量数据。 ")}><CircleHelp size={17} /> 使用说明</button>
        {authHref ? <a className="auth-link" href={authHref} target="_top" title={viewerName ?? authLabel}>{authenticated ? <LogOut size={16} /> : <LogIn size={16} />}{authLabel}</a> : authenticated ? <span className="auth-link" title={viewerName ?? authLabel}><CheckCircle2 size={16} />{authLabel}</span> : null}
      </div>
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
            className={`${index <= stage || (index === 4 && stage >= 3) ? "visible" : ""}${index === 3 ? " yellow-doublet-left" : ""}${index === 4 ? " yellow-doublet-right" : ""}`}
            style={{ left: `${[13, 28, 57, 74, 86][index]}%`, backgroundColor: line.color }}
          >
            <b>{line.wavelengthNm.toFixed(2)}</b>
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
        <span><small>反演波长</small><strong>435.80 nm</strong></span>
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
          <h1>基于三维虚拟仿真与AI图像分析的分光计波长反演实验系统</h1>
          <p>使用虚拟仪器熟悉分光计操作，再用真实照片完成零级定位、谱线匹配与未知波长反演。</p>
          <div className="hero-actions"><button className="primary-action" onClick={() => navigate("simulator")}><Play size={18} />开始虚拟预习</button><button className="secondary-action" onClick={() => navigate("analysis")}><ScanLine size={17} />进入图像分析</button></div>
        </div>
        <AnalysisGlassPanel />
        <div className="hero-scroll-cue" aria-hidden="true"><span>向下探索</span><i /></div>
      </section>
      <section className="pain-grid">
        {[
          { icon: Telescope, ask: "预习只看讲义，真机还是不会调？", answer: "先在虚拟分光计中瞄准、读数、反演波长。", target: "simulator" as ModuleId },
          { icon: ScanLine, ask: "零级、黄双线或照片质量，错在哪不清楚？", answer: "真实图像自动质检与认线，阻塞原因直接给出证据。", target: "analysis" as ModuleId },
          { icon: History, ask: "做完只剩一个结果，过程无法复盘？", answer: "保存峰值、匹配、拟合与诊断，按时间轴回放。", target: "records" as ModuleId },
        ].map((item, index) => <button className="pain-card" key={item.ask} onClick={() => navigate(item.target)}><span className="pain-number">0{index + 1}</span><item.icon size={22} /><strong>{item.ask}</strong><p>{item.answer}</p><em>打开模块 <ArrowRight size={14} /></em></button>)}
      </section>
    </div>
  );
}

function SimulatorModule({ journey, navigate, updateJourney }: { journey: ExperimentJourney; navigate: (id: ModuleId) => void; updateJourney: (patch: Partial<ExperimentJourney>) => void }) {
  return <VirtualSpectrometer3D journey={journey} navigate={navigate} updateJourney={updateJourney} />;
}

const OPENMAIC_URL = process.env.NEXT_PUBLIC_OPENMAIC_URL?.trim();
const HOSTED_OPENMAIC_URL = "https://open.maic.chat";
const isLoopbackClassroomUrl = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
};

function AssistantModule({ journey, navigate }: { journey: ExperimentJourney; navigate: (id: ModuleId) => void }) {
  const [isLocalBrowser, setIsLocalBrowser] = useState(false);
  useEffect(() => {
    const host = window.location.hostname;
    setIsLocalBrowser(host === "localhost" || host === "127.0.0.1" || host === "::1");
  }, []);

  const canEmbedClassroom = Boolean(OPENMAIC_URL) && (!isLoopbackClassroomUrl(OPENMAIC_URL!) || isLocalBrowser);
  if (!canEmbedClassroom) return <div className="openmaic-fullscreen classroom-launch">
    <section className="classroom-launch-card" aria-labelledby="classroom-launch-title">
      <span className="classroom-launch-kicker"><Users size={18} /> OpenMAIC 互动课堂</span>
      <h1 id="classroom-launch-title">在新窗口开启互动课堂</h1>
      <p>线上课堂服务不能嵌入当前页面。点击下方按钮即可进入可用的互动课堂；首次使用请按页面提示登录或输入访问码。</p>
      <a className="classroom-primary-link" href={HOSTED_OPENMAIC_URL} target="_blank" rel="noreferrer">
        进入互动课堂 <ExternalLink size={18} />
      </a>
      <p className="classroom-launch-note">如已部署自己的 OpenMAIC 服务，可通过 <code>NEXT_PUBLIC_OPENMAIC_URL</code> 配置其公开 HTTPS 地址并在这里直接嵌入。</p>
    </section>
    <button className="openmaic-back-btn" onClick={() => navigate("home")} aria-label="返回主站">
      <ArrowLeft size={18} />
      <span>返回主站</span>
    </button>
  </div>;

  return <div className="openmaic-fullscreen">
    <iframe
      className="openmaic-iframe-full"
      src={OPENMAIC_URL}
      title="SPECTRA 互动课堂"
      allow="microphone; camera; autoplay; fullscreen; clipboard-write"
    />
    <a className="openmaic-open-external" href={OPENMAIC_URL} target="_blank" rel="noreferrer">
      无法显示课堂？在新窗口打开 <ExternalLink size={15} />
    </a>
    <button className="openmaic-back-btn" onClick={() => navigate("home")} aria-label="返回主站">
      <ArrowLeft size={18} />
      <span>返回主站</span>
    </button>
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
    <p>候选谱线数量不限；系统匹配其中可确认的汞灯参考线，其余谱线与干扰峰保留供复核。</p>
    {image && <div className="candidate-strip" aria-label="检测到的候选峰">{image.peaks.map((peak, index) => <button key={`${peak.x}-${index}`} onClick={() => onCandidate(peak.xRatio)}><i style={{ background: peak.color }} />峰 {index + 1}<small>{peak.x.toFixed(1)}px</small></button>)}</div>}
    <div className="selected-markers">{markers.length ? markers.map((marker) => <button key={marker.wavelengthNm} onClick={() => onRemove(marker.wavelengthNm)} title="移除此标记"><i style={{ background: lineColor(marker.wavelengthNm) }} />{marker.wavelengthNm.toFixed(2)} nm<span>×</span></button>) : <span>尚未选择参考线；先确认至少一条，再填写它对应的游标读数。两条及以上可进行残差复核。</span>}</div>
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
    { icon: BarChart3, title: "物理计算", detail: selectedCount >= 2 ? resultText : selectedCount === 1 ? "已得到单线暂估，待另一条游标读数复核" : "填写至少一条谱线的游标读数" },
  ];
  return <div className="processing-timeline">{steps.map((item, index) => { const Icon = item.icon; return <div key={item.title} className={image && (index < 3 || selectedCount >= 2) ? "complete" : ""}><span><Icon size={18} /></span><small>0{index + 1}</small><strong>{item.title}</strong><p>{item.detail}</p></div>; })}</div>;
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
  if (!response.ok) throw new Error("原始实验图片读取失败");
  const blob = await response.blob();
  return analyzeImageFile(new File([blob], "已同步实验图片", { type: blob.type || "image/png" }));
}

function useExperimentSync({
  task,
  enabled,
  authenticated,
  snapshot,
  pendingImagesRef,
  onRemoteRecord,
}: {
  task: ExperimentTask;
  enabled: boolean;
  authenticated: boolean;
  snapshot: RecordSnapshot;
  pendingImagesRef: React.MutableRefObject<PendingImages>;
  onRemoteRecord: (record: SavedRecord) => Promise<void>;
}) {
  const metaRef = useRef<Record<ExperimentTask, { id: string; version: number } | null>>({ A: null });
  const latestSnapshotRef = useRef<Partial<Record<ExperimentTask, RecordSnapshot>>>({});
  const lastSavedSignatureRef = useRef<Partial<Record<ExperimentTask, string>>>({});
  const loadedRef = useRef<Record<ExperimentTask, boolean>>({ A: false });
  const syncingRef = useRef<Record<ExperimentTask, boolean>>({ A: false });
  const suppressRef = useRef<Set<ExperimentTask>>(new Set());
  const timersRef = useRef<Partial<Record<ExperimentTask, ReturnType<typeof setTimeout>>>>({});
  const currentTaskRef = useRef(task);
  const onRemoteRecordRef = useRef(onRemoteRecord);
  const runSyncRef = useRef<(task: ExperimentTask) => Promise<void>>(async () => undefined);
  const phaseRef = useRef<SyncPhase>("loading");
  const [phase, setPhase] = useState<SyncPhase>(authenticated ? "loading" : "idle");
  const [savedSignature, setSavedSignature] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [loadRevision, setLoadRevision] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    currentTaskRef.current = task;
    onRemoteRecordRef.current = onRemoteRecord;
    latestSnapshotRef.current[task] = snapshot;
  }, [task, onRemoteRecord, snapshot]);

  const changePhase = useCallback((next: SyncPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const adoptRecord = useCallback(async (record: SavedRecord, notify = false) => {
    metaRef.current[record.task] = { id: record.id, version: record.version };
    suppressRef.current.add(record.task);
    await onRemoteRecordRef.current(record);
    setTimeout(() => {
      const adoptedSignature = JSON.stringify(latestSnapshotRef.current[record.task] ?? snapshotFromRecord(record));
      lastSavedSignatureRef.current[record.task] = adoptedSignature;
      setSavedSignature(adoptedSignature);
      suppressRef.current.delete(record.task);
    }, 250);
    setLastSyncedAt(Number(new Date(record.updatedAt)));
    setErrorMessage("");
    if (currentTaskRef.current === record.task) changePhase("synced");
    if (notify) toast.info("检测到其他设备的更新，已载入最新版本");
  }, [changePhase]);

  const runSync = useCallback(async (taskToSync: ExperimentTask) => {
    if (!authenticated) return;
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
      setSavedSignature(signature);
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
  }, [adoptRecord, authenticated, changePhase, pendingImagesRef]);
  useEffect(() => { runSyncRef.current = runSync; }, [runSync]);

  useEffect(() => {
    if (!authenticated) return;
    if (loadedRef.current[task]) {
      changePhase(metaRef.current[task] ? "synced" : "idle");
      return;
    }
    let cancelled = false;
    changePhase("loading");
    const restorePendingRecord = async () => {
      try {
        const { records } = await requestRecordJson<{ records: SavedRecord[] }>(`/api/records?task=${task}&limit=100`, undefined, 3, () => changePhase("retrying"));
        if (cancelled) return;
        const pendingRecord = records.find((record) => record.status !== "completed");
        metaRef.current[task] = null;
        lastSavedSignatureRef.current[task] = undefined;
        setSavedSignature("");
        if (pendingRecord) {
          await adoptRecord(pendingRecord);
          if (!cancelled) toast.success("已恢复上次未完成实验");
        } else {
          changePhase("idle");
        }
        if (!cancelled) {
          loadedRef.current[task] = true;
          setLoadRevision((value) => value + 1);
        }
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "未完成实验读取失败");
        changePhase("error");
      }
    };
    void restorePendingRecord();
    return () => { cancelled = true; };
  }, [task, authenticated, changePhase, adoptRecord, loadAttempt]);

  useEffect(() => {
    if (!authenticated || !enabled || !loadedRef.current[task] || suppressRef.current.has(task)) return;
    const signature = JSON.stringify(snapshot);
    if (signature === lastSavedSignatureRef.current[task]) return;
    changePhase("pending");
    if (timersRef.current[task]) clearTimeout(timersRef.current[task]);
    const timer = setTimeout(() => void runSyncRef.current(task), 800);
    timersRef.current[task] = timer;
    return () => clearTimeout(timer);
  }, [task, enabled, authenticated, snapshot, loadRevision, changePhase]);

  useEffect(() => {
    if (!authenticated) return;
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
  }, [task, authenticated, adoptRecord]);

  const syncNow = useCallback(() => {
    if (timersRef.current[task]) clearTimeout(timersRef.current[task]);
    return runSyncRef.current(task);
  }, [task]);

  const retryLoad = useCallback(() => {
    loadedRef.current[task] = false;
    setErrorMessage("");
    setLoadAttempt((value) => value + 1);
  }, [task]);

  const resetSync = useCallback(() => {
    if (timersRef.current[task]) clearTimeout(timersRef.current[task]);
    metaRef.current[task] = null;
    lastSavedSignatureRef.current[task] = undefined;
    pendingImagesRef.current[task] = {};
    setErrorMessage("");
    changePhase("idle");
  }, [task, changePhase, pendingImagesRef]);

  const currentSnapshotSynced = phase === "synced" && savedSignature === JSON.stringify(snapshot);
  return { phase, lastSyncedAt, errorMessage, currentSnapshotSynced, retryLoad, syncNow, resetSync };
}

function AnalysisModule({ analyzeSignal = 0, journey, updateJourney, authenticated, finishExperiment }: { analyzeSignal?: number; journey: ExperimentJourney; updateJourney: (patch: Partial<ExperimentJourney>) => void; authenticated: boolean; finishExperiment: () => void }) {
  const task: ExperimentTask = "A";
  const [detector, setDetector] = useState<DetectorOptions>({ prominence: .018, minDistancePx: 3 });
  const [aSource, setASource] = useState<SpectrumSource | null>(() => analyzeSignal > 0 ? buildSampleSource() : null);
  const [aMarkers, setAMarkers] = useState<ReferenceMarker[]>(() => analyzeSignal > 0 ? SPECTRAL_LIBRARY.mercury.map((line) => ({ wavelengthNm: line.wavelengthNm, xRatio: (100 + 4000 * Math.tan(Math.asin(line.wavelengthNm / 3333))) / 1000 })) : []);
  const [selectedWavelength, setSelectedWavelength] = useState(546.07);
  const [zeroSource, setZeroSource] = useState<SpectrumSource | null>(() => analyzeSignal > 0 ? { ...buildSampleSource(), fileName: "零级参考示例" } : null);
  const [zeroReading, setZeroReading] = useState(analyzeSignal > 0 ? "120.0000" : "");
  const [lineReadings, setLineReadings] = useState<Record<string, string>>(() => analyzeSignal > 0 ? sampleVernierReadings() : {});
  const [vernierResolutionArcmin, setVernierResolutionArcmin] = useState(1);
  const [aComplete, setAComplete] = useState(analyzeSignal > 0);
  const [busy, setBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState("");
  const pendingImagesRef = useRef<PendingImages>({ A: {} });

  const aImage = useMemo(() => aSource ? detectSpectrumPeaks(aSource, detector) : null, [aSource, detector]);
  const zeroReadingDeg = degreesFromReading(zeroReading);
  const usableReadings = useMemo(() => {
    if (zeroReadingDeg === null) return [];
    return aMarkers.flatMap((marker) => {
      const readingDeg = degreesFromReading(lineReadings[lineReadingKey(marker.wavelengthNm)] ?? "");
      if (readingDeg === null) return [];
      const thetaDeg = circularAngleDifferenceDeg(readingDeg, zeroReadingDeg);
      return thetaDeg > .005 && thetaDeg < 89.995 ? [{ wavelengthNm: marker.wavelengthNm, thetaDeg, readingDeg }] : [];
    });
  }, [aMarkers, lineReadings, zeroReadingDeg]);
  const singleLineEstimate = useMemo(() => {
    const line = usableReadings[0];
    return line ? line.wavelengthNm / Math.sin(line.thetaDeg * Math.PI / 180) / 1000 : null;
  }, [usableReadings]);

  useEffect(() => () => { if (aSource?.preview) URL.revokeObjectURL(aSource.preview); }, [aSource?.preview]);
  useEffect(() => () => { if (zeroSource?.preview) URL.revokeObjectURL(zeroSource.preview); }, [zeroSource?.preview]);

  const loadSample = () => {
    sync.resetSync();
    const sample = buildSampleSource();
    const positions = SPECTRAL_LIBRARY.mercury.map((line) => ({ wavelengthNm: line.wavelengthNm, xRatio: (100 + 4000 * Math.tan(Math.asin(line.wavelengthNm / 3333))) / sample.width }));
    setZeroSource({ ...buildSampleSource(), fileName: "零级参考示例" }); setZeroReading("120.0000");
    setASource(sample); setAMarkers(positions); setLineReadings(sampleVernierReadings()); setVernierResolutionArcmin(1); setAComplete(true); setSelectedWavelength(546.07);
  };
  const uploadZeroReference = async (files?: FileList | File[]) => {
    const file = files ? Array.from(files)[0] : null;
    if (!file) return; setBusy(true);
    try {
      const source = await analyzeImageFile(file);
      pendingImagesRef.current.A.zero_reference = file;
      setZeroSource(source); setAComplete(false);
      toast.success(source.overexposed || !source.sharpnessOk ? "零级参考图已上传，请检查曝光和清晰度" : "零级参考图已上传，请填写 φ₀ 游标读数");
    } catch (error) { toast.error(error instanceof Error ? error.message : "图像分析失败"); }
    finally { setBusy(false); }
  };
  const uploadSpectrum = async (files?: FileList | File[]) => {
    const file = files ? Array.from(files)[0] : null;
    if (!file) return; setBusy(true);
    try {
      const source = await analyzeImageFile(file);
      const analyzed = detectSpectrumPeaks(source, detector);
      const automaticMarkers = autoMatchMercuryPeaks(analyzed);
      pendingImagesRef.current.A.primary = file;
      setASource(source); setAMarkers(automaticMarkers); setAComplete(false);
      setLineReadings((current) => Object.fromEntries(automaticMarkers.map((marker) => [lineReadingKey(marker.wavelengthNm), current[lineReadingKey(marker.wavelengthNm)] ?? ""])));
      toast.success(automaticMarkers.length >= 2 ? `已识别候选谱线并匹配 ${automaticMarkers.length} 条参考线` : "图像读取完成，请补充或修正参考线标记");
    } catch (error) { toast.error(error instanceof Error ? error.message : "图像分析失败"); }
    finally { setBusy(false); }
  };

  const addMarker = (ratio: number) => {
    if (!aImage) return;
    const clickedX = ratio * aImage.width;
    const nearest = aImage.peaks.reduce<Peak | null>((best, peak) => !best || Math.abs(peak.x - clickedX) < Math.abs(best.x - clickedX) ? peak : best, null);
    const xRatio = nearest && Math.abs(nearest.x - clickedX) <= detector.minDistancePx ? nearest.xRatio : ratio;
    const update = (items: ReferenceMarker[]) => [...items.filter((item) => item.wavelengthNm !== selectedWavelength), { wavelengthNm: selectedWavelength, xRatio }].sort((a, b) => a.xRatio - b.xRatio);
    setAMarkers(update);
    setAComplete(false);
  };
  const removeMarker = (wavelengthNm: number) => {
    setAMarkers((items) => items.filter((item) => item.wavelengthNm !== wavelengthNm));
    setLineReadings((current) => { const next = { ...current }; delete next[lineReadingKey(wavelengthNm)]; return next; });
    setAComplete(false);
  };

  const aResult = useMemo(() => {
    if (!aComplete || !aImage || zeroReadingDeg === null || usableReadings.length < 2) return null;
    try {
      const measurement = measureGrating(usableReadings.map(({ wavelengthNm, thetaDeg }) => ({ wavelengthNm, thetaDeg })), .01, vernierResolutionArcmin * Math.SQRT2);
      const maxResidualNm = Math.max(...measurement.points.map((point) => Math.abs(point.residualNm)));
      const residualTargetMet = maxResidualNm <= 1;
      const standardUncertaintyUm = measurement.uncertaintyUm / 2;
      return {
        ...measurement,
        standardUncertaintyUm,
        expandedUncertaintyUm: measurement.uncertaintyUm,
        coverageFactor: 2,
        uncertaintyLabel: "游标读数扩展不确定度",
        uncertaintyBudget: [
          { key: "vernier", label: "零级与一级游标读数（合成）", standardUncertaintyUm, status: `φ₀ 与 ${usableReadings.length} 条 φᵢ · 分度 ${vernierResolutionArcmin.toFixed(2)}′` },
          { key: "wavelength", label: "汞灯参考波长（uλ=0.01 nm）", standardUncertaintyUm: null, status: "已纳入物理模型" },
          { key: "repeatability", label: "重复测量", standardUncertaintyUm: null, status: "本次未评定" },
        ],
        reportable: residualTargetMet && Number.isFinite(standardUncertaintyUm),
        blockReason: residualTargetMet ? "" : `逐线波长残差最大 ${maxResidualNm.toFixed(3)} nm，超过 1 nm，请复核对应游标读数或谱线标记`,
        identifiability: {
          correlation: 0,
          profileLowUm: Math.max(0, measurement.dUm - measurement.uncertaintyUm),
          profileHighUm: measurement.dUm + measurement.uncertaintyUm,
          boundaryHit: false,
        },
        zeroReadingDeg,
        lineReadingCount: usableReadings.length,
        maxResidualNm,
      };
    } catch { return null; }
  }, [aComplete, aImage, zeroReadingDeg, usableReadings, vernierResolutionArcmin]);

  const yellowDoubletResolved = aMarkers.some((item) => item.wavelengthNm === 576.96) && aMarkers.some((item) => item.wavelengthNm === 579.07) && (() => { const yellow = aMarkers.filter((item) => item.wavelengthNm >= 576); return yellow.length === 2 && Math.abs(yellow[1].xRatio - yellow[0].xRatio) * (aImage?.width ?? 0) >= 1.5; })();
  const hasResult = Boolean(aResult?.reportable && zeroSource && aImage?.sharpnessOk && !aImage.overexposed && zeroReadingDeg !== null);
  const blockReason = !zeroSource ? "请先上传零级参考照片" : zeroSource.overexposed ? "零级参考照片过曝，请降低曝光后重拍" : !zeroSource.sharpnessOk ? "零级参考照片不够清晰，请重新对焦后拍摄" : zeroReadingDeg === null ? "请填写零级游标读数 φ₀" : !aImage ? "请上传一级单侧谱图" : aImage.overexposed ? "一级谱图过曝，请降低曝光后重拍" : !aImage.sharpnessOk ? "一级谱线不够清晰，请重新对焦后拍摄" : !aMarkers.length ? "请先标记或确认至少一条参考谱线" : !usableReadings.length ? "请填写一条已标记谱线对应的游标读数 φᵢ" : usableReadings.length === 1 ? "已生成单线暂估；再填写另一条谱线的游标读数可进行拟合、残差复核和报告" : !aComplete ? "已具备拟合数据，点击“执行测量”生成结果" : aResult && !aResult.reportable ? aResult.blockReason : "";
  const status = !zeroSource || !aImage ? "待上传" : hasResult ? "已完成" : usableReadings.length === 1 ? "单线暂估" : blockReason ? "被阻塞" : "可计算";

  useEffect(() => {
    updateJourney({
      capture: { imageCount: Number(Boolean(zeroSource)) + Number(Boolean(aImage)), exposureOk: Boolean(zeroSource && aImage && !zeroSource.overexposed && !aImage.overexposed), sharpnessOk: Boolean(zeroSource?.sharpnessOk && aImage?.sharpnessOk), zeroX: null, zeroReferenceCaptured: Boolean(zeroSource), zeroReadingDeg, peakCount: aImage?.peaks.length ?? 0 },
      identification: { matchedLines: aMarkers.length, yellowDoubletResolved },
      inversion: { reportable: hasResult, dUm: hasResult && aResult ? aResult.dUm : null, expandedUncertaintyUm: hasResult && aResult ? aResult.expandedUncertaintyUm : null, correlation: aResult?.identifiability.correlation ?? null, profileLowUm: aResult?.identifiability.profileLowUm ?? null, profileHighUm: aResult?.identifiability.profileHighUm ?? null, boundaryHit: aResult?.identifiability.boundaryHit ?? false, blockReason: hasResult ? "" : blockReason },
    });
  }, [aImage, zeroSource, zeroReadingDeg, aMarkers.length, yellowDoubletResolved, hasResult, aResult, blockReason, updateJourney]);

  const recordSnapshot = useMemo<RecordSnapshot>(() => {
    const resultValue = hasResult && aResult ? `${aResult.dUm.toFixed(3)} ± ${aResult.expandedUncertaintyUm.toFixed(3)} μm (k=2)` : "进行中";
    const needsReview = Boolean(aImage && !hasResult);
    const steps: string[] = [];
    if (journey.prelab.capturedLines >= 2 && journey.prelab.dUm !== null) steps.push("虚拟预习");
    if (zeroSource && zeroReadingDeg !== null && !zeroSource.overexposed && zeroSource.sharpnessOk) steps.push("零级参考采集与游标读数");
    if (aImage && !aImage.overexposed && aImage.sharpnessOk) steps.push("一级单侧谱图采集与质量检查");
    if (usableReadings.length >= 2) steps.push("谱线匹配与逐线游标读数");
    if (hasResult) steps.push("d 反演及不确定度评估", "云端归档与实验复盘");
    const payload = {
      state: { detector, zeroReadingDeg, lineReadings, vernierResolutionArcmin, complete: aComplete, sample: Boolean(aSource?.sample) },
      referenceMarkers: aMarkers,
      result: aResult,
      processing: { peaks: aImage?.peaks.length ?? 0, overexposed: Boolean(aImage?.overexposed), sharpnessOk: Boolean(aImage?.sharpnessOk), zeroReference: { uploaded: Boolean(zeroSource), overexposed: Boolean(zeroSource?.overexposed), sharpnessOk: Boolean(zeroSource?.sharpnessOk), readingDeg: zeroReadingDeg } },
      evidence: { stages: ["虚拟预习", "零级参考采集与游标读数", "一级单侧谱图采集与质量检查", "谱线匹配与逐线游标读数", "d 反演及不确定度评估", "云端归档与实验复盘"], limitation: "零级参考照片与一级单侧谱图可分开采集。图像仅用于谱线识别与留存；每条参与拟合的谱线均以相对于 φ₀ 的游标读数计算衍射角。单条谱线仅显示暂估值，不作为可报告的拟合结果。" },
    };
    return {
      task: "A",
      source: "汞灯",
      resultLabel: "光栅常数 d",
      resultValue,
      quality: !hasResult ? (blockReason || "进行中") : needsReview ? "需复核" : "可报告",
      status: !hasResult ? "draft" : needsReview ? "needs_review" : "completed",
      steps,
      diagnosis,
      payload,
    };
  }, [aResult, aImage, zeroSource, zeroReadingDeg, lineReadings, vernierResolutionArcmin, usableReadings.length, hasResult, detector, aComplete, aSource?.sample, aMarkers, diagnosis, blockReason, journey.prelab]);

  const hydrateRecord = useCallback(async (record: SavedRecord) => {
    const state = record.payload.state && typeof record.payload.state === "object" ? record.payload.state as Record<string, unknown> : {};
    const markers = Array.isArray(record.payload.referenceMarkers) ? record.payload.referenceMarkers.filter((item): item is ReferenceMarker => Boolean(item) && typeof item === "object" && typeof (item as ReferenceMarker).wavelengthNm === "number" && typeof (item as ReferenceMarker).xRatio === "number") : [];
    const savedDetector = state.detector && typeof state.detector === "object" ? state.detector as Partial<DetectorOptions> : null;
    if (savedDetector && typeof savedDetector.prominence === "number" && typeof savedDetector.minDistancePx === "number") setDetector({ prominence: savedDetector.prominence, minDistancePx: savedDetector.minDistancePx });
    if (record.task !== "A") return;
    setDiagnosis(record.diagnosis);
    setAMarkers(markers);
    setZeroReading(typeof state.zeroReadingDeg === "number" ? state.zeroReadingDeg.toFixed(4) : "");
    if (typeof state.vernierResolutionArcmin === "number" && state.vernierResolutionArcmin > 0) setVernierResolutionArcmin(state.vernierResolutionArcmin);
    setLineReadings(state.lineReadings && typeof state.lineReadings === "object" && !Array.isArray(state.lineReadings) ? Object.fromEntries(Object.entries(state.lineReadings as Record<string, unknown>).filter(([, value]) => typeof value === "string")) as Record<string, string> : {});
    setAComplete(Boolean(state.complete));
    if (state.sample) { setASource(buildSampleSource()); setZeroSource({ ...buildSampleSource(), fileName: "零级参考示例" }); }
    else {
      setZeroSource(record.imageUrls.zero_reference ? await sourceFromSyncedImage(record.imageUrls.zero_reference).catch(() => null) : null);
      setASource(record.imageUrls.primary ? await sourceFromSyncedImage(record.imageUrls.primary).catch(() => null) : null);
    }
  }, []);

  const sync = useExperimentSync({ task, enabled: Boolean(zeroSource || aImage), authenticated, snapshot: recordSnapshot, pendingImagesRef, onRemoteRecord: hydrateRecord });
  const syncLabel = !authenticated ? "登录后可保存到云端" : sync.phase === "loading" ? "正在读取云端记录" : sync.phase === "pending" ? "有更改待同步" : sync.phase === "saving" ? "正在同步" : sync.phase === "retrying" ? "同步失败，正在重试" : sync.phase === "error" ? "同步失败" : sync.phase === "synced" && sync.lastSyncedAt ? `已同步 ${formatChinaClock(sync.lastSyncedAt)}` : "自动同步已就绪";
  useEffect(() => {
    if (hasResult && sync.phase === "synced" && sync.lastSyncedAt) updateJourney({ archive: { synced: true, recordId: null, syncedAt: sync.lastSyncedAt } });
  }, [hasResult, sync.phase, sync.lastSyncedAt, updateJourney]);

  const runPrimary = () => {
    if (!zeroSource) return toast.warning("请先上传零级参考照片");
    if (zeroSource.overexposed || !zeroSource.sharpnessOk) return toast.warning("请使用曝光正常、清晰的零级参考照片");
    if (zeroReadingDeg === null) return toast.warning("请填写零级游标读数 φ₀");
    if (!aImage) return toast.warning("请上传一级单侧谱图");
    if (aImage.overexposed) return toast.warning("一级谱图过曝，结果已阻止；请降低曝光后重新拍摄");
    if (!aImage.sharpnessOk) return toast.warning("一级谱图清晰度不足，结果已阻止；请重新对焦");
    if (usableReadings.length < 2) return toast.warning(usableReadings.length === 1 ? "当前可显示单线暂估；请再填写一条不同谱线的游标读数以完成拟合" : "请填写至少一条已标记谱线的游标读数");
    setAComplete(true);
  };
  const resetTask = () => {
    sync.resetSync();
    setDiagnosis("");
    setDetector({ prominence: .018, minDistancePx: 3 }); setSelectedWavelength(546.07);
    setASource(null); setZeroSource(null); setAMarkers([]); setZeroReading(""); setLineReadings({}); setVernierResolutionArcmin(1); setAComplete(false);
  };
  const summary = [
    ["零级参考", zeroSource && zeroReadingDeg !== null ? `φ₀ = ${zeroReadingDeg.toFixed(4)}°` : "待上传 / 待读数"], ["匹配参考线", `${aMarkers.length} 条`], ["已填游标", `${usableReadings.length} 条`], ["光栅常数 d", hasResult && aResult ? `${aResult.dUm.toFixed(3)} μm` : singleLineEstimate ? `${singleLineEstimate.toFixed(3)} μm（暂估）` : "未形成结果"],
  ];

  return <div className="module-page analysis-page">
    <PageHeading eyebrow="实验 · 图像分析工作台" title="从两份采集证据到可复核的测量结果。" description="零级参考图与游标读数 φ₀ 单独采集；一级单侧谱图用于识别、标记谱线。逐条记录一级谱线读数 φᵢ，按 θᵢ = |φᵢ − φ₀| 计算衍射角；由角度和已知波长拟合未知光栅常数，图像像素位置不参与反演。" />
    <div className="analysis-workbench">
      <aside className="panel parameter-panel"><div className="analysis-card-heading"><span><SlidersHorizontal size={18} /></span><div><h2>测量参数</h2><p>零级和一级读数来自分光计游标；图片仅负责认线、质检和留存。</p></div></div><div className="parameter-form">
        <label>游标最小分度（′）<input type="number" min=".01" max="60" step=".01" value={vernierResolutionArcmin} onChange={(event) => { const value = Number(event.target.value); setVernierResolutionArcmin(Number.isFinite(value) ? Math.min(60, Math.max(.01, value)) : 1); setAComplete(false); }} /></label>
        <label>峰值突出度 <output>{detector.prominence.toFixed(3)}</output><input type="range" min=".005" max=".2" step=".005" value={detector.prominence} onChange={(event) => setDetector((value) => ({ ...value, prominence: Number(event.target.value) }))} /></label>
        <label>最小峰间距（px）<input type="number" min="2" max="64" value={detector.minDistancePx} onChange={(event) => setDetector((value) => ({ ...value, minDistancePx: Math.min(64, Math.max(2, Number(event.target.value))) }))} /></label>
        <div className="parameter-buttons"><button className="reset-button parameter-reset" onClick={resetTask}><RotateCcw size={15} />恢复默认</button><button className="reset-button parameter-reset sample-button" onClick={loadSample}><Play size={15} />加载示例</button></div>
      </div></aside>
      <section className="panel calibration-panel"><div className="analysis-card-heading wide"><span><Waves size={18} /></span><div><h2>未知光栅常数反演</h2><p>一张零级参考图配 φ₀；一张一级单侧谱图自动认线。候选线数量不限，只有填入游标读数的谱线参与计算。</p></div><em className={`analysis-status ${status === "已完成" ? "done" : ""}`}>{status}</em></div>
        <div className="zero-reference-card"><div className="zero-reference-copy"><span><Target size={17} /></span><div><strong>零级参考读数 / 图片</strong><p>先将零级像对准十字叉丝，上传同一时刻的参考照片并填写一次 φ₀。它可以不在一级谱图的画面中。</p>{zeroSource && <small>{zeroSource.fileName} · {zeroSource.overexposed ? "曝光需复核" : zeroSource.sharpnessOk ? "清晰度通过" : "清晰度需复核"}</small>}</div></div><div className="zero-reference-controls"><label>零级游标 φ₀（°）<input inputMode="decimal" type="number" min="-360" max="360" step=".0001" value={zeroReading} onChange={(event) => { setZeroReading(event.target.value); setAComplete(false); }} placeholder="例如 120.0000" /></label><label className="upload-button compact-upload"><Upload size={16} />上传零级参考图<input type="file" accept="image/*" hidden onChange={(event) => uploadZeroReference(event.target.files ?? undefined)} /></label></div></div>
        <SpectrumStage image={aImage} markers={aMarkers} onMark={addMarker} caption={aImage?.sample ? "示例图像 · 一级单侧汞灯光谱" : "一级单侧谱图 · 已完成强度提取"} />
        <MarkerPicker selected={selectedWavelength} setSelected={setSelectedWavelength} markers={aMarkers} onClear={() => { setAMarkers([]); setLineReadings({}); setAComplete(false); }} onRemove={removeMarker} image={aImage} onCandidate={addMarker} />
        <div className="vernier-readings"><div><strong>一级谱线游标读数 φᵢ</strong><p>将每条准备使用的谱线依次对准十字叉丝，分别填写一个读数。填 1 条显示单线暂估；填 2 条或更多条才做拟合与残差复核。</p></div>{aMarkers.length ? <div className="vernier-reading-list">{aMarkers.map((marker) => { const key = lineReadingKey(marker.wavelengthNm); const reading = degreesFromReading(lineReadings[key] ?? ""); const theta = zeroReadingDeg !== null && reading !== null ? circularAngleDifferenceDeg(reading, zeroReadingDeg) : null; return <label key={marker.wavelengthNm}><i style={{ background: lineColor(marker.wavelengthNm) }} /><span>{marker.wavelengthNm.toFixed(2)} nm<small>{theta !== null && theta > .005 && theta < 89.995 ? `θ = ${theta.toFixed(4)}°` : "待填 φᵢ"}</small></span><input aria-label={`${marker.wavelengthNm.toFixed(2)} nm 的游标读数`} inputMode="decimal" type="number" min="-360" max="360" step=".0001" value={lineReadings[key] ?? ""} onChange={(event) => { const value = event.target.value; setLineReadings((current) => ({ ...current, [key]: value })); setAComplete(false); }} placeholder="φᵢ（°）" /></label>; })}</div> : <p className="vernier-empty">先上传一级单侧谱图并确认谱线标记。</p>}{singleLineEstimate !== null && usableReadings.length === 1 && <p className="single-line-estimate"><CircleAlert size={15} />单线暂估：d ≈ {singleLineEstimate.toFixed(3)} μm。它不能提供残差或精度验证，请再填写一条谱线读数。</p>}</div>
        <div className="analysis-actions"><label className="upload-button"><Upload size={17} />上传一级单侧谱图<input type="file" accept="image/*" hidden onChange={(event) => uploadSpectrum(event.target.files ?? undefined)} /></label><label className="camera-button"><Camera size={17} />手机拍摄<input type="file" accept="image/*" capture="environment" hidden onChange={(event) => uploadSpectrum(event.target.files ?? undefined)} /></label><button className="analyze-button" disabled={busy} onClick={runPrimary}><Play size={17} />{busy ? "处理中…" : "执行测量"}</button></div>
        {(zeroSource || aImage) && <div className="quality-row"><span><i className={!zeroSource || zeroSource.overexposed || !zeroSource.sharpnessOk ? "warn" : ""} />{zeroSource ? zeroReadingDeg === null ? "零级图已上传 · 待填 φ₀" : `零级 φ₀ = ${zeroReadingDeg.toFixed(4)}°` : "待上传零级参考图"}</span>{aImage && <><span><i />候选峰 {aImage.peaks.length} 条</span><span><i className={aImage.overexposed ? "warn" : ""} />{aImage.overexposed ? "高光偏多" : "曝光正常"}</span><span><i className={!aImage.sharpnessOk ? "warn" : ""} />{aImage.sharpnessOk ? "清晰度通过" : "清晰度不足"}</span></>}</div>}
        {blockReason && (zeroSource || aImage) && <p className="inline-warning"><CircleAlert size={15} />{blockReason}</p>}
      </section>
    </div>
    <section className="panel overview-panel"><div><h2>结果总览</h2><p>{!authenticated ? "匿名状态可完成本地分析；登录后自动保存实验过程。" : hasResult ? "关键参数、最终结果与残差会自动同步。" : "上传任一证据照片后即开始保存实验过程，完成计算后自动更新结果。"}</p><span className={`sync-state ${sync.phase}`} aria-live="polite">{sync.phase === "error" ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}{syncLabel}</span>{sync.phase === "error" && sync.errorMessage && <small className="sync-error">{sync.errorMessage}</small>}</div><div className="overview-metrics">{summary.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div>{hasResult && (!authenticated || sync.currentSnapshotSynced) ? <button className="primary-action" onClick={finishExperiment}><CheckCircle2 size={16} />完成本次实验</button> : <button className="secondary-action" onClick={() => sync.phase === "error" && !zeroSource && !aImage ? sync.retryLoad() : void sync.syncNow()} disabled={!authenticated || sync.phase === "saving" || sync.phase === "retrying" || (!zeroSource && !aImage && sync.phase !== "error")}><Save size={16} />{sync.phase === "error" && !zeroSource && !aImage ? "重新读取" : sync.phase === "error" ? "立即重试" : "立即同步"}</button>}</section>
    <section className="panel review-note-panel"><div className="analysis-card-heading"><span><ClipboardCheck size={18} /></span><div><h2>异常诊断与复核意见</h2><p>记录异常现象、可能原因和复核结论；输入内容会随实验记录自动同步。</p></div></div><textarea value={diagnosis} maxLength={2000} onChange={(event) => setDiagnosis(event.target.value)} placeholder="例如：黄色双线未完全分离，已重新调整狭缝并复测。" /></section>
    <div className="analysis-results-grid">
      <section className="panel intensity-panel"><div className="analysis-card-heading wide"><span><Waves size={18} /></span><div><h2>强度剖面与谱线标注</h2><p>曲线、候选峰和人工参考标记来自当前图像数据。</p></div></div><IntensityChart image={aImage} markers={aMarkers} title="光谱横向强度剖面" /></section>
      <div className="analysis-result-stack"><section className="panel final-result-card"><div className="analysis-card-heading"><span><BarChart3 size={18} /></span><div><h2>最终光栅结果</h2><p>以零级和逐线游标读数计算；两条及以上谱线才产生可报告拟合。</p></div></div>{hasResult && aResult ? <div className="final-measure"><small>光栅常数 d · {aResult.uncertaintyLabel}</small><strong>{aResult.dUm.toFixed(3)} <em>± {aResult.expandedUncertaintyUm.toFixed(3)} μm</em></strong><p>U = 2u<sub>c</sub>，k = {aResult.coverageFactor} · {aResult.linesPerMm.toFixed(1)} 线/mm</p><p>φ₀ = {aResult.zeroReadingDeg.toFixed(4)}° · 已纳入 {aResult.lineReadingCount} 条一级谱线读数</p></div> : <div className="result-placeholder"><FlaskConical size={28} /><span>{singleLineEstimate !== null ? `单线暂估 d ≈ ${singleLineEstimate.toFixed(3)} μm；待另一条谱线读数复核` : aResult ? `候选拟合不可报告：${aResult.blockReason || blockReason}` : "等待执行测量"}</span></div>}</section>
        <section className="panel residual-card"><div className="analysis-card-heading"><span><Target size={18} /></span><div><h2>拟合残差复核</h2><p>逐条检查预测值与参考值。</p></div></div>{aResult ? <div className="residual-table"><div><b>标准 λ</b><b>换算 θ</b><b>残差</b></div>{aResult.points.map((point) => <div key={point.wavelengthNm}><span>{point.wavelengthNm.toFixed(2)} nm</span><span>{point.thetaDeg.toFixed(3)}°</span><strong>{point.residualNm >= 0 ? "+" : ""}{point.residualNm.toFixed(3)} nm</strong></div>)}</div> : <div className="result-placeholder compact"><Target size={25} /><span>完成计算后显示逐线残差</span></div>}</section></div>
    </div>
    {aResult && <section className="panel uncertainty-panel"><div className="analysis-card-heading wide"><span><CircleHelp size={18} /></span><div><h2>完整不确定度预算</h2><p>游标读数不确定度已经对零级与每条一级读数的差值合成；覆盖因子 k=2。</p></div></div><div className="uncertainty-table"><div><b>分量</b><b>标准不确定度</b><b>评定状态</b></div>{aResult.uncertaintyBudget.map((item) => <div key={item.key}><span>{item.label}</span><strong>{item.standardUncertaintyUm === null ? "—" : `${item.standardUncertaintyUm.toFixed(4)} μm`}</strong><em>{item.status}</em></div>)}</div><div className="diagnostic-strip"><span>最大残差 <strong>{aResult.maxResidualNm.toFixed(3)} nm</strong></span><span>95% 近似区间 <strong>{aResult.identifiability.profileLowUm.toFixed(3)}–{aResult.identifiability.profileHighUm.toFixed(3)} μm</strong></span><span>残差检查 <strong>{aResult.maxResidualNm <= 1 ? "通过" : "需复核"}</strong></span></div></section>}
    <section className="panel process-panel"><div className="analysis-card-heading wide"><span><SlidersHorizontal size={18} /></span><div><h2>图像处理全过程</h2><p>图像用于谱线识别，物理计算只使用已记录的游标读数。</p></div></div><ProcessingTimeline image={aImage} selectedCount={usableReadings.length} resultText={aResult ? `d = ${aResult.dUm.toFixed(3)} μm` : singleLineEstimate ? `单线暂估 d ≈ ${singleLineEstimate.toFixed(3)} μm` : "等待游标读数"} /></section>
  </div>;
}

function RecordsModule({ authenticated, authHref }: { authenticated: boolean; authHref: string | null }) {
  const [records, setRecords] = useState<SavedRecord[]>([]); const [loading, setLoading] = useState(authenticated); const [selected, setSelected] = useState<SavedRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState(""); const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    if (!authenticated) return;
    try {
      const { records: latest } = await requestRecordJson<{ records: SavedRecord[] }>("/api/records?limit=100", undefined, 2);
      setRecords(latest);
      setSelected((current) => {
        const newest = latest[0] ?? null;
        if (!current || !newest || Number(new Date(newest.updatedAt)) > Number(new Date(current.updatedAt))) return newest;
        return latest.find((record) => record.id === current.id) ?? newest;
      });
      setLastUpdated(Date.now()); setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "实验记录读取失败");
    } finally { setLoading(false); }
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated) return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = setInterval(() => void refresh(), 3000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearTimeout(initial); clearInterval(interval); window.removeEventListener("focus", onFocus); };
  }, [authenticated, refresh]);
  const exportCsv = () => { const rows = [["最后更新", "任务", "光源", "状态", "结果", "质量"], ...records.map((r) => [formatChinaDateTime(r.updatedAt), r.task, r.source, r.status === "draft" ? "进行中" : r.status === "needs_review" ? "需复核" : "已完成", r.resultValue, r.quality])]; downloadFile("spectra-experiments.csv", rows.map((row) => row.map((v) => `"${String(v).replaceAll('"','""')}"`).join(",")).join("\n"), "text/csv"); };
  const markerCount = Array.isArray(selected?.payload.referenceMarkers) ? selected.payload.referenceMarkers.length : 0;
  const imageEntries = selected ? Object.entries(selected.imageUrls) as [ExperimentImageSlot, string][] : [];
  if (!authenticated) return <div className="module-page"><PageHeading eyebrow="课后 · 实验记录与复盘" title="登录后查看你的实验记录。" description="未登录状态不会读取或保存个人数据。登录后可在不同设备间同步记录、图片与实验报告。" action={authHref ? <a className="primary-action" href={authHref} target="_top"><LogIn size={16} />登录 ChatGPT</a> : undefined} /><div className="panel record-empty"><History size={34} /><strong>个人记录受到登录保护</strong><p>完成邮箱验证后即可自动保存与跨设备查看。</p></div></div>;
  return <div className="module-page"><PageHeading eyebrow="课后 · 实验记录与复盘" title="回看每次实验，复核过程与结果。" description="查看实验步骤、原始光谱、测量结果与异常诊断；支持导出 CSV 和实验报告。" action={<button className="secondary-action" onClick={exportCsv} disabled={!records.length}><Download size={16} />导出全部 CSV</button>} />
    <div className={`records-sync ${errorMessage ? "error" : ""}`} aria-live="polite">{errorMessage ? <><CircleAlert size={15} /><span>{errorMessage}</span><button onClick={() => void refresh()}>重新加载</button></> : <><CheckCircle2 size={15} /><span>{lastUpdated ? `云端记录已更新 · ${formatChinaClock(lastUpdated)}` : "正在连接云端记录"}</span></>}</div>
    <div className="records-grid"><section className="panel record-list"><div className="panel-title"><div><span className="step-index"><History size={14} /></span><h2>我的实验</h2></div><span>{records.length} 条</span></div>{loading ? <div className="record-empty">正在读取实验记录…</div> : records.length ? records.map((record) => <button key={record.id} className={selected?.id === record.id ? "active" : ""} onClick={() => setSelected(record)}><span className="record-source"><Waves size={18} /></span><div><strong>{record.resultLabel}<small>{record.resultValue}</small></strong><p><Clock3 size={12} />{formatChinaDateTime(record.updatedAt)} · {record.source}</p></div><em className={record.status === "completed" ? "good" : ""}>{record.status === "draft" ? "进行中" : record.status === "needs_review" ? "需复核" : "已完成"}</em></button>) : <div className="record-empty"><History size={30} /><strong>还没有实验记录</strong><p>上传光谱图片后，实验过程会自动同步并出现在这里。</p></div>}</section>
      <section className="panel replay-panel">{selected ? <><div className="replay-head"><div><p className="eyebrow">实验回放</p><h2>{selected.resultLabel} · {selected.resultValue}</h2><small>最后同步于 {formatChinaDateTime(selected.updatedAt)}</small></div><a className="secondary-action" href={`/api/records/${encodeURIComponent(selected.id)}/report`} target="_blank" rel="noreferrer"><FileText size={16} />查看 / 打印报告</a></div><div className="record-evidence"><span><small>已完成阶段</small><strong>{selected.steps.length} 项</strong></span><span><small>匹配汞线</small><strong>{markerCount} 条</strong></span><span><small>记录状态</small><strong>{selected.quality}</strong></span></div>{imageEntries.length > 0 && <div className="record-images">{imageEntries.map(([slot, url]) => <figure key={slot}><Image src={url} alt="汞灯零级参考与单侧一级原始照片" width={800} height={450} unoptimized /><figcaption>{slot === "zero_reference" ? "零级参考照片" : slot === "primary" ? "一级单侧谱图" : slot === "repeat_2" ? "重复照片 2" : "重复照片 3"}</figcaption></figure>)}</div>}<div className="timeline">{selected.steps.length ? selected.steps.map((step, index) => <div className="timeline-item" key={step}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{step}</strong><p>{step === "d 反演及不确定度评估" ? `${selected.resultLabel} = ${selected.resultValue}` : "该阶段的参数和证据已保存到云端记录。"}</p></div>{index < selected.steps.length - 1 && <i />}</div>) : <div className="record-empty compact"><History size={28} /><strong>实验尚未开始</strong></div>}</div><div className="record-diagnosis"><strong>异常诊断与复核意见</strong><p>{selected.diagnosis || "未填写异常诊断或复核意见。"}</p></div></> : <div className="record-empty"><Microscope size={34} /><strong>选择一条记录开始回放</strong></div>}</section></div>
  </div>;
}

function downloadFile(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob(["\ufeff", content], { type: `${type};charset=utf-8` })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); }

declare global {
  interface Document { modelContext?: { registerTool: (tool: { name: string; title: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => unknown }, options?: { signal?: AbortSignal }) => void | Promise<void> } }
}

export default function SpectraApp({ authenticated, viewerName, authHref, authLabel }: { authenticated: boolean; viewerName: string | null; authHref: string | null; authLabel: string }) {
  const [active, setActive] = useState<ModuleId>("home"); const [analyzeSignal, setAnalyzeSignal] = useState(0);
  const [journey, setJourney] = useState<ExperimentJourney>(() => structuredClone(emptyJourney));
  const journeyLoadedRef = useRef(false);
  const journeySaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const journeySavedSignatureRef = useRef("");
  const updateJourney = useCallback((patch: Partial<ExperimentJourney>) => {
    setJourney((current) => {
      const next = mergeJourney({
        ...current, ...patch,
        prelab: { ...current.prelab, ...(patch.prelab ?? {}) },
        capture: { ...current.capture, ...(patch.capture ?? {}) },
        identification: { ...current.identification, ...(patch.identification ?? {}) },
        inversion: { ...current.inversion, ...(patch.inversion ?? {}) },
        archive: { ...current.archive, ...(patch.archive ?? {}) },
      });
      return JSON.stringify({ ...next, updatedAt: 0 }) === JSON.stringify({ ...current, updatedAt: 0 }) ? current : next;
    });
  }, []);
  const resetExperiment = useCallback(() => {
    if (journeySaveTimerRef.current) clearTimeout(journeySaveTimerRef.current);
    const fresh = structuredClone(emptyJourney);
    journeySavedSignatureRef.current = JSON.stringify({ ...fresh, updatedAt: 0 });
    setJourney(fresh);
    setAnalyzeSignal((value) => value + 1);
    setActive("analysis");
    if (authenticated) void fetch("/api/journey", { method: "DELETE" }).catch(() => undefined);
    toast.success("本次实验已完成，工作区已重置");
  }, [authenticated]);
  useEffect(() => {
    const fresh = structuredClone(emptyJourney);
    journeySavedSignatureRef.current = JSON.stringify({ ...fresh, updatedAt: 0 });
    setJourney(fresh);
    if (!authenticated) { journeyLoadedRef.current = true; return; }
    fetch("/api/journey", { method: "DELETE" })
      .catch(() => undefined)
      .finally(() => { journeyLoadedRef.current = true; });
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated) return;
    if (!journeyLoadedRef.current) return;
    const signature = JSON.stringify({ ...journey, updatedAt: 0 });
    if (signature === journeySavedSignatureRef.current) return;
    if (journeySaveTimerRef.current) clearTimeout(journeySaveTimerRef.current);
    journeySaveTimerRef.current = setTimeout(() => {
      journeySavedSignatureRef.current = signature;
      void fetch("/api/journey", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ journey }) })
        .then(async (response) => { if (!response.ok) throw new Error(); const data = await response.json() as { journey: ExperimentJourney }; setJourney((current) => ({ ...current, updatedAt: data.journey.updatedAt })); })
        .catch(() => { journeySavedSignatureRef.current = ""; toast.error("流程状态尚未同步，稍后会在下一次更改时重试"); });
    }, 650);
    return () => { if (journeySaveTimerRef.current) clearTimeout(journeySaveTimerRef.current); };
  }, [authenticated, journey]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [active]);
  useEffect(() => {
    const context = document.modelContext; if (!context?.registerTool) return; const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({ name: "open_learning_module", title: "打开学习模块", description: "在分光计学习助手中打开指定的真实功能模块。", inputSchema: { type: "object", properties: { module: { type: "string", enum: navItems.map((item) => item.id) } }, required: ["module"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute(input) { const value = (input as { module?: ModuleId }).module; if (!navItems.some((item) => item.id === value)) throw new Error("未知模块"); setActive(value as ModuleId); return { module: value, opened: true }; } }, { signal: lifecycle.signal })).catch(() => undefined);
    void Promise.resolve(context.registerTool({ name: "analyze_sample_spectrum", title: "分析示例光谱", description: "打开图像分析工作台并运行汞灯示例谱线分析。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute() { setActive("analysis"); setAnalyzeSignal((value) => value + 1); return { task: "A", source: "汞灯", analysisStarted: true }; } }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);
  return <main className={`app-shell ${active === "home" ? "" : "module-ambient"}`}>{active !== "assistant" && <AppHeader active={active} onChange={setActive} authenticated={authenticated} authHref={authHref} authLabel={authLabel} viewerName={viewerName} />}{active === "home" && <HomeModule navigate={setActive} />}{active === "simulator" && <SimulatorModule journey={journey} navigate={setActive} updateJourney={updateJourney} />}{active === "assistant" && <AssistantModule journey={journey} navigate={setActive} />}{active === "analysis" && <AnalysisModule key={analyzeSignal} analyzeSignal={analyzeSignal} journey={journey} updateJourney={updateJourney} authenticated={authenticated} finishExperiment={resetExperiment} />}{active === "records" && <RecordsModule authenticated={authenticated} authHref={authHref} />}{active !== "assistant" && <footer><span><Aperture size={16} />SPECTRA · AI 分光计实验学习助手</span></footer>}<FloatingAssistant journey={journey} authenticated={authenticated} /><Toaster position="top-center" richColors /></main>;
}
