"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Aperture, ArrowLeft, ArrowRight, BarChart3, BookOpen, Bot, Camera, Check,
  CheckCircle2, ChevronRight, CircleAlert, CircleHelp, ClipboardCheck, Clock3,
  Download, FileText, FlaskConical, History, Home,
  Lightbulb, ListChecks, LogIn, LogOut, MessageCircle, Microscope, Play, RotateCcw, Save,
  ScanLine, Send, SlidersHorizontal, Target, Telescope, Upload, Waves,
} from "lucide-react";
import { toast } from "sonner";
import Image from "next/image";
import { Toaster } from "@/components/ui/sonner";
import { Progress } from "@/components/ui/progress";
import AssistantAnswer from "./AssistantAnswer";
import AuroraField from "./AuroraField";
import {
  diffractionAngle, fitGratingFromPixels, measureGrating,
  SPECTRAL_LIBRARY, type MeasurementLine,
} from "@/lib/spectrometer";
import {
  RecordRequestError, requestRecordJson, type ExperimentImageSlot,
  type ExperimentTask, type RecordSnapshot, type SavedRecord,
} from "@/lib/experiment-record";
import { emptyJourney, mergeJourney, type ExperimentJourney } from "@/lib/experiment-journey";

type ModuleId = "home" | "simulator" | "assistant" | "analysis" | "guide" | "records";
type Peak = { x: number; xRatio: number; family: string; color: string; confidence: number; prominence: number; widthPx: number; wavelengthNm?: number };
type DetectorOptions = { prominence: number; minDistancePx: number };
type SpectrumSource = {
  preview: string | null; fileName: string; width: number; height: number;
  rawIntensity: number[]; luminanceIntensity: number[]; chromaIntensity: number[]; red: number[]; green: number[]; blue: number[];
  overexposed: boolean; sharpnessOk: boolean; tilt: number; bandWidth: number; sample?: boolean;
};
type ImageAnalysis = SpectrumSource & { smoothIntensity: number[]; peaks: Peak[] };
type ReferenceMarker = { wavelengthNm: number; xRatio: number };
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
  { title: "峰值检测", detail: "自适应条数", icon: Waves },
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

function detectZeroOrder(source: SpectrumSource, spectralPeaks: Peak[]) {
  if (!spectralPeaks.length) return null;
  const firstSpectrumX = Math.min(...spectralPeaks.map((peak) => peak.x));
  const smooth = smoothIntensity(source.luminanceIntensity, 2);
  const end = Math.max(4, Math.floor(firstSpectrumX - Math.max(8, source.width * .012)));
  let bestX = -1, bestProminence = 0;
  for (let x = 3; x < end - 3; x++) {
    if (smooth[x] <= smooth[x - 1] || smooth[x] < smooth[x + 1]) continue;
    const radius = Math.max(8, Math.round(source.width * .018));
    const left = smooth.slice(Math.max(0, x - radius), x);
    const right = smooth.slice(x + 1, Math.min(end, x + radius + 1));
    if (!left.length || !right.length) continue;
    const prominence = smooth[x] - Math.max(Math.min(...left), Math.min(...right));
    if (prominence > bestProminence) { bestProminence = prominence; bestX = x; }
  }
  if (bestX < 0 || bestProminence < .018) return null;
  const y1 = smooth[bestX - 1], y2 = smooth[bestX], y3 = smooth[bestX + 1];
  const denominator = y1 - 2 * y2 + y3;
  const offset = Math.abs(denominator) > 1e-9 ? Math.max(-.5, Math.min(.5, .5 * (y1 - y3) / denominator)) : 0;
  return { x: bestX + offset, uncertaintyPx: Math.max(.25, Math.min(1.5, .12 / Math.max(bestProminence, .01))), prominence: bestProminence };
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

function inferZeroFromMercuryLines(markers: ReferenceMarker[], imageWidth: number) {
  if (markers.length < 3) return null;
  const dNm = 3333.333;
  const rows = markers.map((marker) => ({
    x: marker.xRatio * imageWidth,
    t: Math.tan(Math.asin(marker.wavelengthNm / dNm)),
  }));
  const meanX = rows.reduce((sum, row) => sum + row.x, 0) / rows.length;
  const meanT = rows.reduce((sum, row) => sum + row.t, 0) / rows.length;
  const denominator = rows.reduce((sum, row) => sum + (row.t - meanT) ** 2, 0);
  if (denominator <= 0) return null;
  const L = rows.reduce((sum, row) => sum + (row.t - meanT) * (row.x - meanX), 0) / denominator;
  const x = meanX - L * meanT;
  const residuals = rows.map((row) => row.x - (x + L * row.t));
  const rmsePx = Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / rows.length);
  if (!Number.isFinite(x) || !Number.isFinite(L) || Math.abs(L) < imageWidth || rmsePx > Math.max(5, imageWidth * .012)) return null;
  return { x, uncertaintyPx: Math.max(.5, rmsePx), prominence: 0, inferred: true, L };
}

function applyMercuryFiveLineModel(image: ImageAnalysis) {
  // Reference matching must not mutate the detector output. Unknown lines and
  // rejected artefacts remain visible for review instead of being forced into
  // a fixed five-peak result.
  return image;
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
  return { preview: null, fileName: "零级与单侧一级汞谱示例", width, height, rawIntensity, luminanceIntensity, chromaIntensity, red, green, blue, overexposed: false, sharpnessOk: true, tilt: .7, bandWidth: width, sample: true };
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

function AppHeader({ active, onChange, authenticated, authHref, authLabel, viewerName }: { active: ModuleId; onChange: (id: ModuleId) => void; authenticated: boolean; authHref: string; authLabel: string; viewerName: string | null }) {
  return (
    <header className="topbar">
      <button className="brand" onClick={() => onChange("home")} aria-label="返回首页">
        <span className="brand-mark"><Aperture size={19} /></span>
        <span><strong>SPECTRA</strong><small>分光计实验学习助手</small></span>
      </button>
      <nav className="main-nav" aria-label="主导航">
        {navItems.map((item) => <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => onChange(item.id)}>{item.label}</button>)}
      </nav>
      <div className="topbar-actions">
        <button className="ghost-button" onClick={() => toast.info("主流程：虚拟预习 → 采集质检 → 零级与汞线匹配 → d 与不确定度 → 云端复盘")}><CircleHelp size={17} /> 流程帮助</button>
        <a className="auth-link" href={authHref} target="_top" title={viewerName ?? authLabel}>{authenticated ? <LogOut size={16} /> : <LogIn size={16} />}{authLabel}</a>
      </div>
    </header>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="module-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{description && <p className="heading-description">{description}</p>}</div>{action}</div>;
}

function FlowBanner({ stage, navigate }: { stage: string; navigate: (id: ModuleId) => void }) {
  return <div className="flow-banner"><span><ListChecks size={16} />当前阶段：{stage}</span><button onClick={() => navigate("guide")}><ArrowLeft size={15} />返回实验流程</button></div>;
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
          <p>课前用虚拟仪器完成预习，课中从真实照片自动检查零级、汞线与拟合质量，课后沿五阶段证据复盘。</p>
          <div className="hero-actions"><button className="primary-action" onClick={() => navigate("guide")}><ListChecks size={18} />开始实验流程</button><button className="secondary-action" onClick={() => navigate("simulator")}><Play size={17} />进入虚拟预习</button></div>
        </div>
        <AnalysisGlassPanel />
        <div className="hero-scroll-cue" aria-hidden="true"><span>向下探索</span><i /></div>
      </section>
      <section className="pain-grid">
        {[
          { icon: Telescope, ask: "预习只看讲义，真机还是不会调？", answer: "先在虚拟分光计中瞄准、读数、拟合 d。", target: "simulator" as ModuleId },
          { icon: ScanLine, ask: "零级、黄双线或照片质量，错在哪不清楚？", answer: "真实图像自动质检与认线，阻塞原因直接给出证据。", target: "analysis" as ModuleId },
          { icon: History, ask: "做完只剩一个结果，过程无法复盘？", answer: "保存峰值、匹配、拟合与诊断，按时间轴回放。", target: "records" as ModuleId },
        ].map((item, index) => <button className="pain-card" key={item.ask} onClick={() => navigate(item.target)}><span className="pain-number">0{index + 1}</span><item.icon size={22} /><strong>{item.ask}</strong><p>{item.answer}</p><em>打开模块 <ArrowRight size={14} /></em></button>)}
      </section>
    </div>
  );
}

function SimulatorModule({ journey, navigate, updateJourney }: { journey: ExperimentJourney; navigate: (id: ModuleId) => void; updateJourney: (patch: Partial<ExperimentJourney>) => void }) {
  const lines = SPECTRAL_LIBRARY.mercury.map((line) => ({ ...line, angle: diffractionAngle(line.wavelengthNm, 3.333, 1) })).filter((line) => line.angle !== null);
  const [angle, setAngle] = useState(9.43);
  const [captured, setCaptured] = useState<MeasurementLine[]>(() => lines.slice(0, journey.prelab.capturedLines).map((line) => ({ wavelengthNm: line.wavelengthNm, thetaDeg: line.angle ?? 0 })));
  const nearest = lines.reduce((best, line) => Math.abs((line.angle ?? 0) - angle) < Math.abs((best.angle ?? 0) - angle) ? line : best, lines[0]);
  const aligned = nearest && Math.abs((nearest.angle ?? 0) - angle) < .12;
  const fit = captured.length >= 2 ? measureGrating(captured) : null;
  useEffect(() => {
    updateJourney({ prelab: { source: "mercury", capturedLines: captured.length, dUm: fit?.dUm ?? null, rmseNm: fit?.rmseNm ?? null } });
  }, [captured.length, fit?.dUm, fit?.rmseNm, updateJourney]);
  const capture = () => {
    if (!aligned || !nearest) return toast.warning("先缓慢转动望远镜，让谱线与叉丝重合");
    if (captured.some((item) => item.wavelengthNm === nearest.wavelengthNm)) return toast.info("这条谱线已经记录");
    setCaptured((items) => [...items, { wavelengthNm: nearest.wavelengthNm, thetaDeg: angle }]);
    toast.success(`已记录 ${nearest.wavelengthNm.toFixed(2)} nm`);
  };
  return (
    <div className="module-page">
      <FlowBanner stage="1 / 5 · 虚拟预习" navigate={navigate} />
      <PageHeading eyebrow="预习 · 虚拟分光计" title="先在屏幕上完成一次真实逻辑的实验。" description="拖转望远镜、让谱线与叉丝重合、记录角度，再用光栅方程拟合 d。虚拟仪器用于预习，数值以真机为准。" />
      <div className="sim-grid">
        <section className="panel simulator-panel">
          <div className="sim-toolbar">
            <div className="segmented"><button className="active">汞灯已知谱线</button></div>
            <label>测量范围<select value="1" disabled><option value="1">单侧一级</option></select></label>
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
          <div className="task-body"><p className="task-tip"><Lightbulb size={16} />按波长从短到长瞄准一级谱线，至少记录两条；拟合生成后阶段自动完成。</p><div className="target-list">{lines.slice(0, 5).map((line) => { const done = captured.some((item) => item.wavelengthNm === line.wavelengthNm); return <button key={line.wavelengthNm} onClick={() => setAngle(line.angle ?? angle)}><i style={{ background: line.color }} /><span>{line.wavelengthNm.toFixed(2)} nm<small>{done ? `${captured.find((item) => item.wavelengthNm === line.wavelengthNm)?.thetaDeg.toFixed(2)}°` : "待瞄准"}</small></span>{done ? <CheckCircle2 size={18} /> : <Target size={17} />}</button>; })}</div>{fit ? <div className="fit-result"><small>预习证据已生成</small><strong>d = {fit.dUm.toFixed(3)} μm</strong><span>{captured.length} 条谱线 · RMSE {fit.rmseNm.toFixed(2)} nm</span><button className="primary-action compact-action" onClick={() => navigate("guide")}>返回流程继续<ArrowRight size={15} /></button></div> : <div className="fit-placeholder"><BarChart3 size={28} /><p>记录两条以上谱线后生成<br />sinθ–λ 线性拟合</p></div>}<button className="reset-button" onClick={() => setCaptured([])}><RotateCcw size={15} />重新练习</button></div>
        </aside>
      </div>
    </div>
  );
}

function AssistantModule({ journey, navigate, authenticated, authHref }: { journey: ExperimentJourney; navigate: (id: ModuleId) => void; authenticated: boolean; authHref: string }) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; text: string; source?: string }[]>([{ role: "assistant", text: "你好，我是你的 AI 助教。我重点辅导分光计与光栅实验，也可以帮助你理解课程知识、润色文字和分析编程问题。直接告诉我你现在遇到的困难。", source: "AI 助教 · 物理实验与通用问答" }]);
  const [sending, setSending] = useState(false);
  const ask = async (preset?: string) => {
    if (!authenticated) return toast.info("登录后即可使用 AI 助教");
    const value = (preset ?? question).trim(); if (!value || sending) return;
    setMessages((items) => [...items, { role: "user", text: value }]); setQuestion(""); setSending(true);
    const context = `当前实验状态：预习${journey.prelab.capturedLines >= 2 ? "已完成" : "未完成"}；照片${journey.capture.imageCount}张，曝光${journey.capture.exposureOk ? "通过" : "未通过"}，清晰度${journey.capture.sharpnessOk ? "通过" : "未通过"}；零级${journey.capture.zeroX ?? "未找到"}；匹配参考线${journey.identification.matchedLines}条；反演${journey.inversion.reportable ? "可报告" : `被阻塞：${journey.inversion.blockReason}` }。助教只能解释，不能更改完成状态。`;
    try { const response = await fetch("/api/ai/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: `${context}\n\n学生问题：${value}` }) }); const data = await response.json() as { answer?: string; sources?: string[]; error?: string }; if (!response.ok || !data.answer) throw new Error(data.error || "AI 助教暂时不可用"); setMessages((items) => [...items, { role: "assistant", text: data.answer!, source: data.sources?.[0] }]); }
    catch (error) { setMessages((items) => [...items, { role: "assistant", text: error instanceof Error ? error.message : "AI 助教暂时不可用，请稍后重试。", source: "系统提示" }]); }
    finally { setSending(false); }
  };
  return <div className="module-page"><FlowBanner stage="实验助教 · 只读当前流程数据" navigate={navigate} /><PageHeading eyebrow="AI 助教 · 当前实验上下文" title="分析实验现象，帮你理清下一步。" description={`当前匹配 ${journey.identification.matchedLines} 条参考线；${journey.inversion.reportable ? "反演结果已通过检查" : journey.inversion.blockReason}`} />
    {!authenticated && <p className="auth-notice">匿名访问可浏览实验内容；<a href={authHref} target="_top">登录 ChatGPT</a> 后可使用 AI 助教并保存个人实验记录。</p>}
    <div className="assistant-grid"><aside className="question-bank panel"><div className="panel-title"><div><span className="step-index"><BookOpen size={15} /></span><h2>试试这样问</h2></div></div><div className="quick-questions">{["为什么黄光是两条？", "帮我制定一份复习计划", "解释一个陌生概念", "帮我润色一段文字", "给我一个编程思路"].map((text) => <button key={text} onClick={() => ask(text)}><MessageCircle size={15} />{text}<ChevronRight size={15} /></button>)}</div><div className="knowledge-scope"><strong>能力范围</strong><span>分光计实验</span><span>物理实验</span><span>课程答疑</span><span>写作润色</span><span>编程分析</span></div></aside>
      <section className="chat-panel panel"><div className="chat-status"><span><i />{authenticated ? "AI 助教在线" : "登录后启用 AI 助教"}</span><em>物理实验 · 通用问答</em></div><div className="messages">{messages.map((message, index) => <div key={index} className={`message ${message.role}`}><span>{message.role === "assistant" ? <Bot size={17} /> : "你"}</span><div>{message.role === "assistant" ? <AssistantAnswer>{message.text}</AssistantAnswer> : <p>{message.text}</p>}{message.source && <small><BookOpen size={12} />{message.source}</small>}</div></div>)}{sending && <div className="message assistant"><span><Bot size={17} /></span><div><p>AI 助教正在分析问题…</p></div></div>}</div><form className="chat-input" onSubmit={(e) => { e.preventDefault(); ask(); }}><textarea value={question} onChange={(e) => setQuestion(e.target.value)} disabled={!authenticated} placeholder={authenticated ? "问分光计实验、课程、写作、编程或日常问题…" : "登录后即可提问"} /><button type="submit" aria-label="发送问题" disabled={!authenticated}><Send size={18} /></button></form><p className="chat-hint">AI 可能出错，重要信息请结合可靠来源核实。</p></section></div>
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
    <div className="selected-markers">{markers.length ? markers.map((marker) => <button key={marker.wavelengthNm} onClick={() => onRemove(marker.wavelengthNm)} title="移除此标记"><i style={{ background: lineColor(marker.wavelengthNm) }} />{marker.wavelengthNm.toFixed(2)} nm<span>×</span></button>) : <span>尚未选择参考线；画内有零级至少标记 2 条，画外零级至少标记 3 条。</span>}</div>
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

function AnalysisModule({ analyzeSignal = 0, journey, navigate, updateJourney, authenticated, finishExperiment }: { analyzeSignal?: number; journey: ExperimentJourney; navigate: (id: ModuleId) => void; updateJourney: (patch: Partial<ExperimentJourney>) => void; authenticated: boolean; finishExperiment: () => void }) {
  const task: ExperimentTask = "A";
  const [detector, setDetector] = useState<DetectorOptions>({ prominence: .018, minDistancePx: 3 });
  const [aSource, setASource] = useState<SpectrumSource | null>(() => analyzeSignal > 0 ? buildSampleSource() : null);
  const [aMarkers, setAMarkers] = useState<ReferenceMarker[]>(() => analyzeSignal > 0 ? SPECTRAL_LIBRARY.mercury.map((line) => ({ wavelengthNm: line.wavelengthNm, xRatio: (100 + 4000 * Math.tan(Math.asin(line.wavelengthNm / 3333))) / 1000 })) : []);
  const [selectedWavelength, setSelectedWavelength] = useState(546.07);
  const [zeroX, setZeroX] = useState(100);
  const [scaleL, setScaleL] = useState(4000);
  const [aComplete, setAComplete] = useState(analyzeSignal > 0);
  const [busy, setBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState("");
  const [repeatSources, setRepeatSources] = useState<SpectrumSource[]>([]);
  const pendingImagesRef = useRef<PendingImages>({ A: {} });

  const aImage = useMemo(() => aSource ? applyMercuryFiveLineModel(detectSpectrumPeaks(aSource, detector)) : null, [aSource, detector]);
  const directZeroDetection = useMemo(() => aImage ? detectZeroOrder(aImage, aImage.peaks) : null, [aImage]);
  const inferredZeroDetection = useMemo(() => aImage && !directZeroDetection ? inferZeroFromMercuryLines(aMarkers, aImage.width) : null, [aImage, aMarkers, directZeroDetection]);
  const zeroDetection = directZeroDetection ?? inferredZeroDetection;
  const effectiveZeroX = zeroDetection?.x ?? zeroX;

  useEffect(() => () => { if (aSource?.preview) URL.revokeObjectURL(aSource.preview); }, [aSource?.preview]);

  const loadSample = () => {
    sync.resetSync();
    const sample = buildSampleSource(); const positions = SPECTRAL_LIBRARY.mercury.map((line) => ({ wavelengthNm: line.wavelengthNm, xRatio: (100 + 4000 * Math.tan(Math.asin(line.wavelengthNm / 3333))) / sample.width }));
    setASource(sample); setRepeatSources([]); setAMarkers(positions); setZeroX(100); setScaleL(4000); setAComplete(true); setSelectedWavelength(546.07);
  };
  const upload = async (files?: FileList | File[]) => {
    const selectedFiles = files ? Array.from(files).slice(0, 3) : [];
    if (!selectedFiles.length) return; setBusy(true);
    try {
      const sources = await Promise.all(selectedFiles.map(analyzeImageFile));
      const source = sources[0];
      const detected = detectSpectrumPeaks(source, detector);
      const analyzed = applyMercuryFiveLineModel(detected);
      const automaticMarkers = autoMatchMercuryPeaks(analyzed);
      pendingImagesRef.current.A.primary = selectedFiles[0];
      if (selectedFiles[1]) pendingImagesRef.current.A.repeat_2 = selectedFiles[1];
      if (selectedFiles[2]) pendingImagesRef.current.A.repeat_3 = selectedFiles[2];
      setASource(source); setRepeatSources(sources.slice(1)); setAMarkers(automaticMarkers); setAComplete(false);
      const zero = detectZeroOrder(analyzed, analyzed.peaks);
      if (zero) setZeroX(zero.x);
      toast.success(automaticMarkers.length >= (zero ? 2 : 3) ? `已识别候选谱线并匹配 ${automaticMarkers.length} 条参考线` : "图像读取完成，请补充或修正参考线标记");
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
  };
  const removeMarker = (wavelengthNm: number) => setAMarkers((items) => items.filter((item) => item.wavelengthNm !== wavelengthNm));

  const repeatDValues = useMemo(() => repeatSources.flatMap((source) => {
    const image = applyMercuryFiveLineModel(detectSpectrumPeaks(source, detector));
    const markers = autoMatchMercuryPeaks(image);
    const zero = detectZeroOrder(image, image.peaks) ?? inferZeroFromMercuryLines(markers, image.width);
    const minimumReferences = detectZeroOrder(image, image.peaks) ? 2 : 3;
    if (!zero || markers.length < minimumReferences || image.overexposed || !image.sharpnessOk) return [];
    try {
      const result = fitGratingFromPixels(markers.map((marker) => ({ wavelengthNm: marker.wavelengthNm, x: marker.xRatio * image.width, uncertaintyPx: .35 })), zero.x, image.width, { zeroUncertaintyPx: zero.uncertaintyPx, wavelengthUncertaintyNm: .01 });
      return result.reportable ? [result.dUm] : [];
    } catch { return []; }
  }), [repeatSources, detector]);

  const aResult = useMemo(() => {
    const minimumReferences = directZeroDetection ? 2 : 3;
    if (!aComplete || !aImage || aMarkers.length < minimumReferences) return null;
    try {
      const provisional = fitGratingFromPixels(aMarkers.map((marker) => ({ wavelengthNm: marker.wavelengthNm, x: marker.xRatio * aImage.width, uncertaintyPx: .35 })), effectiveZeroX, aImage.width, { zeroUncertaintyPx: zeroDetection?.uncertaintyPx ?? .5, wavelengthUncertaintyNm: .01 });
      return fitGratingFromPixels(aMarkers.map((marker) => ({ wavelengthNm: marker.wavelengthNm, x: marker.xRatio * aImage.width, uncertaintyPx: .35 })), effectiveZeroX, aImage.width, { zeroUncertaintyPx: zeroDetection?.uncertaintyPx ?? .5, wavelengthUncertaintyNm: .01, repeatDValuesUm: [provisional.dUm, ...repeatDValues] });
    } catch { return null; }
  }, [aComplete, aImage, aMarkers, effectiveZeroX, zeroDetection, directZeroDetection, repeatDValues]);

  const yellowDoubletResolved = aMarkers.some((item) => item.wavelengthNm === 576.96) && aMarkers.some((item) => item.wavelengthNm === 579.07) && (() => { const yellow = aMarkers.filter((item) => item.wavelengthNm >= 576); return yellow.length === 2 && Math.abs(yellow[1].xRatio - yellow[0].xRatio) * (aImage?.width ?? 0) >= 1.5; })();
  const repeatsValid = repeatSources.length === repeatDValues.length;
  const minimumReferences = directZeroDetection ? 2 : 3;
  const hasResult = Boolean(aResult?.reportable && aMarkers.length >= minimumReferences && zeroDetection && aImage?.sharpnessOk && !aImage.overexposed && repeatsValid);
  const blockReason = !aImage ? "等待上传光谱照片" : aImage.overexposed ? "照片过曝，请降低曝光后重拍" : !aImage.sharpnessOk ? "谱线不够清晰，请重新对焦后拍摄" : aMarkers.length < minimumReferences ? `当前几何条件至少需要 ${minimumReferences} 条可靠参考线` : !zeroDetection ? "无法由已匹配参考线确定画外零级，请继续标记" : !repeatsValid ? "至少一张重复照片未通过认线或质量检查" : aResult && !aResult.reportable ? aResult.blockReason : "";
  const status = !aImage ? "待上传" : hasResult ? "已完成" : blockReason ? "被阻塞" : "可计算";

  useEffect(() => {
    updateJourney({
      capture: { imageCount: aImage ? 1 + repeatSources.length : 0, exposureOk: Boolean(aImage && !aImage.overexposed && repeatSources.every((item) => !item.overexposed)), sharpnessOk: Boolean(aImage?.sharpnessOk && repeatSources.every((item) => item.sharpnessOk)), zeroX: zeroDetection?.x ?? null, peakCount: aImage?.peaks.length ?? 0 },
      identification: { matchedLines: aMarkers.length, yellowDoubletResolved },
      inversion: { reportable: hasResult, dUm: hasResult && aResult ? aResult.dUm : null, expandedUncertaintyUm: hasResult && aResult ? aResult.expandedUncertaintyUm : null, correlation: aResult?.identifiability.correlation ?? null, profileLowUm: aResult?.identifiability.profileLowUm ?? null, profileHighUm: aResult?.identifiability.profileHighUm ?? null, boundaryHit: aResult?.identifiability.boundaryHit ?? false, blockReason: hasResult ? "" : blockReason },
    });
  }, [aImage, repeatSources, aMarkers.length, yellowDoubletResolved, zeroDetection?.x, hasResult, aResult, blockReason, updateJourney]);

  const recordSnapshot = useMemo<RecordSnapshot>(() => {
    const resultValue = hasResult && aResult ? `${aResult.dUm.toFixed(3)} ± ${aResult.expandedUncertaintyUm.toFixed(3)} μm (k=2)` : "进行中";
    const needsReview = Boolean(aImage && !hasResult);
    const steps: string[] = [];
    if (journey.prelab.capturedLines >= 2 && journey.prelab.dUm !== null) steps.push("虚拟预习");
    if (aImage && !aImage.overexposed && aImage.sharpnessOk) steps.push("光谱采集与质量检查");
    if (zeroDetection && aMarkers.length >= minimumReferences) steps.push("零级定位与参考线匹配");
    if (hasResult) steps.push("d 反演及不确定度评估", "云端归档与实验复盘");
    const payload = {
      state: { detector, zeroX: effectiveZeroX, scaleL, complete: aComplete, sample: Boolean(aSource?.sample) },
      referenceMarkers: aMarkers,
      result: aResult,
      processing: { peaks: aImage?.peaks.length ?? 0, overexposed: Boolean(aImage?.overexposed), sharpnessOk: Boolean(aImage?.sharpnessOk), zeroDetection },
      evidence: { stages: ["虚拟预习", "光谱采集与质量检查", "零级定位与汞线匹配", "d 反演及不确定度评估", "云端归档与实验复盘"], limitation: "单张照片时不评定重复性；镜头畸变仅作为模型偏差诊断。" },
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
  }, [aResult, aImage, hasResult, detector, effectiveZeroX, scaleL, aComplete, aSource?.sample, aMarkers, diagnosis, zeroDetection, blockReason, journey.prelab, minimumReferences]);

  const hydrateRecord = useCallback(async (record: SavedRecord) => {
    const state = record.payload.state && typeof record.payload.state === "object" ? record.payload.state as Record<string, unknown> : {};
    const markers = Array.isArray(record.payload.referenceMarkers) ? record.payload.referenceMarkers.filter((item): item is ReferenceMarker => Boolean(item) && typeof item === "object" && typeof (item as ReferenceMarker).wavelengthNm === "number" && typeof (item as ReferenceMarker).xRatio === "number") : [];
    const savedDetector = state.detector && typeof state.detector === "object" ? state.detector as Partial<DetectorOptions> : null;
    if (savedDetector && typeof savedDetector.prominence === "number" && typeof savedDetector.minDistancePx === "number") setDetector({ prominence: savedDetector.prominence, minDistancePx: savedDetector.minDistancePx });
    if (record.task !== "A") return;
    setDiagnosis(record.diagnosis);
    setAMarkers(markers);
    if (typeof state.zeroX === "number") setZeroX(state.zeroX);
    if (typeof state.scaleL === "number") setScaleL(state.scaleL);
    setAComplete(Boolean(state.complete));
    if (state.sample) { setASource(buildSampleSource()); setRepeatSources([]); }
    else {
      setASource(record.imageUrls.primary ? await sourceFromSyncedImage(record.imageUrls.primary).catch(() => null) : null);
      setRepeatSources((await Promise.all([record.imageUrls.repeat_2, record.imageUrls.repeat_3].filter((url): url is string => Boolean(url)).map((url) => sourceFromSyncedImage(url).catch(() => null)))).filter((source): source is SpectrumSource => Boolean(source)));
    }
  }, []);

  const sync = useExperimentSync({ task, enabled: Boolean(aImage), authenticated, snapshot: recordSnapshot, pendingImagesRef, onRemoteRecord: hydrateRecord });
  const syncLabel = !authenticated ? "登录后可保存到云端" : sync.phase === "loading" ? "正在读取云端记录" : sync.phase === "pending" ? "有更改待同步" : sync.phase === "saving" ? "正在同步" : sync.phase === "retrying" ? "同步失败，正在重试" : sync.phase === "error" ? "同步失败" : sync.phase === "synced" && sync.lastSyncedAt ? `已同步 ${new Date(sync.lastSyncedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "自动同步已就绪";
  useEffect(() => {
    if (hasResult && sync.phase === "synced" && sync.lastSyncedAt) updateJourney({ archive: { synced: true, recordId: null, syncedAt: sync.lastSyncedAt } });
  }, [hasResult, sync.phase, sync.lastSyncedAt, updateJourney]);

  const runPrimary = () => {
    if (!aImage) return toast.warning("请先上传光谱照片");
    if (aImage.overexposed) return toast.warning("照片过曝，结果已阻止；请降低曝光后重新拍摄");
    if (!aImage.sharpnessOk) return toast.warning("照片清晰度不足，结果已阻止；请重新对焦");
    if (!zeroDetection) return toast.warning("未能由画面或已匹配参考线确定零级；请继续标记");
    if (aMarkers.length < minimumReferences) return toast.warning(`当前几何条件至少需要 ${minimumReferences} 条可靠参考线`);
    setAComplete(true);
  };
  const resetTask = () => {
    sync.resetSync();
    setDiagnosis("");
    setDetector({ prominence: .018, minDistancePx: 3 }); setSelectedWavelength(546.07);
    setASource(null); setRepeatSources([]); setAMarkers([]); setZeroX(100); setScaleL(4000); setAComplete(false);
  };
  const summary = [
    ["零级位置", zeroDetection ? `${zeroDetection.x.toFixed(2)} px${"inferred" in zeroDetection ? "（参考线反推）" : ""}` : "未找到"], ["匹配参考线", `${aMarkers.length} 条`], ["候选谱线", `${aImage?.peaks.length ?? 0} 条`], ["光栅常数 d", hasResult && aResult ? `${aResult.dUm.toFixed(3)} μm` : "未形成结果"],
  ];

  return <div className="module-page analysis-page">
    <FlowBanner stage="2–4 / 5 · 采集、识别与反演" navigate={navigate} />
    <PageHeading eyebrow="实验 · 图像分析工作台" title="从光谱照片到可复核的测量结果。" description="调整检测参数、标记参考谱线，再沿强度曲线、拟合残差和处理过程检查每一步。" />
    <div className="analysis-workbench">
      <aside className="panel parameter-panel"><div className="analysis-card-heading"><span><SlidersHorizontal size={18} /></span><div><h2>测量参数</h2><p>优先检测 x₀；画外零级由已匹配参考线联合标定。</p></div></div><div className="parameter-form">
        <label>零级位置 x₀（独立检测）<input type="number" value={Number(effectiveZeroX.toFixed(2))} disabled /></label><label>成像尺度 L（主拟合）<input type="number" value={aResult ? Number(aResult.L.toFixed(1)) : scaleL} disabled /></label>
        <label>峰值突出度 <output>{detector.prominence.toFixed(3)}</output><input type="range" min=".005" max=".2" step=".005" value={detector.prominence} onChange={(event) => setDetector((value) => ({ ...value, prominence: Number(event.target.value) }))} /></label>
        <label>最小峰间距（px）<input type="number" min="2" max="64" value={detector.minDistancePx} onChange={(event) => setDetector((value) => ({ ...value, minDistancePx: Math.min(64, Math.max(2, Number(event.target.value))) }))} /></label>
        <div className="parameter-buttons"><button className="reset-button parameter-reset" onClick={resetTask}><RotateCcw size={15} />恢复默认</button><button className="reset-button parameter-reset sample-button" onClick={loadSample}><Play size={15} />加载示例</button></div>
      </div></aside>
      <section className="panel calibration-panel"><div className="analysis-card-heading wide"><span><Waves size={18} /></span><div><h2>光栅常数反演</h2><p>候选谱线数量不限；按实际可见谱线自适应检测并匹配参考库。</p></div><em className={`analysis-status ${status === "已完成" ? "done" : ""}`}>{status}</em></div>
        <SpectrumStage image={aImage} markers={aMarkers} onMark={addMarker} caption={aImage?.sample ? "示例图像 · 一级汞灯光谱" : "参考图像 · 已完成强度提取"} />
        <MarkerPicker selected={selectedWavelength} setSelected={setSelectedWavelength} markers={aMarkers} onClear={() => setAMarkers([])} onRemove={removeMarker} image={aImage} onCandidate={addMarker} />
        <div className="analysis-actions"><label className="upload-button"><Upload size={17} />上传 1–3 张照片<input type="file" accept="image/*" multiple hidden onChange={(event) => upload(event.target.files ?? undefined)} /></label><label className="camera-button"><Camera size={17} />手机拍摄<input type="file" accept="image/*" capture="environment" hidden onChange={(event) => upload(event.target.files ?? undefined)} /></label><button className="analyze-button" disabled={busy} onClick={runPrimary}><Play size={17} />{busy ? "处理中…" : "执行测量"}</button></div>
        {aImage && <div className="quality-row"><span><i className={!zeroDetection ? "warn" : ""} />{zeroDetection ? `零级 ${zeroDetection.x.toFixed(2)} px${"inferred" in zeroDetection ? " · 参考线反推" : ""}` : "未找到零级"}</span><span><i />候选峰 {aImage.peaks.length} 条</span><span><i className={aImage.overexposed ? "warn" : ""} />{aImage.overexposed ? "高光偏多" : "曝光正常"}</span><span><i className={!aImage.sharpnessOk ? "warn" : ""} />{aImage.sharpnessOk ? "清晰度通过" : "清晰度不足"}</span></div>}
        {blockReason && aImage && <p className="inline-warning"><CircleAlert size={15} />{blockReason}</p>}
      </section>
    </div>
    <section className="panel overview-panel"><div><h2>结果总览</h2><p>{!authenticated ? "匿名状态可完成本地分析；登录后自动保存实验过程。" : hasResult ? "关键参数、最终结果与残差会自动同步。" : "上传图片后即开始保存实验过程，完成计算后自动更新结果。"}</p><span className={`sync-state ${sync.phase}`} aria-live="polite">{sync.phase === "error" ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}{syncLabel}</span>{sync.phase === "error" && sync.errorMessage && <small className="sync-error">{sync.errorMessage}</small>}</div><div className="overview-metrics">{summary.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div>{hasResult && (!authenticated || sync.currentSnapshotSynced) ? <button className="primary-action" onClick={finishExperiment}><CheckCircle2 size={16} />完成本次实验</button> : <button className="secondary-action" onClick={() => sync.phase === "error" && !aImage ? sync.retryLoad() : void sync.syncNow()} disabled={!authenticated || sync.phase === "saving" || sync.phase === "retrying" || (!aImage && sync.phase !== "error")}><Save size={16} />{sync.phase === "error" && !aImage ? "重新读取" : sync.phase === "error" ? "立即重试" : "立即同步"}</button>}</section>
    <section className="panel review-note-panel"><div className="analysis-card-heading"><span><ClipboardCheck size={18} /></span><div><h2>异常诊断与复核意见</h2><p>记录异常现象、可能原因和复核结论；输入内容会随实验记录自动同步。</p></div></div><textarea value={diagnosis} maxLength={2000} onChange={(event) => setDiagnosis(event.target.value)} placeholder="例如：黄色双线未完全分离，已重新调整狭缝并复测。" /></section>
    <div className="analysis-results-grid">
      <section className="panel intensity-panel"><div className="analysis-card-heading wide"><span><Waves size={18} /></span><div><h2>强度剖面与谱线标注</h2><p>曲线、候选峰和人工参考标记来自当前图像数据。</p></div></div><IntensityChart image={aImage} markers={aMarkers} title="光谱横向强度剖面" /></section>
      <div className="analysis-result-stack"><section className="panel final-result-card"><div className="analysis-card-heading"><span><BarChart3 size={18} /></span><div><h2>最终光栅结果</h2><p>仅当可辨识性、边界与质量检查全部通过时生成。</p></div></div>{hasResult && aResult ? <div className="final-measure"><small>光栅常数 d · {aResult.uncertaintyLabel}</small><strong>{aResult.dUm.toFixed(3)} <em>± {aResult.expandedUncertaintyUm.toFixed(3)} μm</em></strong><p>U = 2u<sub>c</sub>，k = {aResult.coverageFactor} · {aResult.linesPerMm.toFixed(1)} 线/mm</p><p>{zeroDetection && "inferred" in zeroDetection ? "五线反推" : "独立"} x₀ = {aResult.x0.toFixed(2)} px · 拟合 |L| = {Math.abs(aResult.L).toFixed(1)} px</p></div> : <div className="result-placeholder"><FlaskConical size={28} /><span>{aResult ? `候选拟合不可报告：${aResult.blockReason || blockReason}` : "等待执行测量"}</span></div>}</section>
        <section className="panel residual-card"><div className="analysis-card-heading"><span><Target size={18} /></span><div><h2>拟合残差复核</h2><p>逐条检查预测值与参考值。</p></div></div>{aResult ? <div className="residual-table"><div><b>标准 λ</b><b>换算 θ</b><b>残差</b></div>{aResult.points.map((point) => <div key={point.wavelengthNm}><span>{point.wavelengthNm.toFixed(2)} nm</span><span>{point.thetaDeg.toFixed(3)}°</span><strong>{point.residualNm >= 0 ? "+" : ""}{point.residualNm.toFixed(3)} nm</strong></div>)}</div> : <div className="result-placeholder compact"><Target size={25} /><span>完成计算后显示逐线残差</span></div>}</section></div>
    </div>
    {aResult && <section className="panel uncertainty-panel"><div className="analysis-card-heading wide"><span><CircleHelp size={18} /></span><div><h2>完整不确定度预算</h2><p>各标准不确定度按平方和合成 u<sub>c</sub>；覆盖因子 k=2。</p></div></div><div className="uncertainty-table"><div><b>分量</b><b>标准不确定度</b><b>评定状态</b></div>{aResult.uncertaintyBudget.map((item) => <div key={item.key}><span>{item.label}</span><strong>{item.standardUncertaintyUm === null ? "—" : `${item.standardUncertaintyUm.toFixed(4)} μm`}</strong><em>{item.status}</em></div>)}</div><div className="diagnostic-strip"><span>相关系数 <strong>{aResult.identifiability.correlation.toFixed(5)}</strong></span><span>95% 剖面区间 <strong>{aResult.identifiability.profileLowUm.toFixed(3)}–{aResult.identifiability.profileHighUm.toFixed(3)} μm</strong></span><span>边界检查 <strong>{aResult.identifiability.boundaryHit ? "命中" : "通过"}</strong></span></div></section>}
    <section className="panel process-panel"><div className="analysis-card-heading wide"><span><SlidersHorizontal size={18} /></span><div><h2>图像处理全过程</h2><p>从原始照片到物理结果，每一步都保留可复核的实际数据。</p></div></div><ProcessingTimeline image={aImage} selectedCount={aMarkers.length} resultText={aResult ? `d = ${aResult.dUm.toFixed(3)} μm` : "等待执行计算"} /></section>
  </div>;
}

const guideSteps = [
  { title: "虚拟预习", detail: "在虚拟分光计中瞄准至少两条汞线并生成拟合，建立真实操作顺序。", image: "/guide/01-align-optics.jpg", alt: "实验人员调节真实分光计", position: "center 42%", credit: "SAHAYA RAJAN S · CC0", source: "https://commons.wikimedia.org/wiki/File:Spectrometer_prism_table.jpg", target: "simulator" as ModuleId },
  { title: "光谱采集与质量检查", detail: "上传实际可见的单侧一级光谱；零级可在画内，也可由参考线标定画外位置。", image: "/guide/02-zero-order.jpg", alt: "真实光学实验台", position: "center 48%", credit: "Waifer X · CC BY 2.0", source: "https://commons.wikimedia.org/wiki/File:Optical_Bench_educational_Kit_-_Cuesta_College.jpg", target: "analysis" as ModuleId },
  { title: "自适应标定与谱线匹配", detail: "按实际谱线数量匹配参考库，并排除叉丝、刻度等伪峰；不强制固定条数。", image: "/guide/03-aim-lines.jpg", alt: "光栅产生的真实可见光谱", position: "center 47%", credit: "NOIRLab / NSF / AURA · CC BY 4.0", source: "https://commons.wikimedia.org/wiki/File:Diffraction_grating_(noao-02613).jpg", target: "analysis" as ModuleId },
  { title: "d 反演及不确定度评估", detail: "只估计数据支持的 L 与 d，并检查相关性、剖面区间、边界和完整不确定度预算。", image: "/guide/05-calculate.jpg", alt: "实验室电脑正在分析测量数据", position: "center 44%", credit: "MikeRun · CC BY-SA 4.0", source: "https://commons.wikimedia.org/wiki/File:Lab-notebook-spreadsheet-simulation.jpg", target: "analysis" as ModuleId },
  { title: "云端归档与实验复盘", detail: "结果、照片、逐线残差、不确定度预算与异常诊断同步后，形成可导出的证据链。", image: "/guide/06-uncertainty.jpg", alt: "实验人员复核分析结果", position: "center 52%", credit: "Linda Bartlett / NCI · Public domain", source: "https://commons.wikimedia.org/wiki/File:Scientists_examine_a_graph.jpg", target: "records" as ModuleId },
];

function GuideModule({ journey, navigate }: { journey: ExperimentJourney; navigate: (id: ModuleId) => void }) {
  const states = [
    { done: journey.prelab.capturedLines >= 2 && journey.prelab.dUm !== null, data: `${journey.prelab.capturedLines} 条谱线${journey.prelab.dUm ? ` · d=${journey.prelab.dUm.toFixed(3)} μm` : ""}`, reason: "至少记录两条谱线并生成拟合" },
    { done: journey.capture.imageCount > 0 && journey.capture.exposureOk && journey.capture.sharpnessOk, data: journey.capture.imageCount ? `${journey.capture.imageCount} 张 · 曝光${journey.capture.exposureOk ? "通过" : "未通过"} · 清晰度${journey.capture.sharpnessOk ? "通过" : "未通过"}` : "尚无真实照片", reason: "需上传真实照片并通过曝光、清晰度检查" },
    { done: journey.capture.zeroX !== null && journey.identification.matchedLines >= 2, data: `零级 ${journey.capture.zeroX?.toFixed(2) ?? "—"} px · 匹配 ${journey.identification.matchedLines} 条`, reason: "需确定零级并满足当前几何条件的最少参考线数" },
    { done: journey.inversion.reportable, data: journey.inversion.reportable ? `d=${journey.inversion.dUm?.toFixed(3)} ± ${journey.inversion.expandedUncertaintyUm?.toFixed(3)} μm` : "尚未形成可报告结果", reason: journey.inversion.blockReason || "需通过可辨识性与边界检查" },
    { done: journey.archive.synced, data: journey.archive.syncedAt ? `已同步 · ${new Date(journey.archive.syncedAt).toLocaleString("zh-CN")}` : "尚未归档", reason: "需将结果与证据成功同步到云端记录" },
  ];
  const firstIncompleteIndex = states.findIndex((state) => !state.done);
  const firstIncomplete = firstIncompleteIndex === -1 ? 4 : firstIncompleteIndex;
  const [step, setStep] = useState(firstIncomplete);
  const current = guideSteps[step], state = states[step];
  const completed = states.filter((item) => item.done).length;
  return <div className="module-page"><PageHeading eyebrow="实验 · 主流程" title="每一阶段都由真实数据自动判定。" description="这里是整站实验入口：状态、证据、阻塞原因与下一步操作均来自对应模块，不能手动打勾。" />
    <div className="guide-grid"><aside className="panel step-list">{guideSteps.map((item, index) => <button key={item.title} className={`${step === index ? "active" : ""} ${states[index].done ? "done" : ""}`} onClick={() => setStep(index)}><span>{states[index].done ? <Check size={16} /> : index + 1}</span><div><strong>{item.title}</strong><small>{states[index].done ? "自动完成" : index === firstIncomplete ? "当前阶段" : "待完成"}</small></div><ChevronRight size={16} /></button>)}</aside>
      <section className="panel guide-detail"><figure className="guide-visual"><Image key={current.image} src={current.image} alt={current.alt} fill priority={step === 0} sizes="(max-width: 1100px) 100vw, 50vw" style={{ objectPosition: current.position }} /><div className="guide-photo-shade" aria-hidden="true" /><span>STAGE {String(step + 1).padStart(2, "0")}</span><figcaption><span>真实实验照片</span><a href={current.source} target="_blank" rel="noreferrer">{current.credit}</a></figcaption></figure><div className="guide-copy"><p className="eyebrow">{state.done ? "阶段已自动完成" : "当前数据尚未满足条件"}</p><h2>{current.title}</h2><p>{current.detail}</p><div className="checkpoint"><ClipboardCheck size={19} /><div><strong>当前证据</strong><span>{state.data}</span></div></div>{!state.done && <p className="guide-block"><CircleAlert size={16} />阻塞原因：{state.reason}</p>}<div className="guide-actions"><button className="secondary-action" onClick={() => navigate("assistant")}><Bot size={16} />询问当前异常</button><button className="primary-action" onClick={() => navigate(current.target)}>{state.done ? "查看阶段数据" : "前往完成阶段"}<ArrowRight size={16} /></button></div></div></section>
      <aside className="panel guide-side"><div><Lightbulb size={20} /><strong>流程如何产生价值？</strong><p>预习、照片质量、自动认线、科学反演与云端报告共享同一状态；任何一步失败都会给出真实阻塞原因，不会产生貌似精确的最终数值。</p></div><div className="progress-block"><span>实验进度 <strong>{Math.round(completed / 5 * 100)}%</strong></span><Progress value={completed / 5 * 100} /><small>云端状态更新于 {journey.updatedAt ? new Date(journey.updatedAt).toLocaleString("zh-CN") : "尚未保存"}</small></div></aside></div>
  </div>;
}

function RecordsModule({ navigate, authenticated, authHref }: { navigate: (id: ModuleId) => void; authenticated: boolean; authHref: string }) {
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
  const exportCsv = () => { const rows = [["最后更新", "任务", "光源", "状态", "结果", "质量"], ...records.map((r) => [new Date(r.updatedAt).toLocaleString("zh-CN"), r.task, r.source, r.status === "draft" ? "进行中" : r.status === "needs_review" ? "需复核" : "已完成", r.resultValue, r.quality])]; downloadFile("spectra-experiments.csv", rows.map((row) => row.map((v) => `"${String(v).replaceAll('"','""')}"`).join(",")).join("\n"), "text/csv"); };
  const markerCount = Array.isArray(selected?.payload.referenceMarkers) ? selected.payload.referenceMarkers.length : 0;
  const imageEntries = selected ? Object.entries(selected.imageUrls) as [ExperimentImageSlot, string][] : [];
  if (!authenticated) return <div className="module-page"><FlowBanner stage="5 / 5 · 云端归档与实验复盘" navigate={navigate} /><PageHeading eyebrow="课后 · 实验记录与复盘" title="登录后查看你的实验记录。" description="匿名访问不会读取或保存个人数据。登录后可在不同设备间同步记录、图片与实验报告。" action={<a className="primary-action" href={authHref} target="_top"><LogIn size={16} />登录 ChatGPT</a>} /><div className="panel record-empty"><History size={34} /><strong>个人记录受到登录保护</strong><p>站点其余实验模块仍可匿名浏览和操作。</p></div></div>;
  return <div className="module-page"><FlowBanner stage="5 / 5 · 云端归档与实验复盘" navigate={navigate} /><PageHeading eyebrow="课后 · 实验记录与复盘" title="回看每次实验，复核过程与结果。" description="查看实验步骤、原始光谱、测量结果与异常诊断；支持导出 CSV 和实验报告。" action={<button className="secondary-action" onClick={exportCsv} disabled={!records.length}><Download size={16} />导出全部 CSV</button>} />
    <div className={`records-sync ${errorMessage ? "error" : ""}`} aria-live="polite">{errorMessage ? <><CircleAlert size={15} /><span>{errorMessage}</span><button onClick={() => void refresh()}>重新加载</button></> : <><CheckCircle2 size={15} /><span>{lastUpdated ? `云端记录已更新 · ${new Date(lastUpdated).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "正在连接云端记录"}</span></>}</div>
    <div className="records-grid"><section className="panel record-list"><div className="panel-title"><div><span className="step-index"><History size={14} /></span><h2>我的实验</h2></div><span>{records.length} 条</span></div>{loading ? <div className="record-empty">正在读取实验记录…</div> : records.length ? records.map((record) => <button key={record.id} className={selected?.id === record.id ? "active" : ""} onClick={() => setSelected(record)}><span className="record-source"><Waves size={18} /></span><div><strong>{record.resultLabel}<small>{record.resultValue}</small></strong><p><Clock3 size={12} />{new Date(record.updatedAt).toLocaleString("zh-CN")} · {record.source}</p></div><em className={record.status === "completed" ? "good" : ""}>{record.status === "draft" ? "进行中" : record.status === "needs_review" ? "需复核" : "已完成"}</em></button>) : <div className="record-empty"><History size={30} /><strong>还没有实验记录</strong><p>上传光谱图片后，实验过程会自动同步并出现在这里。</p></div>}</section>
      <section className="panel replay-panel">{selected ? <><div className="replay-head"><div><p className="eyebrow">实验回放</p><h2>{selected.resultLabel} · {selected.resultValue}</h2><small>最后同步于 {new Date(selected.updatedAt).toLocaleString("zh-CN")}</small></div><a className="secondary-action" href={`/api/records/${encodeURIComponent(selected.id)}/report`} target="_blank" rel="noreferrer"><FileText size={16} />查看 / 打印报告</a></div><div className="record-evidence"><span><small>已完成阶段</small><strong>{selected.steps.length} 项</strong></span><span><small>匹配汞线</small><strong>{markerCount} 条</strong></span><span><small>记录状态</small><strong>{selected.quality}</strong></span></div>{imageEntries.length > 0 && <div className="record-images">{imageEntries.map(([slot, url]) => <figure key={slot}><Image src={url} alt="汞灯零级与单侧一级原始照片" width={800} height={450} unoptimized /><figcaption>{slot === "primary" ? "主测照片" : slot === "repeat_2" ? "重复照片 2" : "重复照片 3"}</figcaption></figure>)}</div>}<div className="timeline">{selected.steps.length ? selected.steps.map((step, index) => <div className="timeline-item" key={step}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{step}</strong><p>{step === "d 反演及不确定度评估" ? `${selected.resultLabel} = ${selected.resultValue}` : "该阶段的参数和证据已保存到云端记录。"}</p></div>{index < selected.steps.length - 1 && <i />}</div>) : <div className="record-empty compact"><History size={28} /><strong>实验尚未开始</strong></div>}</div><div className="record-diagnosis"><strong>异常诊断与复核意见</strong><p>{selected.diagnosis || "未填写异常诊断或复核意见。"}</p></div></> : <div className="record-empty"><Microscope size={34} /><strong>选择一条记录开始回放</strong></div>}</section></div>
  </div>;
}

function downloadFile(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob(["\ufeff", content], { type: `${type};charset=utf-8` })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); }

declare global {
  interface Document { modelContext?: { registerTool: (tool: { name: string; title: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean; untrustedContentHint: boolean }; execute: (input: unknown) => unknown }, options?: { signal?: AbortSignal }) => void | Promise<void> } }
}

export default function SpectraApp({ authenticated, viewerName, authHref, authLabel }: { authenticated: boolean; viewerName: string | null; authHref: string; authLabel: string }) {
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
    setActive("guide");
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
  return <main className={`app-shell ${active === "home" ? "" : "module-ambient"}`}><AppHeader active={active} onChange={setActive} authenticated={authenticated} authHref={authHref} authLabel={authLabel} viewerName={viewerName} />{active === "home" && <HomeModule navigate={setActive} />}{active === "simulator" && <SimulatorModule journey={journey} navigate={setActive} updateJourney={updateJourney} />}{active === "assistant" && <AssistantModule journey={journey} navigate={setActive} authenticated={authenticated} authHref={authHref} />}{active === "analysis" && <AnalysisModule key={analyzeSignal} analyzeSignal={analyzeSignal} journey={journey} navigate={setActive} updateJourney={updateJourney} authenticated={authenticated} finishExperiment={resetExperiment} />}{active === "guide" && <GuideModule journey={journey} navigate={setActive} />}{active === "records" && <RecordsModule navigate={setActive} authenticated={authenticated} authHref={authHref} />}<footer><span><Aperture size={16} />SPECTRA · AI 分光计实验学习助手</span></footer><Toaster position="top-center" richColors /></main>;
}
