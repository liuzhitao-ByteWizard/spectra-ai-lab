"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import {
  Aperture, ArrowLeft, ArrowRight, BarChart3, BookOpen, Bot, Camera,
  CheckCircle2, ChevronRight, CircleAlert, ClipboardCheck, Clock3,
  Download, ExternalLink, FileText, FlaskConical, History, Home,
  ImagePlus, LoaderCircle, MessageCircle, Microscope, Play,
  RotateCcw, Save, ScanLine, Send, Sigma, SlidersHorizontal, Target, Telescope, Trash2,
  Upload, Users, Waves,
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
  calibrateFromPixelDiff,
  wavelengthFromPixelDiff,
} from "@/lib/spectrometer";
import {
  analyzeSpectrumOffline,
  MERCURY_LINES,
  lineDisplayName,
  PartialAnalysisError,
  type CalibrationResult,
  type DetectedPeak,
  type ManualPoint,
  type MatchedLine,
  type MercuryLineKey,
  fitCalibration,
  wavelengthFromX,
} from "@/lib/offline-spectrum-analysis";
import {
  type ExperimentImageSlot,
  type ExperimentTask, type RecordSnapshot, type SavedRecord,
} from "@/lib/experiment-record";
import { emptyJourney, mergeJourney, type ExperimentJourney } from "@/lib/experiment-journey";
import { appendAuraUsageEvent, auraUsageActionLabel, auraUsageModuleLabel, auraUsagePromptLabel, emptyAuraUsage, normalizeAuraUsage, type AuraUsageEventInput } from "@/lib/aura-usage";
import { buildRecordsCsv, deleteLocalRecord, exportLocalRecordsBackup, importLocalRecordsFile, listLocalRecords, saveLocalRecord } from "@/lib/local-records";
import { buildExperimentReportHtml } from "./api/records/report-html";

const VirtualSpectrometer3D = dynamic(() => import("./VirtualSpectrometer3D"), {
  ssr: false,
  loading: () => <div className="virtual-lab-loading"><Telescope size={28} /><strong>正在加载三维分光计</strong><span>仪器模型与实时光路准备中…</span></div>,
});

type ModuleId = "home" | "simulator" | "assistant" | "analysis" | "records";
type DemoStatus = "idle" | "ready" | "loading" | "complete" | "error";
type Peak = { x: number; xRatio: number; family: string; color: string; confidence: number; prominence: number; widthPx: number; wavelengthNm?: number };
type DetectorOptions = { prominence: number; minDistancePx: number };
type SpectrumSource = {
  preview: string | null; fileName: string; width: number; height: number;
  rawIntensity: number[]; luminanceIntensity: number[]; chromaIntensity: number[]; red: number[]; green: number[]; blue: number[];
  overexposed: boolean; sharpnessOk: boolean; tilt: number; bandWidth: number; sample?: boolean;
};
type ImageAnalysis = SpectrumSource & { smoothIntensity: number[]; peaks: Peak[] };
type ReferenceMarker = { wavelengthNm: number; xRatio: number };
type GeometryReference = ReferenceMarker & { xPx: number; thetaDeg: number; residualNm: number };
type GeometryCalibration = {
  dUm: number;
  dNm: number;
  linesPerMm: number;
  order: number;
  x0Px: number;
  Lpx: number;
  rmseNm: number;
  reversed: boolean;
  references: GeometryReference[];
};
type UnknownWavelengthResult = {
  xPx: number;
  xRatio: number;
  thetaDeg: number;
  lambdaNm: number;
  uncertaintyNm: number;
  order: number;
  family: string;
  status: "可报告" | "需复核";
};
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
    // Interference lines (short, thin, dim artifacts near the crosshair) are
    // filtered by requiring high absolute intensity, high prominence, and
    // strong chroma saturation — real Hg lines are bright and wide.
    const spectralShape = widthPx >= 3 && chromaProminence >= Math.max(.018, prominence * .3);
    const strongEnough = smooth[x] >= .14 && prominence >= Math.max(requiredProminence, .05);
    if (strongEnough && spectralShape) {
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

function FeedbackBox({ active }: { active: ModuleId }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("功能建议");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && status !== "submitting") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, status]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (trimmed.length < 5) {
      setStatus("error");
      setErrorMessage("请至少输入 5 个字符的建议内容。");
      return;
    }
    setStatus("submitting");
    setErrorMessage("");
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          message: trimmed,
          contact: contact.trim(),
          page: navItems.find((item) => item.id === active)?.label ?? active,
          website,
        }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || "留言提交失败，请稍后重试。");
      setStatus("success");
      setMessage("");
      setContact("");
      setWebsite("");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "留言提交失败，请稍后重试。");
    }
  };

  return <>
    <button className={`topbar-feedback ${open ? "active" : ""}`} onClick={() => { setOpen(true); setStatus("idle"); }} title="向网站提交建议或问题反馈">
      <MessageCircle size={15} />
      <span>留言箱</span>
    </button>
    {open && <div className="feedback-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && status !== "submitting") setOpen(false); }}>
      <section className="feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <header className="feedback-head">
          <div><p className="eyebrow">SPECTRA · 用户反馈</p><h2 id="feedback-title">留言箱</h2></div>
          <button type="button" className="feedback-close" onClick={() => setOpen(false)} disabled={status === "submitting"} aria-label="关闭留言箱">×</button>
        </header>
        {status === "success" ? <div className="feedback-success">
          <CheckCircle2 size={34} />
          <strong>感谢你的建议</strong>
          <p>留言已经提交，我们会根据反馈持续改进网站。</p>
          <button className="primary-action" onClick={() => setOpen(false)}>关闭</button>
        </div> : <form className="feedback-form" onSubmit={(event) => void submit(event)}>
          <label>建议类型<select value={category} onChange={(event) => setCategory(event.target.value)}><option>功能建议</option><option>问题反馈</option><option>内容建议</option><option>其他</option></select></label>
          <label>建议内容<textarea value={message} maxLength={1200} onChange={(event) => setMessage(event.target.value)} placeholder="请描述你希望增加、调整或修复的内容…" autoFocus /></label>
          <div className="feedback-count">{message.length} / 1200</div>
          <label>联系方式（可选）<input value={contact} maxLength={120} onChange={(event) => setContact(event.target.value)} placeholder="邮箱、微信或其他联系方式" /></label>
          <label className="feedback-honeypot" aria-hidden="true">网址<input value={website} onChange={(event) => setWebsite(event.target.value)} tabIndex={-1} autoComplete="off" /></label>
          {status === "error" && <p className="feedback-error"><CircleAlert size={15} />{errorMessage}</p>}
          <div className="feedback-actions">
            <button type="button" className="secondary-action" onClick={() => setOpen(false)} disabled={status === "submitting"}>取消</button>
            <button type="submit" className="primary-action" disabled={status === "submitting"}>{status === "submitting" ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}提交建议</button>
          </div>
        </form>}
      </section>
    </div>}
  </>;
}

function AppHeader({ active, onChange, localRecordCount }: { active: ModuleId; onChange: (id: ModuleId) => void; localRecordCount: number | null }) {
  const recordLabel = localRecordCount && localRecordCount > 0 ? `本地记录 ${localRecordCount} 条` : "本地自动保存";
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
        <button className={`topbar-records ${active === "records" ? "active" : ""}`} onClick={() => onChange("records")} title="实验记录自动保存在当前浏览器中">
          <History size={15} />
          <i />
          <span>{recordLabel}</span>
        </button>
        <FeedbackBox active={active} />
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
            style={{ left: `${[13, 28, 57, 75.4, 77.2][index]}%`, backgroundColor: line.color }}
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
          <h1>基于三维虚拟仿真与AI图像分析的分光计参数反演实验系统</h1>
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

const OPENMAIC_URL = process.env.NEXT_PUBLIC_OPENMAIC_URL?.trim() || "http://localhost:3001";
const HOSTED_OPENMAIC_URL = "https://open.maic.chat";
const isLoopbackClassroomUrl = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
};
const subscribeToBrowserLocation = () => () => {};
const getIsLocalBrowser = () => {
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
};
const getServerIsLocalBrowser = () => false;

function AssistantModule({ journey, navigate }: { journey: ExperimentJourney; navigate: (id: ModuleId) => void }) {
  const isLocalBrowser = useSyncExternalStore(subscribeToBrowserLocation, getIsLocalBrowser, getServerIsLocalBrowser);
  const [classroomOpen, setClassroomOpen] = useState(true);
  const [classroomReady, setClassroomReady] = useState(false);
  const [classroomKey, setClassroomKey] = useState(0);
  const canEmbedClassroom = Boolean(OPENMAIC_URL) && (!isLoopbackClassroomUrl(OPENMAIC_URL!) || isLocalBrowser);

  useEffect(() => {
    if (!classroomOpen) return;
    const timer = window.setTimeout(() => setClassroomReady(true), 1800);
    return () => window.clearTimeout(timer);
  }, [classroomKey, classroomOpen]);

  const reloadClassroom = () => {
    setClassroomReady(false);
    setClassroomKey((value) => value + 1);
  };

  if (!canEmbedClassroom || !classroomOpen) {
    return <section className="classroom-module" aria-labelledby="classroom-launch-title">
      <div className="classroom-module-copy">
        <p className="classroom-launch-eyebrow"><Users size={17} /> AI 互动课堂</p>
        <h1 id="classroom-launch-title">把实验问题，<br /><em>讲成一堂课。</em></h1>
        <p className="classroom-launch-intro">从光栅衍射、谱线识别到波长计算，让 AI 教师陪你推导、提问和复盘。</p>
        <div className="classroom-launch-actions">
          {canEmbedClassroom ? (
            <button className="classroom-primary-link" onClick={() => { setClassroomOpen(true); reloadClassroom(); }}>
              进入互动课堂 <ArrowRight size={18} />
            </button>
          ) : (
            <a className="classroom-primary-link" href={HOSTED_OPENMAIC_URL} target="_blank" rel="noreferrer">
              开始一堂互动课 <ExternalLink size={18} />
            </a>
          )}
          <span>{canEmbedClassroom ? "进入课堂后按提示输入访问码" : "将在新窗口打开"}</span>
        </div>
      </div>
      <aside className="classroom-course-preview" aria-label="互动课堂内容预览">
        <div className="classroom-preview-topline"><span>01 / 光栅衍射</span><Aperture size={20} /></div>
        <div className="classroom-spectrum" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        <div className="classroom-preview-body">
          <span className="classroom-preview-label">今天的问题</span>
          <p>为什么改变光栅角度，亮纹的位置会发生变化？</p>
          <div className="classroom-preview-row"><span>AI 教师引导</span><strong>开始探索 <ArrowRight size={15} /></strong></div>
        </div>
      </aside>
      <p className="classroom-launch-footnote">首次使用时，请按课堂页面提示输入访问码。</p>
    </section>;
  }

  return <section className="classroom-embed-shell" aria-label="SPECTRA 互动课堂">
    <div className="classroom-embed-toolbar">
      <button className="classroom-embed-action classroom-embed-back" onClick={() => setClassroomOpen(false)}>
        <ArrowLeft size={17} />
        <span>返回互动课堂</span>
      </button>
      <div className="classroom-embed-status" aria-live="polite">
        <span><i className={classroomReady ? "ready" : ""} />SPECTRA 互动课堂</span>
        <small>{classroomReady ? "课堂已连接" : "正在加载课堂"}</small>
      </div>
      <div className="classroom-embed-actions">
        <button className="classroom-embed-action" onClick={reloadClassroom}>
          <RotateCcw size={16} />
          <span>课堂首页</span>
        </button>
        <a className="classroom-embed-action" href={OPENMAIC_URL} target="_blank" rel="noreferrer">
          <ExternalLink size={16} />
          <span>新窗口打开</span>
        </a>
      </div>
    </div>
    <div className="classroom-embed-frame">
      {!classroomReady && <div className="classroom-loading" role="status">
        <LoaderCircle size={23} />
        <strong>正在加载互动课堂</strong>
        <span>首次进入可能需要输入访问码</span>
      </div>}
      <iframe
        key={classroomKey}
        className={`openmaic-iframe-full ${classroomReady ? "is-ready" : ""}`}
        src={OPENMAIC_URL}
        title="SPECTRA 互动课堂"
        allow="microphone; camera; autoplay; clipboard-write"
        onLoad={() => setClassroomReady(true)}
      />
    </div>
  </section>;
}

function lineColor(wavelengthNm: number) {
  return SPECTRAL_LIBRARY.mercury.find((line) => line.wavelengthNm === wavelengthNm)?.color ?? "#2185ee";
}

function SpectrumStage({ image, markers = [], unknownPeaks = [], onMark, caption, onUpload }: { image: ImageAnalysis | null; markers?: ReferenceMarker[]; unknownPeaks?: number[]; onMark?: (xRatio: number) => void; caption: string; onUpload?: () => void }) {
  if (!image) return <div className="spectrum-stage spectrum-empty" onClick={onUpload} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onUpload?.(); }}><Upload size={34} /><strong>点击上传光谱照片</strong><p>建议使用一级光谱，谱线清晰、不过曝，并保持画幅水平。</p></div>;
  const imageFit = image.width / image.height >= 16 / 9 ? "fit-width" : "fit-height";
  const overlay = <>
    <div className="crosshair crosshair-x" />
    {image.peaks.map((peak, index) => <i className="detected-spectrum-line" key={`${peak.x}-${index}`} style={{ left: `${peak.xRatio * 100}%`, backgroundColor: peak.color }}><small>{index + 1}</small></i>)}
     {markers.map((marker, index) => <span className={`reference-marker ${index > 0 && Math.abs(marker.xRatio - markers[index - 1].xRatio) < .05 ? "is-offset" : ""}`} key={marker.wavelengthNm} style={{ left: `${marker.xRatio * 100}%`, borderColor: lineColor(marker.wavelengthNm) }}><b>{marker.wavelengthNm.toFixed(2)} nm</b><small>{Math.round(marker.xRatio * image.width)} px</small></span>)}
     {unknownPeaks.map((xRatio, index) => <span className="reference-marker" key={`unknown-${xRatio}-${index}`} style={{ left: `${xRatio * 100}%`, borderColor: "#0ea5e9", background: "#e0f2fe" }}><b>未知峰 {index + 1}</b><small>{Math.round(xRatio * image.width)} px</small></span>)}
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

function UnknownPeakPicker({ image, selected, onCandidate, onRemove }: { image: ImageAnalysis | null; selected: number[]; onCandidate: (xRatio: number) => void; onRemove: (xRatio: number) => void }) {
  return <div className="marker-picker unknown-picker">
    <div className="marker-picker-head"><label>选择未知谱线峰值</label><button onClick={() => selected.forEach(onRemove)} disabled={!selected.length}>清空</button></div>
    <p>标定完成后，点击图像或候选峰选择一个或多个未知峰；重复点击同一峰会自动合并。</p>
    {image && <div className="candidate-strip" aria-label="可选未知峰">{image.peaks.map((peak, index) => <button key={`unknown-${peak.x}-${index}`} onClick={() => onCandidate(peak.xRatio)}><i style={{ background: peak.color }} />峰 {index + 1}<small>{peak.x.toFixed(1)}px</small></button>)}</div>}
    <div className="selected-markers">{selected.length ? selected.map((xRatio, index) => <button key={`${xRatio}-${index}`} onClick={() => onRemove(xRatio)} title="移除此未知峰"><i style={{ background: "#0ea5e9" }} />未知峰 {index + 1}<span>{Math.round(xRatio * (image?.width ?? 0))} px ×</span></button>) : <span>尚未选择未知峰；至少选择一个峰后才能形成可报告结果。</span>}</div>
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
    { icon: BarChart3, title: "物理计算", detail: selectedCount >= 2 ? resultText : selectedCount === 1 ? "已匹配一条谱线，再确认一条即可标定" : "确认至少两条已匹配谱线以执行标定" },
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
  return analyzeImageFile(new File([blob], "已保存实验图片", { type: blob.type || "image/png" }));
}

function localSyncLabel(phase: SyncPhase, lastSavedAt: number | null) {
  if (phase === "loading") return "正在读取本地记录";
  if (phase === "pending") return "有更改待保存";
  if (phase === "saving") return "正在保存到本机";
  if (phase === "retrying") return "保存失败，正在重试";
  if (phase === "error") return "保存失败";
  if (phase === "synced" && lastSavedAt) return `已保存 ${formatChinaClock(lastSavedAt)}`;
  return "本地自动保存已就绪";
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
  const [phase, setPhase] = useState<SyncPhase>("loading");
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
    if (notify) toast.info("已恢复保存在本机的实验记录");
  }, [changePhase]);

  const runSync = useCallback(async (taskToSync: ExperimentTask) => {
    const currentSnapshot = latestSnapshotRef.current[taskToSync];
    if (!currentSnapshot || syncingRef.current[taskToSync]) return;
    syncingRef.current[taskToSync] = true;
    if (currentTaskRef.current === taskToSync) changePhase("saving");
    const signature = JSON.stringify(currentSnapshot);
    try {
      const pending = pendingImagesRef.current[taskToSync];
      const savedRecord = await saveLocalRecord(currentSnapshot, pending, metaRef.current[taskToSync]);
      for (const [slot, file] of Object.entries(pending) as [ExperimentImageSlot, File][]) {
        if (pendingImagesRef.current[taskToSync][slot] === file) delete pendingImagesRef.current[taskToSync][slot];
      }
      metaRef.current[taskToSync] = { id: savedRecord.id, version: savedRecord.version };
      lastSavedSignatureRef.current[taskToSync] = signature;
      setSavedSignature(signature);
      setLastSyncedAt(Number(new Date(savedRecord.updatedAt)));
      setErrorMessage("");
      if (currentTaskRef.current === taskToSync) changePhase("synced");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "本地保存失败");
      if (currentTaskRef.current === taskToSync) changePhase("error");
    } finally {
      syncingRef.current[taskToSync] = false;
      const newest = latestSnapshotRef.current[taskToSync];
      if (newest && JSON.stringify(newest) !== lastSavedSignatureRef.current[taskToSync] && !suppressRef.current.has(taskToSync)) {
        if (currentTaskRef.current === taskToSync) changePhase("pending");
        setTimeout(() => void runSyncRef.current(taskToSync), 0);
      }
    }
  }, [changePhase, pendingImagesRef]);
  useEffect(() => { runSyncRef.current = runSync; }, [runSync]);

  useEffect(() => {
    if (loadedRef.current[task]) {
      changePhase(metaRef.current[task] ? "synced" : "idle");
      return;
    }
    let cancelled = false;
    changePhase("loading");
    const restorePendingRecord = async () => {
      try {
        const records = await listLocalRecords(100);
        if (cancelled) return;
        const pendingRecord = records.find((record) => record.task === task && record.status !== "completed");
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
        setErrorMessage(error instanceof Error ? error.message : "本地实验记录读取失败");
        changePhase("error");
      }
    };
    void restorePendingRecord();
    return () => { cancelled = true; };
  }, [task, changePhase, adoptRecord, loadAttempt]);

  useEffect(() => {
    if (!enabled || !loadedRef.current[task] || suppressRef.current.has(task)) return;
    const signature = JSON.stringify(snapshot);
    if (signature === lastSavedSignatureRef.current[task]) return;
    changePhase("pending");
    if (timersRef.current[task]) clearTimeout(timersRef.current[task]);
    const timer = setTimeout(() => void runSyncRef.current(task), 800);
    timersRef.current[task] = timer;
    return () => clearTimeout(timer);
  }, [task, enabled, snapshot, loadRevision, changePhase]);

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

function StatusPill({ status }: { status: DemoStatus }) {
  const label = ({ idle: "待上传", ready: "可运行", loading: "分析中", complete: "已完成", error: "需处理" } as Record<DemoStatus, string>)[status] || "待上传";
  return <em className={`status-pill ${status}`}>{label}</em>;
}

function DemoMessage({ tone, text }: { tone: "error" | "warn"; text: string }) {
  return <div className={`message ${tone}`}><CircleAlert size={17} /><span>{text}</span></div>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className={`metric ${tone || "ink"}`}><span>{label}</span><strong>{value}</strong></div>;
}

function ImageStage({
  preview,
  annotations,
  width,
  manualPoints,
  onAddManualPoint,
}: {
  preview: string;
  annotations: { type: string; x: number; label: string; color: string }[];
  width?: number;
  manualPoints?: ManualPoint[];
  onAddManualPoint?: (x: number) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [naturalWidth, setNaturalWidth] = useState(0);
  const [naturalHeight, setNaturalHeight] = useState(0);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setBox({ width: rect.width, height: rect.height });
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
    // 空状态不渲染图片容器，stageRef 此时为空；必须随 preview 重新挂载观察器。
  }, [preview]);

  useEffect(() => {
    const image = stageRef.current?.querySelector("img");
    if (!image) return;
    const onLoad = () => {
      setNaturalWidth(image.naturalWidth || 0);
      setNaturalHeight(image.naturalHeight || 0);
    };
    if (image.complete) onLoad();
    image.addEventListener("load", onLoad);
    return () => image.removeEventListener("load", onLoad);
  }, [preview]);

  const fit = useMemo(() => {
    const imageWidth = width || naturalWidth;
    if (!box.width || !box.height) return { left: 0, top: 0, width: 0, height: 0 };
    if (!imageWidth || !naturalHeight) return { left: 0, top: 0, width: box.width, height: box.height };
    const ratio = imageWidth / naturalHeight;
    const stageRatio = box.width / box.height;
    if (ratio > stageRatio) {
      const height = box.width / ratio;
      return { left: 0, top: (box.height - height) / 2, width: box.width, height };
    }
    const widthFit = box.height * ratio;
    return { left: (box.width - widthFit) / 2, top: 0, width: widthFit, height: box.height };
  }, [naturalHeight, box.height, box.width, width]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onAddManualPoint || !preview) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    if (localX < fit.left || localX > fit.left + fit.width || localY < fit.top || localY > fit.top + fit.height) return;
    const imageWidth = width || naturalWidth || fit.width;
    onAddManualPoint(((localX - fit.left) / fit.width) * imageWidth);
  };

  const imageWidth = width || naturalWidth;
  const markers = [
    ...annotations,
    ...(manualPoints ?? []).map((point) => ({ type: "manual", x: point.x, label: point.label, color: point.color })),
  ];

  if (!preview) {
    return (
      <div className="empty-stage">
        <ImagePlus size={42} />
        <strong>等待光谱照片</strong>
        <span>建议使用一级光谱，谱线清晰、不过曝，至少包含 3 条有效谱线。</span>
      </div>
    );
  }

  // Show markers whenever we have a usable x range; prefer letterboxed fit when known.
  const usableWidth = imageWidth > 0 ? imageWidth : naturalWidth;
  const showMarkers = usableWidth > 0 && markers.length > 0;

  return (
    <div ref={stageRef} className={`image-stage ${onAddManualPoint ? "is-clickable" : ""}`} onClick={handleClick}>
      <div className="image-wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={preview}
          alt="光谱照片预览"
          onLoad={(event) => {
            setNaturalWidth(event.currentTarget.naturalWidth || 0);
            setNaturalHeight(event.currentTarget.naturalHeight || 0);
          }}
        />
        {showMarkers && markers.map((marker, index) => {
          if (!Number.isFinite(marker.x)) return null;
          const hasFit = naturalHeight > 0 && fit.width > 0 && fit.height > 0;
          const left = hasFit
            ? fit.left + (marker.x / usableWidth) * fit.width
            : (Math.min(Math.max(marker.x, 0), usableWidth) / usableWidth) * box.width;
          const imageTop = hasFit ? fit.top : 0;
          const imageHeight = hasFit ? fit.height : box.height;
          const top = imageTop + imageHeight * 0.22;
          const height = imageHeight * 0.58;
          if (!Number.isFinite(left) || !Number.isFinite(height) || height < 20) return null;
          return (
            <span
              key={`${marker.type}-${marker.x}-${index}`}
              className={`marker ${marker.type}`}
              style={{
                left: `${left}px`,
                top: `${top}px`,
                height: `${height}px`,
                width: "0",
                "--marker-color": marker.color || "#1f7a5a",
              } as React.CSSProperties}
              title={marker.label}
              aria-label={marker.label}
            >
              <i className="marker-core" />
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ManualPanel({
  selectedLineKey,
  onSelectedLineKey,
  manualPoints,
  onRemoveManualPoint,
  onClearManualPoints,
  detectedPeaks,
  onAddManualPoint,
  disabled,
}: {
  selectedLineKey: MercuryLineKey;
  onSelectedLineKey: (key: MercuryLineKey) => void;
  manualPoints: ManualPoint[];
  onRemoveManualPoint: (key: string) => void;
  onClearManualPoints: () => void;
  detectedPeaks: DetectedPeak[];
  onAddManualPoint: (x: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="manual-panel">
      <div className="manual-head">
        <label>
          <span>选择要标定的谱线</span>
          <select value={selectedLineKey} onChange={(event) => onSelectedLineKey(event.target.value as MercuryLineKey)} disabled={disabled}>
            {MERCURY_LINES.map((line) => <option key={line.key} value={line.key}>{line.colorName}</option>)}
          </select>
        </label>
        <button type="button" onClick={onClearManualPoints} disabled={!manualPoints.length}>清空</button>
      </div>
      <p>先选择谱线，再点击照片中对应亮线中心。手动选择 3 条以上时，系统会优先使用这些标定点。</p>
      {!!detectedPeaks.length && (
        <div className="candidate-panel">
          <strong>自动检测到的候选峰</strong>
          <div className="candidate-list">
            {detectedPeaks.map((peak, index) => (
              <button key={`${peak.x}-${index}`} type="button" onClick={() => onAddManualPoint(peak.x)} disabled={disabled}>
                <i style={{ background: peak.color }} />
                {peak.colorName} · x={peak.x.toFixed(1)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="manual-list">
        {manualPoints.length
          ? manualPoints.map((point) => (
            <span key={point.key}>
              <i style={{ background: point.color }} />
              {point.label}: {point.x.toFixed(1)} px
              <button type="button" onClick={() => onRemoveManualPoint(point.key)}>删除</button>
            </span>
          ))
          : <em>尚未手动选择谱线。</em>}
      </div>
    </div>
  );
}

function ProfileChart({ result }: { result: CalibrationResult | null }) {
  const imageWidth = result?.summary?.imageWidth || 1100;
  const points = (result?.profile ?? []).map((point) => `${60 + point.x / imageWidth * 860},${300 - point.y * 220}`).join(" ");
  const annotations = result?.annotations ?? [];
  const svgX = (x: number) => x / 980 * 100;
  return (
    <div className="profile-chart-wrap">
      {/* preserveAspectRatio=none 让绘图区撑满卡片；描边统一走 non-scaling-stroke，宽度不随拉伸变形 */}
      <svg viewBox="0 0 980 330" preserveAspectRatio="none" className="profile-chart" role="img" aria-label="光强剖面">
        {[0, 1, 2, 3].map((index) => <line key={index} x1="60" x2="920" y1={82 + index * 56} y2={82 + index * 56} />)}
        <line x1="60" x2="920" y1="300" y2="300" />
        {points && <polyline points={points} />}
        {annotations.map((annotation, index) => {
          const x = 60 + annotation.x / imageWidth * 860;
          // 每层都用谱线自身颜色：远晕 → 近晕 → 亮线，形成同色外发光与描边
          return (
            <g key={`${annotation.x}-${index}`}>
              <line className="peak-line halo far" x1={x} x2={x} y1="54" y2="306" style={{ stroke: annotation.color }} />
              <line className="peak-line halo near" x1={x} x2={x} y1="54" y2="306" style={{ stroke: annotation.color }} />
              <line className="peak-line" x1={x} x2={x} y1="54" y2="306" style={{ stroke: annotation.color }} />
            </g>
          );
        })}
      </svg>
      {annotations.map((annotation, index, list) => {
        const x = 60 + annotation.x / imageWidth * 860;
        const prevX = index > 0 ? 60 + list[index - 1].x / imageWidth * 860 : null;
        // 黄色双线峰位极近，标签错开一行避免叠字
        const labelY = prevX !== null && x - prevX < 46 ? 30 : 48;
        const flip = x > 640;
        return (
          <span
            key={`label-${annotation.x}-${index}`}
            className={`profile-chart-label${flip ? " is-flip" : ""}`}
            style={{ left: `${svgX(x)}%`, top: `${labelY / 330 * 100}%`, color: annotation.color }}
          >
            {annotation.label}
          </span>
        );
      })}
      {!result && <span className="profile-chart-empty">完成分析后显示光强曲线与峰位</span>}
    </div>
  );
}

function ResidualList({ rows }: { rows: MatchedLine[] }) {
  if (!rows.length) return <p className="empty-note">完成汞灯标定后，这里显示每条标准谱线的预测值和残差。</p>;
  return (
    <div className="residual-list">
      {rows.map((row) => (
        <article key={row.id} className="residual-item">
          <div><i style={{ background: row.color }} /><strong>{lineDisplayName(row.matchKey)}</strong></div>
          <span>x={row.x.toFixed(1)} px</span>
          <span>标准 {row.standardNm.toFixed(2)} nm</span>
          <span>预测 {row.predictedNm.toFixed(2)} nm</span>
          <em>残差 {row.residualNm > 0 ? "+" : ""}{row.residualNm.toFixed(2)} nm</em>
          <b className={`badge ${row.statusKey}`}>{row.status}</b>
        </article>
      ))}
    </div>
  );
}

function ProcessingPanel({ result }: { result: CalibrationResult | null }) {
  const processing = result?.processing;
  const peaks = result?.detectedPeaks ?? [];
  return (
    <div className="table-card result-panel processing-panel">
      <h3>图像处理全过程</h3>
      {processing ? (
        <>
          <div className="process-steps">
            {processing.steps?.map((step, index) => (
              <div key={`${step.name}-${index}`} className="process-step">
                <b>{index + 1}</b>
                <div>
                  <strong>{step.name}</strong>
                  <span>{step.detail}</span>
                </div>
                {step.count !== null && step.count !== undefined && <em>{step.count}</em>}
              </div>
            ))}
          </div>
          <div className="process-summary">
            <span>候选峰 {processing.candidateCount ?? 0}</span>
            <span>保留峰 {processing.detectedCount ?? 0}</span>
            <span>可用峰 {processing.usableCount ?? 0}</span>
            <span>匹配谱线 {processing.matchedCount ?? 0}</span>
          </div>
          {processing.fallbackMessage ? (
            <p className={`fallback-note ${processing.fallbackRequired ? "warn" : "ok"}`}>{processing.fallbackMessage}</p>
          ) : null}
          {!!peaks.length && (
            <div className="detected-peaks">
              {peaks.map((peak, index) => (
                <span key={`${peak.x}-${index}`}>
                  <i style={{ background: peak.color }} />
                  {peak.colorName} x={peak.x.toFixed(1)} 强度={peak.height.toFixed(2)}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="empty-note">执行标定后显示：光强提取、峰值检测、近邻峰解混、匹配与残差计算。</p>
      )}
    </div>
  );
}

function ResultsGrid({ result, lineResiduals }: { result: CalibrationResult | null; lineResiduals: MatchedLine[] }) {
  const overview = !result?.calibration
    ? (
      <div className="result-overview is-empty">
        <div>
          <h3>结果总览</h3>
          <p>执行标定后，关键参数、波长结果、残差和图像处理过程会集中显示在这里。</p>
        </div>
      </div>
    )
    : (
      <div className="result-overview">
        <Metric label="RMSE" value={`${(result.summary.rmseNm ?? 0).toFixed(2)} nm`} tone="green" />
        <Metric label="最大残差" value={`${(result.summary.maxAbsResidualNm ?? 0).toFixed(2)} nm`} tone="gold" />
        <Metric label="x₀" value={`${result.calibration.x0Px.toFixed(1)} px`} tone="blue" />
        <Metric label="谱线数" value={`${result.calibration.sourceLineCount} 条`} tone="ink" />
      </div>
    );

  return (
    <section className="results-grid">
      {overview}
      <div className="chart-card result-panel results-chart">
        <h3>光强剖面与谱线标注</h3>
        <ProfileChart result={result} />
      </div>
      <div className="table-card result-panel wavelength-panel">
        <h3>最终波长结果</h3>
        {lineResiduals.length ? (
          <div className="wavelength-strip">
            {lineResiduals.map((line) => (
              <div key={line.id} className="wavelength-chip">
                <i style={{ background: line.color }} />
                <span>{lineDisplayName(line.matchKey)}</span>
                <strong>{line.predictedNm.toFixed(2)} nm</strong>
                <em>x={line.x.toFixed(1)} px，残差 {line.residualNm.toFixed(2)} nm</em>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty-note">完成自动标定或手动标定后，这里会列出每条谱线的波长结果。</p>
        )}
      </div>
      <div className="table-card result-panel residual-panel">
        <h3>标定残差复核</h3>
        <ResidualList rows={lineResiduals} />
      </div>
      <ProcessingPanel result={result} />
    </section>
  );
}

function ExperimentCard({
  title,
  subtitle,
  preview,
  result,
  status,
  error,
  inputRef,
  onFile,
  onRun,
  runLabel,
  mode,
  selectedLineKey,
  onSelectedLineKey,
  manualPoints,
  onAddManualPoint,
  onRemoveManualPoint,
  onClearManualPoints,
  detectedPeaks,
  disabled = false,
}: {
  title: string;
  subtitle: string;
  preview: string;
  result: CalibrationResult | null;
  status: DemoStatus;
  error: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFile: (file?: File) => void;
  onRun: () => void;
  runLabel: string;
  mode?: "calibration";
  selectedLineKey?: MercuryLineKey;
  onSelectedLineKey?: (key: MercuryLineKey) => void;
  manualPoints?: ManualPoint[];
  onAddManualPoint?: (x: number) => void;
  onRemoveManualPoint?: (key: string) => void;
  onClearManualPoints?: () => void;
  detectedPeaks?: DetectedPeak[];
  disabled?: boolean;
}) {
  const showCandidates = Boolean(result?.processing?.fallbackRequired && !result?.calibration);
  const annotations = [
    ...(result?.annotations ?? []),
    ...(showCandidates
      ? (detectedPeaks ?? []).filter((peak) => !(result?.annotations ?? []).some((line) => Math.abs(line.x - peak.x) < 2))
        .map((peak) => ({ type: "candidate", x: peak.x, label: `${peak.colorName} ${peak.x.toFixed(0)}px`, color: peak.color }))
      : []),
  ];

  return (
    <section
      className={`experiment-card ${disabled ? "is-disabled" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        const node = event.currentTarget;
        node.dataset.dragDepth = String((Number(node.dataset.dragDepth) || 0) + 1);
        node.classList.add("is-dragover");
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        const node = event.currentTarget;
        const depth = Math.max(0, (Number(node.dataset.dragDepth) || 1) - 1);
        node.dataset.dragDepth = String(depth);
        if (!depth) node.classList.remove("is-dragover");
      }}
      onDrop={(event) => {
        event.preventDefault();
        const node = event.currentTarget;
        node.dataset.dragDepth = "0";
        node.classList.remove("is-dragover");
        if (disabled) return;
        const dropped = event.dataTransfer?.files?.[0];
        if (dropped) onFile(dropped);
      }}
    >
      <div className="card-title">
        <ScanLine size={20} />
        <div>
          <h3>{title}</h3>
          <span>{subtitle}</span>
        </div>
        <StatusPill status={status} />
      </div>
      <ImageStage
        preview={preview}
        annotations={annotations}
        width={result?.summary?.imageWidth}
        manualPoints={manualPoints}
        onAddManualPoint={mode === "calibration" ? onAddManualPoint : undefined}
      />
      {mode === "calibration" && onSelectedLineKey && onRemoveManualPoint && onClearManualPoints && onAddManualPoint && (
        <ManualPanel
          selectedLineKey={selectedLineKey ?? "green"}
          onSelectedLineKey={onSelectedLineKey}
          manualPoints={manualPoints ?? []}
          onRemoveManualPoint={onRemoveManualPoint}
          onClearManualPoints={onClearManualPoints}
          detectedPeaks={detectedPeaks ?? []}
          onAddManualPoint={onAddManualPoint}
          disabled={disabled || !preview}
        />
      )}
      <div className="button-row">
        <label className={`secondary-button file-button ${disabled ? "disabled" : ""}`}>
          <ImagePlus size={17} /> 上传照片 或拖拽到此处
          <input ref={inputRef} type="file" accept="image/*" onChange={(event) => onFile(event.target.files?.[0])} disabled={disabled} />
        </label>
        <button type="button" className="primary-button" onClick={onRun} disabled={disabled || status === "loading"}>
          {status === "loading" ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}
          {runLabel}
        </button>
      </div>
      {error && <DemoMessage tone="error" text={error} />}
      {!!result?.warnings?.length && <DemoMessage tone="warn" text={result.warnings.join(" ")} />}
    </section>
  );
}

// 可选光栅刻线密度（线/mm）；对应光栅常数 d = 1000 / N（μm）
const GRATING_LINES = [300, 600, 1200];

function AnalysisModule({ analyzeSignal = 0, journey, updateJourney, finishExperiment }: { analyzeSignal?: number; journey: ExperimentJourney; updateJourney: (patch: Partial<ExperimentJourney>) => void; finishExperiment: () => void }) {
  const task: ExperimentTask = "A";
  const [linesPerMm, setLinesPerMm] = useState(300);
  const [prominence, setProminence] = useState(0.035);
  const [minDistance, setMinDistance] = useState(8);
  const [selectedLineKey, setSelectedLineKey] = useState<MercuryLineKey>("green");
  const [manualPoints, setManualPoints] = useState<ManualPoint[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [status, setStatus] = useState<DemoStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingImagesRef = useRef<PendingImages>({ A: {} });

  const lineResiduals = result?.lines ?? [];
  const hasResult = Boolean(result?.calibration);
  const blockReason = !file
    ? "请上传光谱图"
    : result?.processing?.fallbackRequired
      ? result.processing.fallbackMessage
      : hasResult
        ? ""
        : status === "ready"
          ? "已具备标定数据，点击「执行标定」生成结果"
          : "等待执行标定";

  useEffect(() => () => {
    if (preview.startsWith("blob:")) URL.revokeObjectURL(preview);
  }, [preview]);

  const handleFile = useCallback((next?: File) => {
    if (!next) return;
    if (!next.type.startsWith("image/")) {
      setErrorMessage("请上传 JPG 或 PNG 光谱照片。");
      return;
    }
    if (preview.startsWith("blob:")) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(URL.createObjectURL(next));
    setResult(null);
    setErrorMessage("");
    setStatus("ready");
    setManualPoints([]);
    pendingImagesRef.current.A.primary = next;
  }, [preview]);

  const addManualPoint = useCallback((x: number) => {
    const standard = MERCURY_LINES.find((line) => line.key === selectedLineKey);
    if (!standard) return;
    setManualPoints((points) => [
      ...points.filter((point) => point.key !== selectedLineKey),
      { key: selectedLineKey, label: standard.colorName, color: standard.color, wavelength: standard.wavelength, x },
    ].sort((a, b) => a.x - b.x));
    setResult(null);
    setStatus((value) => value === "complete" ? "ready" : value);
  }, [selectedLineKey]);

  const removeManualPoint = useCallback((key: string) => {
    setManualPoints((points) => points.filter((point) => point.key !== key));
    setResult(null);
  }, []);

  const resetDemo = useCallback(() => {
    if (preview.startsWith("blob:")) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview("");
    setResult(null);
    setStatus("idle");
    setErrorMessage("");
    setManualPoints([]);
    setLinesPerMm(300);
    setProminence(0.035);
    setMinDistance(8);
    pendingImagesRef.current = { A: {} };
    if (inputRef.current) inputRef.current.value = "";
  }, [preview]);

  const runCalibration = useCallback(async () => {
    if (!file) {
      setErrorMessage("请先上传汞灯一级光谱照片。");
      setStatus("error");
      return;
    }
    setStatus("loading");
    setErrorMessage("");
    setResult(null);
    try {
      const next = await analyzeSpectrumOffline(file, {
        dUm: 1000 / linesPerMm,
        prominence,
        minDistance,
        manualPoints,
      });
      setResult(next);
      setStatus("complete");
      setErrorMessage("");
      toast.success("标定完成：已生成波长与残差结果");
    } catch (error) {
      const partial = error instanceof PartialAnalysisError ? error.partialResult : null;
      if (partial) setResult(partial);
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "标定失败，请检查照片质量。");
    }
  }, [linesPerMm, file, minDistance, manualPoints, prominence]);

  useEffect(() => {
    updateJourney({
      capture: {
        imageCount: Number(Boolean(file)),
        exposureOk: Boolean(file && !result?.processing?.fallbackRequired),
        sharpnessOk: Boolean(file),
        zeroX: null,
        zeroReferenceCaptured: false,
        zeroReadingDeg: null,
        peakCount: result?.detectedPeaks.length ?? 0,
      },
      identification: { matchedLines: lineResiduals.length, yellowDoubletResolved: lineResiduals.some((line) => line.standardNm === 576.96) && lineResiduals.some((line) => line.standardNm === 579.07) },
      inversion: {
        reportable: hasResult,
        dUm: hasResult && result?.calibration ? result.calibration.dUm : null,
        expandedUncertaintyUm: null,
        correlation: null,
        profileLowUm: null,
        profileHighUm: null,
        boundaryHit: false,
        blockReason: hasResult ? "" : blockReason,
      },
    });
  }, [file, result, lineResiduals, hasResult, blockReason, updateJourney]);

  const recordSnapshot = useMemo<RecordSnapshot>(() => {
    const calibration = result?.calibration;
    const resultValue = calibration
      ? `x₀ ${calibration.x0Px.toFixed(1)} px · L ${calibration.effectiveLPx.toFixed(0)} px`
      : "进行中";
    const steps: string[] = [];
    if (journey.prelab.capturedLines >= 2 && journey.prelab.dUm !== null) steps.push("虚拟预习");
    if (file) steps.push("光谱图采集与质量检查");
    if (lineResiduals.length >= 3) steps.push("谱线自动匹配与确认");
    if (hasResult) steps.push("光栅参数设定", "物理约束标定（求解 x₀ 与 L）", "谱线预测与残差复核", "本地保存与实验复盘");
    return {
      task,
      source: "汞灯光谱",
      resultLabel: "几何标定",
      resultValue,
      quality: !hasResult ? (blockReason || "进行中") : result?.summary.fitQuality || "已完成",
      status: !hasResult ? "draft" : "completed",
      steps,
      diagnosis,
      payload: {
        measurementType: "known-grating-spectrum-calibration",
        state: { prominence, minDistance, linesPerMm, gratingDUm: 1000 / linesPerMm, order: 1, complete: hasResult },
        referenceMarkers: lineResiduals.map((line) => ({ wavelengthNm: line.standardNm, xRatio: line.x / Math.max(result?.summary.imageWidth || 1, 1) })),
        result: result ? { ...result } : null,
        processing: {
          peaks: result?.detectedPeaks.length ?? 0,
          candidateCount: result?.processing.candidateCount ?? 0,
          detectedCount: result?.processing.detectedCount ?? 0,
          usableCount: result?.processing.usableCount ?? 0,
          matchedCount: result?.processing.matchedCount ?? 0,
          overexposed: false,
          sharpnessOk: Boolean(file),
          fallbackRequired: result?.processing.fallbackRequired ?? false,
          fallbackMessage: result?.processing.fallbackMessage ?? "",
        },
        evidence: {
          stages: ["虚拟预习", "光谱图采集与质量检查", "谱线自动匹配与确认", "光栅参数设定", "物理约束标定（求解 x₀ 与 L）", "谱线预测与残差复核", "本地保存与实验复盘"],
          limitation: "光栅刻线密度作为已知参数，系统通过汞灯参考谱线标定图像几何参数 x₀ 与 L，并预测各条谱线波长及残差。",
        },
        assistant: journey.assistant,
      },
    };
  }, [diagnosis, file, hasResult, journey.assistant, journey.prelab, lineResiduals, linesPerMm, minDistance, prominence, result, blockReason]);

  const hydrateRecord = useCallback(async (record: SavedRecord) => {
    const state = record.payload.state && typeof record.payload.state === "object" ? record.payload.state as Record<string, unknown> : {};
    if (record.task !== "A") return;
    updateJourney({ assistant: normalizeAuraUsage(record.payload.assistant) });
    setDiagnosis(record.diagnosis);
    if (typeof state.prominence === "number") setProminence(state.prominence);
    if (typeof state.minDistance === "number") setMinDistance(state.minDistance);
    if (typeof state.linesPerMm === "number" && GRATING_LINES.includes(state.linesPerMm)) {
      setLinesPerMm(state.linesPerMm);
    } else if (typeof state.dUmText === "string") {
      // 旧记录只存了 d(μm)，反推最接近的刻线密度
      const dUm = Number(state.dUmText);
      if (Number.isFinite(dUm) && dUm > 0) {
        setLinesPerMm(GRATING_LINES.reduce((best, lines) =>
          (Math.abs(1000 / lines - dUm) < Math.abs(1000 / best - dUm) ? lines : best), GRATING_LINES[0]));
      }
    }
    const restoredResult = record.payload.result && typeof record.payload.result === "object"
      ? record.payload.result as CalibrationResult
      : null;
    if (restoredResult?.calibration) {
      setResult(restoredResult);
      setStatus("complete");
    } else {
      setResult(null);
      setStatus(file ? "ready" : "idle");
    }
  }, [file, updateJourney]);

  const sync = useExperimentSync({ task, enabled: Boolean(file), snapshot: recordSnapshot, pendingImagesRef, onRemoteRecord: hydrateRecord });
  const syncLabel = localSyncLabel(sync.phase, sync.lastSyncedAt);

  const statusForCard: DemoStatus = !file
    ? "idle"
    : status === "loading" ? "loading"
      : status === "error" ? "error"
        : status === "complete" ? "complete"
          : "ready";

  return (
    <div className="module-page analysis-page analysis-demo">
      <PageHeading
        eyebrow="课中 · 图像分析"
        title="从光谱照片到波长结果"
        description="上传一级光谱照片，完成 HSV 颜色分析、多源融合峰值检测与物理约束标定；d 作为已知或软约束，不作为自由反演结论。"
      />
      <section className="lab-section" id="demo">
        <div className="lab-layout">
          <div className="lab-left-column">
            <div className="control-card">
              <div className="card-title">
                <Sigma size={20} />
                <div>
                  <h3>标定参数</h3>
                  <span>调整突出度与峰间距，必要时手动标定谱线。</span>
                </div>
              </div>
              <label className="field">
                <span>光栅刻线密度（线/mm）</span>
                <select value={linesPerMm} onChange={(event) => setLinesPerMm(Number(event.target.value))}>
                  {GRATING_LINES.map((lines) => (
                    <option key={lines} value={lines}>{lines} 线/mm · d = {(1000 / lines).toFixed(3)} μm</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>峰值突出度 {prominence.toFixed(3)}</span>
                <input type="range" min="0.01" max="0.12" step="0.005" value={prominence} onChange={(event) => setProminence(Number(event.target.value))} />
              </label>
              <label className="field">
                <span>最小峰间距 (px)</span>
                <input type="number" min="4" max="80" value={minDistance} onChange={(event) => setMinDistance(Number(event.target.value))} />
              </label>
              <button className="ghost-button" type="button" onClick={resetDemo}><RotateCcw size={17} /> 重置演示</button>
            </div>
          </div>

          <ExperimentCard
            title="汞灯标定"
            subtitle="上传一级光谱照片，拟合有效参数 x₀ / L。"
            preview={preview}
            result={result}
            status={statusForCard}
            error={errorMessage}
            inputRef={inputRef}
            onFile={handleFile}
            onRun={() => void runCalibration()}
            runLabel="执行标定"
            mode="calibration"
            selectedLineKey={selectedLineKey}
            onSelectedLineKey={setSelectedLineKey}
            manualPoints={manualPoints}
            onAddManualPoint={addManualPoint}
            onRemoveManualPoint={removeManualPoint}
            onClearManualPoints={() => setManualPoints([])}
            detectedPeaks={result?.detectedPeaks ?? []}
          />

          <ResultsGrid result={result} lineResiduals={lineResiduals} />
        </div>
      </section>

      <section className="panel overview-panel">
        <div>
          <h2>结果总览</h2>
          <p>
            {hasResult ? "关键参数、最终结果与标定信息会自动保存到本机。" : "上传光谱图后即开始保存实验过程，完成标定后自动更新结果。"}
          </p>
          <span className={`sync-state ${sync.phase}`} aria-live="polite">
            {sync.phase === "error" ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}
            {syncLabel}
          </span>
          {sync.phase === "error" && sync.errorMessage && <small className="sync-error">{sync.errorMessage}</small>}
        </div>
        <div className="overview-metrics">
          <span><small>匹配参考线</small><strong>{lineResiduals.length} 条</strong></span>
          <span><small>自标定状态</small><strong>{hasResult && result?.calibration ? `已完成 · L = ${result.calibration.effectiveLPx.toFixed(0)} px` : "待执行标定"}</strong></span>
          <span><small>光栅常数 d</small><strong>{hasResult && result?.calibration ? `${result.calibration.dUm.toFixed(3)} μm` : "未形成结果"}</strong></span>
        </div>
        {hasResult && sync.currentSnapshotSynced
          ? <button className="primary-action" onClick={finishExperiment}><CheckCircle2 size={16} />完成本次实验</button>
          : (
            <button
              className="secondary-action"
              onClick={() => (sync.phase === "error" && !file ? sync.retryLoad() : void sync.syncNow())}
              disabled={sync.phase === "saving" || sync.phase === "retrying" || (!file && sync.phase !== "error")}
            >
              <Save size={16} />
              {sync.phase === "error" && !file ? "重新读取" : sync.phase === "error" ? "立即重试" : "立即保存"}
            </button>
          )}
      </section>

      <section className="panel review-note-panel">
        <div className="analysis-card-heading">
          <span><ClipboardCheck size={18} /></span>
          <div>
            <h2>异常诊断与复核意见</h2>
            <p>记录异常现象、可能原因和复核结论；输入内容会随实验记录自动保存。</p>
          </div>
        </div>
        <textarea
          value={diagnosis}
          maxLength={2000}
          onChange={(event) => setDiagnosis(event.target.value)}
          placeholder="例如：黄色双线未完全分离，已重新调整狭缝并复测。"
        />
      </section>
    </div>
  );
}

function AnalysisModuleV2({ analyzeSignal = 0, journey, updateJourney, finishExperiment }: { analyzeSignal?: number; journey: ExperimentJourney; updateJourney: (patch: Partial<ExperimentJourney>) => void; finishExperiment: () => void }) {
  const task: ExperimentTask = "A";
  const [detector, setDetector] = useState<DetectorOptions>({ prominence: .018, minDistancePx: 3 });
  const [aSource, setASource] = useState<SpectrumSource | null>(() => analyzeSignal > 0 ? buildSampleSource() : null);
  const [aMarkers, setAMarkers] = useState<ReferenceMarker[]>([]);
  const [selectedWavelength, setSelectedWavelength] = useState(546.07);
  const [gratingDInput, setGratingDInput] = useState("3.333");
  const [orderInput, setOrderInput] = useState("1");
  const [selectedUnknownPeaks, setSelectedUnknownPeaks] = useState<number[]>([]);
  const [calibResult, setCalibResult] = useState<GeometryCalibration | null>(null);
  const [busy, setBusy] = useState(false);
  const [diagnosis, setDiagnosis] = useState("");
  const pendingImagesRef = useRef<PendingImages>({ A: {} });
  const spectrumFileRef = useRef<HTMLInputElement>(null);
  const aImage = useMemo(() => aSource ? detectSpectrumPeaks(aSource, detector) : null, [aSource, detector]);
  const knownDUm = Number(gratingDInput);
  const order = Math.max(1, Number(orderInput) || 1);
  const linesPerMm = Number.isFinite(knownDUm) && knownDUm > 0 ? 1000 / knownDUm : null;
  const usableReadings = useMemo(() => !aImage ? [] : aMarkers.flatMap((marker) => { const peak = aImage.peaks.reduce<Peak | null>((best, p) => !best || Math.abs(p.xRatio - marker.xRatio) < Math.abs(best.xRatio - marker.xRatio) ? p : best, null); return peak ? [{ wavelengthNm: marker.wavelengthNm, xPx: peak.x, xRatio: peak.xRatio }] : []; }), [aImage, aMarkers]);
  const unknownResults = useMemo<UnknownWavelengthResult[]>(() => {
    if (!aImage || !calibResult) return [];
    return selectedUnknownPeaks.flatMap((ratio) => {
      const clickedX = ratio * aImage.width;
      const peak = aImage.peaks.reduce<Peak | null>((best, item) => !best || Math.abs(item.x - clickedX) < Math.abs(best.x - clickedX) ? item : best, null);
      const xPx = peak && Math.abs(peak.x - clickedX) <= detector.minDistancePx ? peak.x : clickedX;
      const z = xPx - calibResult.x0Px;
      const lambdaNm = wavelengthFromX(xPx, calibResult.dUm / calibResult.order, calibResult.x0Px, calibResult.Lpx);
      if (!Number.isFinite(lambdaNm) || lambdaNm <= 0 || lambdaNm >= calibResult.dNm / calibResult.order) return [];
      const derivative = calibResult.dNm / calibResult.order * calibResult.Lpx ** 2 / (z * z + calibResult.Lpx ** 2) ** 1.5;
      return [{ xPx, xRatio: xPx / aImage.width, thetaDeg: Math.asin(Math.min(1, lambdaNm * calibResult.order / calibResult.dNm)) * 180 / Math.PI, lambdaNm, uncertaintyNm: Math.max(.5, Math.abs(derivative)), order: calibResult.order, family: peak?.family ?? "unknown", status: "可报告" as const }];
    });
  }, [aImage, calibResult, detector.minDistancePx, selectedUnknownPeaks]);
  useEffect(() => () => { if (aSource?.preview) URL.revokeObjectURL(aSource.preview); }, [aSource?.preview]);
  const loadSample = () => { sync.resetSync(); const sample = buildSampleSource(); setASource(sample); setAMarkers(SPECTRAL_LIBRARY.mercury.map((line) => ({ wavelengthNm: line.wavelengthNm, xRatio: (100 + 4000 * Math.tan(Math.asin(line.wavelengthNm / 3333))) / sample.width }))); setCalibResult(null); setSelectedUnknownPeaks([]); setGratingDInput("3.333"); setOrderInput("1"); };
  const uploadSpectrum = async (files?: FileList | File[]) => { const file = files ? Array.from(files)[0] : null; if (!file) return; setBusy(true); try { const source = await analyzeImageFile(file); const analyzed = detectSpectrumPeaks(source, detector); pendingImagesRef.current.A.primary = file; setASource(source); setAMarkers(autoMatchMercuryPeaks(analyzed)); setCalibResult(null); setSelectedUnknownPeaks([]); toast.success("图像读取完成，请确认汞灯参考线"); } catch (error) { toast.error(error instanceof Error ? error.message : "图像分析失败"); } finally { setBusy(false); } };
  const addMarker = (ratio: number) => { if (!aImage) return; const x = ratio * aImage.width; const nearest = aImage.peaks.reduce<Peak | null>((best, peak) => !best || Math.abs(peak.x - x) < Math.abs(best.x - x) ? peak : best, null); const xRatio = nearest && Math.abs(nearest.x - x) <= detector.minDistancePx ? nearest.xRatio : ratio; setAMarkers((items) => [...items.filter((item) => item.wavelengthNm !== selectedWavelength), { wavelengthNm: selectedWavelength, xRatio }].sort((a, b) => a.xRatio - b.xRatio)); setCalibResult(null); setSelectedUnknownPeaks([]); };
  const addUnknownPeak = (ratio: number) => { if (!aImage || !calibResult) return; const x = ratio * aImage.width; const nearest = aImage.peaks.reduce<Peak | null>((best, peak) => !best || Math.abs(peak.x - x) < Math.abs(best.x - x) ? peak : best, null); const xRatio = nearest && Math.abs(nearest.x - x) <= detector.minDistancePx ? nearest.xRatio : ratio; setSelectedUnknownPeaks((items) => items.some((item) => Math.abs(item - xRatio) * aImage.width < detector.minDistancePx) ? items : [...items, xRatio].sort((a, b) => a - b)); };
  const runCalibration = useCallback(() => { if (!aImage) return toast.warning("请先上传光谱图"); if (!Number.isFinite(knownDUm) || knownDUm <= 0) return toast.error("请输入大于 0 的光栅常数 d"); if (usableReadings.length < 2) return toast.error("需要至少两条汞灯参考线用于几何标定"); if (Math.max(...usableReadings.map((line) => line.wavelengthNm)) >= knownDUm * 1000 / order) return toast.error("光栅常数或衍射级次不足以覆盖参考谱线"); try { const matched = usableReadings.map((line) => ({ peak: { x: line.xPx, height: 1, family: "", color: "" }, standard: { key: "", label: "", colorName: "", wavelength: line.wavelengthNm, color: "" } })); const calib = fitCalibration(matched, knownDUm / order, aImage.width); const references = usableReadings.map((line) => ({ wavelengthNm: line.wavelengthNm, xRatio: line.xRatio, xPx: line.xPx, thetaDeg: Math.asin(line.wavelengthNm * order / (knownDUm * 1000)) * 180 / Math.PI, residualNm: wavelengthFromX(line.xPx, knownDUm / order, calib.x0Px, calib.effectiveLPx) - line.wavelengthNm })); setCalibResult({ dUm: knownDUm, dNm: knownDUm * 1000, linesPerMm: 1000 / knownDUm, order, x0Px: calib.x0Px, Lpx: calib.effectiveLPx, rmseNm: calib.rmseNm, reversed: calib.reversed, references }); setSelectedUnknownPeaks([]); toast.success(`几何标定完成：x₀ ${calib.x0Px.toFixed(1)} px，L ${calib.effectiveLPx.toFixed(0)} px`); } catch (error) { toast.error(error instanceof Error ? error.message : "几何标定失败"); } }, [aImage, knownDUm, order, usableReadings]);
  const hasResult = Boolean(calibResult && unknownResults.length && aImage && !aImage.overexposed && aImage.sharpnessOk);
  const blockReason = !aImage ? "请上传光谱图" : !Number.isFinite(knownDUm) || knownDUm <= 0 ? "请输入有效的光栅常数 d" : usableReadings.length < 2 ? "需要至少两条汞灯参考线才能标定" : !calibResult ? "点击执行几何标定" : !unknownResults.length ? "请点击一个或多个未知峰" : "";
  const status = !aImage ? "待上传" : hasResult ? "已完成" : "可继续";
  useEffect(() => { updateJourney({ capture: { imageCount: Number(Boolean(aImage)), exposureOk: Boolean(aImage && !aImage.overexposed), sharpnessOk: Boolean(aImage?.sharpnessOk), zeroX: calibResult?.x0Px ?? null, zeroReferenceCaptured: Boolean(calibResult), zeroReadingDeg: null, peakCount: aImage?.peaks.length ?? 0 }, identification: { matchedLines: aMarkers.length, yellowDoubletResolved: false }, inversion: { reportable: hasResult, dUm: Number.isFinite(knownDUm) && knownDUm > 0 ? knownDUm : null, expandedUncertaintyUm: null, correlation: null, profileLowUm: null, profileHighUm: null, boundaryHit: false, blockReason: hasResult ? "" : blockReason } }); }, [aImage, aMarkers.length, calibResult, hasResult, knownDUm, blockReason, updateJourney]);
  const recordSnapshot = useMemo<RecordSnapshot>(() => { const resultValue = hasResult ? unknownResults.length === 1 ? `${unknownResults[0].lambdaNm.toFixed(2)} nm` : `${unknownResults.length} 条未知谱线` : "进行中"; const steps = [aImage && !aImage.overexposed && aImage.sharpnessOk ? "光谱图采集与质量检查" : "", aMarkers.length >= 2 ? "汞灯参考线匹配与确认" : "", calibResult ? "几何标定（求解零级位置与相机距离）" : "", unknownResults.length ? "未知峰选择与波长计算" : "", hasResult ? "不确定度评估" : ""].filter(Boolean); return { task: "A", source: "未知光源", resultLabel: "未知波长 λ", resultValue, quality: hasResult ? "可报告" : blockReason, status: hasResult ? "completed" : "draft", steps, diagnosis, payload: { measurementType: "known-grating-unknown-wavelength", state: { detector, complete: Boolean(calibResult), sample: Boolean(aSource?.sample), gratingDUm: Number.isFinite(knownDUm) ? knownDUm : null, order, selectedUnknownPeaks }, referenceMarkers: aMarkers, result: calibResult ? { calibration: calibResult, unknownPeaks: unknownResults, reportable: hasResult, blockReason } : null, processing: { peaks: aImage?.peaks.length ?? 0, overexposed: Boolean(aImage?.overexposed), sharpnessOk: Boolean(aImage?.sharpnessOk) }, evidence: { stages: ["光谱图采集与质量检查", "汞灯参考线匹配与确认", "几何标定", "未知峰选择与波长计算", "不确定度评估", "本地保存与实验复盘"], limitation: "汞灯参考线仅用于标定图像几何；未知波长由已知光栅常数 d、像素位置和衍射级次计算。" }, assistant: journey.assistant } }; }, [aImage, aMarkers, aSource?.sample, blockReason, calibResult, detector, diagnosis, hasResult, journey.assistant, knownDUm, order, selectedUnknownPeaks, unknownResults]);
  const hydrateRecord = useCallback(async (record: SavedRecord) => { const state = record.payload.state && typeof record.payload.state === "object" ? record.payload.state as Record<string, unknown> : {}; const markers = Array.isArray(record.payload.referenceMarkers) ? record.payload.referenceMarkers.filter((item): item is ReferenceMarker => Boolean(item) && typeof item === "object" && typeof (item as ReferenceMarker).wavelengthNm === "number" && typeof (item as ReferenceMarker).xRatio === "number") : []; updateJourney({ assistant: normalizeAuraUsage(record.payload.assistant) }); setAMarkers(markers); setDiagnosis(record.diagnosis); if (typeof state.gratingDUm === "number") setGratingDInput(String(state.gratingDUm)); if (typeof state.order === "number") setOrderInput(String(state.order)); if (Array.isArray(state.selectedUnknownPeaks)) setSelectedUnknownPeaks(state.selectedUnknownPeaks.filter((item): item is number => typeof item === "number")); const result = record.payload.result && typeof record.payload.result === "object" ? record.payload.result as Record<string, unknown> : {}; const calibration = result.calibration && typeof result.calibration === "object" ? result.calibration as GeometryCalibration : null; if (calibration?.x0Px !== undefined) setCalibResult(calibration); if (state.sample) setASource(buildSampleSource()); else setASource(record.imageUrls.primary ? await sourceFromSyncedImage(record.imageUrls.primary).catch(() => null) : null); }, [updateJourney]);
  const sync = useExperimentSync({ task, enabled: Boolean(aImage), snapshot: recordSnapshot, pendingImagesRef, onRemoteRecord: hydrateRecord });
  const syncLabel = localSyncLabel(sync.phase, sync.lastSyncedAt);
  const resultSyncSignature = hasResult ? `${recordSnapshot.resultValue}|${unknownResults.map((item) => `${item.xPx}:${item.lambdaNm}`).join(",")}` : "";
  useEffect(() => {
    if (!resultSyncSignature) return;
    void sync.syncNow();
  }, [resultSyncSignature, sync.syncNow]);
  const resetTask = () => { sync.resetSync(); setASource(null); setAMarkers([]); setCalibResult(null); setSelectedUnknownPeaks([]); setDiagnosis(""); setGratingDInput("3.333"); setOrderInput("1"); };
  const summary: [string, string][] = [["匹配参考线", `${aMarkers.length} 条`], ["光栅常数 d", linesPerMm ? `${knownDUm.toFixed(3)} μm` : "未输入"], ["几何标定", calibResult ? `完成 · L=${calibResult.Lpx.toFixed(0)} px` : "待执行"], ["未知波长", `${unknownResults.length} 条`]];
  return <div className="module-page analysis-page"><PageHeading eyebrow="实验 · 图像分析工作台" title="用已知光栅常数测量未知波长。" description="输入已知光栅常数 d，使用汞灯参考线标定零级位置和图像几何参数，再点击一个或多个未知峰得到波长结果。" /><div className="analysis-workbench"><aside className="panel parameter-panel"><div className="analysis-card-heading"><span><SlidersHorizontal size={18} /></span><div><h2>测量参数</h2><p>图像像素位置直接参与几何标定和波长计算。</p></div></div><div className="parameter-form"><label>已知光栅常数 d（μm）<input type="number" min=".001" step=".001" value={gratingDInput} onChange={(e) => { setGratingDInput(e.target.value); setCalibResult(null); setSelectedUnknownPeaks([]); }} /><small>{linesPerMm ? `等效刻线密度：${linesPerMm.toFixed(1)} 线/mm` : "请输入有效数值"}</small></label><label>衍射级次 m<input type="number" min="1" max="10" value={orderInput} onChange={(e) => { setOrderInput(e.target.value); setCalibResult(null); setSelectedUnknownPeaks([]); }} /></label><label>峰值突出度 <output>{detector.prominence.toFixed(3)}</output><input type="range" min=".005" max=".2" step=".005" value={detector.prominence} onChange={(e) => setDetector((v) => ({ ...v, prominence: Number(e.target.value) }))} /></label><label>最小峰间距（px）<input type="number" min="2" max="64" value={detector.minDistancePx} onChange={(e) => setDetector((v) => ({ ...v, minDistancePx: Math.min(64, Math.max(2, Number(e.target.value))) }))} /></label><div className="parameter-buttons"><button className="reset-button parameter-reset" onClick={resetTask}><RotateCcw size={15} />恢复默认</button><button className="reset-button parameter-reset sample-button" onClick={loadSample}><Play size={15} />加载示例</button></div></div></aside><section className="panel calibration-panel"><div className="analysis-card-heading wide"><span><Waves size={18} /></span><div><h2>未知波长测量</h2><p>参考汞灯谱线只用于几何标定；未知峰由已知 d 计算波长。</p></div><em className={`analysis-status ${status === "已完成" ? "done" : ""}`}>{status}</em></div><SpectrumStage image={aImage} markers={aMarkers} unknownPeaks={selectedUnknownPeaks} onMark={calibResult ? addUnknownPeak : addMarker} caption={aSource?.sample ? "示例图像 · 汞灯参考与未知峰测量" : "光谱图 · 已完成强度提取"} onUpload={() => spectrumFileRef.current?.click()} /><input ref={spectrumFileRef} type="file" accept="image/*" hidden onChange={(e) => uploadSpectrum(e.target.files ?? undefined)} />{!calibResult ? <MarkerPicker selected={selectedWavelength} setSelected={setSelectedWavelength} markers={aMarkers} onClear={() => { setAMarkers([]); setCalibResult(null); }} onRemove={(wavelength) => setAMarkers((items) => items.filter((item) => item.wavelengthNm !== wavelength))} image={aImage} onCandidate={addMarker} /> : <UnknownPeakPicker image={aImage} selected={selectedUnknownPeaks} onCandidate={addUnknownPeak} onRemove={(ratio) => setSelectedUnknownPeaks((items) => items.filter((item) => item !== ratio))} />}<div className="analysis-actions"><label className="upload-button"><Upload size={17} />上传光谱图<input type="file" accept="image/*" hidden onChange={(e) => uploadSpectrum(e.target.files ?? undefined)} /></label><label className="camera-button"><Camera size={17} />手机拍摄<input type="file" accept="image/*" capture="environment" hidden onChange={(e) => uploadSpectrum(e.target.files ?? undefined)} /></label><button className="analyze-button" disabled={busy} onClick={runCalibration}><Play size={17} />{busy ? "处理中…" : "执行几何标定"}</button></div>{aImage && <div className="quality-row"><span><i />候选峰 {aImage.peaks.length} 条</span><span><i className={aImage.overexposed ? "warn" : ""} />{aImage.overexposed ? "高光偏多" : "曝光正常"}</span><span><i className={!aImage.sharpnessOk ? "warn" : ""} />{aImage.sharpnessOk ? "清晰度通过" : "清晰度不足"}</span><span><i className={calibResult ? "" : "warn"} />{calibResult ? "几何已标定" : "待标定"}</span></div>}{blockReason && aImage && <p className="inline-warning"><CircleAlert size={15} />{blockReason}</p>}{calibResult && <div className="wavelength-results"><div><strong>未知谱线测量结果</strong><p>d = {calibResult.dUm.toFixed(3)} μm · m = {calibResult.order} · 已选择 {unknownResults.length} 个未知峰</p></div><div className="wavelength-table"><div><b>峰</b><b>像素位置</b><b>衍射角 θ</b><b>波长 λ</b><b>不确定度</b><b>状态</b></div>{unknownResults.length ? unknownResults.map((line, i) => <div key={`${line.xPx}-${i}`}><span>未知峰 {i + 1}</span><span>{line.xPx.toFixed(1)} px</span><span>{line.thetaDeg.toFixed(3)}°</span><strong>{line.lambdaNm.toFixed(2)} nm</strong><span>± {line.uncertaintyNm.toFixed(2)} nm</span><strong>{line.status}</strong></div>) : <div><span>请在图像中点击未知峰</span></div>}</div></div>}</section></div><section className="panel overview-panel"><div><h2>结果总览</h2><p>{hasResult ? "光栅常数、几何标定和未知波长结果会自动保存。" : "完成几何标定并选择未知峰后形成结果。"}</p><span className={`sync-state ${sync.phase}`} aria-live="polite">{sync.phase === "error" ? <CircleAlert size={14} /> : <CheckCircle2 size={14} />}{syncLabel}</span>{sync.errorMessage && <small className="sync-error">{sync.errorMessage}</small>}</div><div className="overview-metrics">{summary.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div>{hasResult && sync.currentSnapshotSynced ? <button className="primary-action" onClick={finishExperiment}><CheckCircle2 size={16} />完成本次实验</button> : <button className="secondary-action" onClick={() => void sync.syncNow()} disabled={sync.phase === "saving" || sync.phase === "retrying"}><Save size={16} />立即保存</button>}</section><section className="panel review-note-panel"><div className="analysis-card-heading"><span><ClipboardCheck size={18} /></span><div><h2>异常诊断与复核意见</h2><p>输入内容会随实验记录自动保存。</p></div></div><textarea value={diagnosis} maxLength={2000} onChange={(e) => setDiagnosis(e.target.value)} placeholder="例如：黄色双线未完全分离，已重新调整狭缝并复测。" /></section><div className="analysis-results-grid"><section className="panel intensity-panel"><div className="analysis-card-heading wide"><span><Waves size={18} /></span><div><h2>强度剖面与谱线标注</h2><p>汞灯参考线和已选未知峰来自当前图像数据。</p></div></div><IntensityChart image={aImage} markers={aMarkers} title="光谱横向强度剖面" /></section><div className="analysis-result-stack"><section className="panel final-result-card"><div className="analysis-card-heading"><span><BarChart3 size={18} /></span><div><h2>未知波长结果</h2><p>λ = d sinθ / m</p></div></div>{hasResult ? <div className="final-measure"><small>未知波长 λ</small><strong>{unknownResults[0].lambdaNm.toFixed(2)} <em>nm</em></strong><p>d = {calibResult?.dUm.toFixed(3)} μm · m = {calibResult?.order}</p><p>x₀ = {calibResult?.x0Px.toFixed(1)} px · L = {calibResult?.Lpx.toFixed(0)} px</p></div> : <div className="result-placeholder"><FlaskConical size={28} /><span>{!aImage ? "等待上传光谱图" : !calibResult ? "等待几何标定" : "等待选择未知峰"}</span></div>}</section><section className="panel residual-card"><div className="analysis-card-heading"><span><Target size={18} /></span><div><h2>参考线几何复核</h2><p>参考线只用于标定零级位置和几何参数。</p></div></div>{calibResult ? <div className="residual-table"><div><b>参考 λ</b><b>像素 x</b><b>衍射角 θ</b><b>残差</b></div>{calibResult.references.map((line) => <div key={line.wavelengthNm}><span>{line.wavelengthNm.toFixed(2)} nm</span><span>{line.xPx.toFixed(1)} px</span><strong>{line.thetaDeg.toFixed(3)}°</strong><span>{line.residualNm.toFixed(2)} nm</span></div>)}<div><span>x₀ = {calibResult.x0Px.toFixed(1)} px</span><span>L = {calibResult.Lpx.toFixed(0)} px</span><strong>RMSE {calibResult.rmseNm.toFixed(2)} nm</strong></div></div> : <div className="result-placeholder compact"><Target size={25} /><span>完成标定后显示几何信息</span></div>}</section></div></div><section className="panel process-panel"><div className="analysis-card-heading wide"><span><SlidersHorizontal size={18} /></span><div><h2>图像处理全过程</h2><p>图像用于参考线标定和未知峰定位。</p></div></div><ProcessingTimeline image={aImage} selectedCount={unknownResults.length} resultText={calibResult ? `d = ${calibResult.dUm.toFixed(3)} μm · ${unknownResults.length} 个未知峰` : "等待几何标定"} /></section></div>;
}

function openLocalRecordReport(record: SavedRecord) {
  const url = URL.createObjectURL(new Blob([buildExperimentReportHtml(record)], { type: "text/html;charset=utf-8" }));
  window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function RecordsModule() {
  const [records, setRecords] = useState<SavedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SavedRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const latest = await listLocalRecords(100);
      setRecords(latest);
      setSelected((current) => {
        const newest = latest[0] ?? null;
        if (!current || !newest || Number(new Date(newest.updatedAt)) > Number(new Date(current.updatedAt))) return newest;
        return latest.find((record) => record.id === current.id) ?? newest;
      });
      setLastUpdated(Date.now());
      setErrorMessage("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "本地实验记录读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const onFocus = () => void refresh();
    const onLocalRecordsChanged = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("spectra-local-records-changed", onLocalRecordsChanged);
    return () => { window.clearTimeout(initial); window.removeEventListener("focus", onFocus); window.removeEventListener("spectra-local-records-changed", onLocalRecordsChanged); };
  }, [refresh]);

  const exportCsv = () => {
    downloadFile("spectra-experiments.csv", buildRecordsCsv(records), "text/csv");
  };

  const exportBackup = async () => {
    try {
      downloadBlob("spectra-experiments-backup.json", await exportLocalRecordsBackup());
      toast.success("完整实验记录备份已导出");
    } catch (error) {
      const message = error instanceof Error ? error.message : "本地记录备份失败";
      setErrorMessage(message);
      toast.error(message);
    }
  };

  const importBackup = async (file?: File) => {
    if (!file) return;
    try {
      const count = await importLocalRecordsFile(file);
      await refresh();
      toast.success(`已导入 ${count} 条实验记录`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "实验记录导入失败";
      setErrorMessage(message);
      toast.error(message);
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const removeRecord = async (record: SavedRecord) => {
    if (!window.confirm(`确定删除“${record.resultLabel} · ${record.resultValue}”这条实验记录吗？\n删除后无法恢复，除非你已经导出过备份。`)) return;
    try {
      await deleteLocalRecord(record.id);
      if (selected?.id === record.id) setSelected(null);
      await refresh();
      toast.success("实验记录已删除");
    } catch (error) {
      const message = error instanceof Error ? error.message : "实验记录删除失败";
      setErrorMessage(message);
      toast.error(message);
    }
  };

  const markerCount = Array.isArray(selected?.payload.referenceMarkers) ? selected.payload.referenceMarkers.length : 0;
  const imageEntries = selected ? Object.entries(selected.imageUrls) as [ExperimentImageSlot, string][] : [];
  const auraUsage = selected ? normalizeAuraUsage(selected.payload.assistant) : emptyAuraUsage();
  const auraEvents = [...auraUsage.events].reverse().slice(0, 8);
  const auraModeLabel = auraUsage.mode === "mixed" ? "本地 + 在线" : auraUsage.mode === "online" ? "在线 AI" : auraUsage.mode === "local" ? "本地页面助教" : "未记录";

  return <div className="module-page">
    <PageHeading
      eyebrow="课后 · 实验记录与复盘"
      title="回看每次实验，复核过程与结果。"
      description="记录保存在当前浏览器中；支持 CSV、完整备份导入导出和实验报告。"
      action={<div className="records-actions">
        <button className="secondary-action" onClick={exportCsv} disabled={!records.length}><Download size={16} />导出 CSV</button>
        <button className="secondary-action" onClick={() => void exportBackup()} disabled={!records.length}><Download size={16} />导出备份</button>
        <label className="secondary-action records-import"><Upload size={16} />导入 CSV/备份<input ref={importInputRef} type="file" accept=".csv,.json,text/csv,application/json" onChange={(event) => void importBackup(event.target.files?.[0])} /></label>
      </div>}
    />
    <div className={`records-sync ${errorMessage ? "error" : ""}`} aria-live="polite">
      {errorMessage
        ? <><CircleAlert size={15} /><span>{errorMessage}</span><button onClick={() => void refresh()}>重新加载</button></>
        : <><CheckCircle2 size={15} /><span>{lastUpdated ? `本地记录已更新 · ${formatChinaClock(lastUpdated)}` : "正在读取本地记录"}</span></>}
    </div>
    <div className="records-grid">
      <section className="panel record-list">
        <div className="panel-title"><div><span className="step-index"><History size={14} /></span><h2>我的实验</h2></div><span>{records.length} 条</span></div>
        {loading
          ? <div className="record-empty">正在读取本地实验记录…</div>
          : records.length
            ? records.map((record) => <button key={record.id} className={selected?.id === record.id ? "active" : ""} onClick={() => setSelected(record)}><span className="record-source"><Waves size={18} /></span><div><strong>{record.resultLabel}<small>{record.resultValue}</small></strong><p><Clock3 size={12} />{formatChinaDateTime(record.updatedAt)} · {record.source}</p></div><em className={record.status === "completed" ? "good" : ""}>{record.status === "draft" ? "进行中" : record.status === "needs_review" ? "需复核" : "已完成"}</em></button>)
            : <div className="record-empty"><History size={30} /><strong>还没有实验记录</strong><p>上传光谱图片后，实验过程会自动保存到这台设备。</p></div>}
      </section>
      <section className="panel replay-panel">
        {selected ? <>
          <div className="replay-head">
            <div><p className="eyebrow">实验回放</p><h2>{selected.resultLabel} · {selected.resultValue}</h2><small>最后保存于 {formatChinaDateTime(selected.updatedAt)}</small></div>
            <div className="replay-actions">
              <button className="secondary-action" onClick={() => openLocalRecordReport(selected)}><FileText size={16} />查看 / 打印报告</button>
              <button className="danger-action" onClick={() => void removeRecord(selected)}><Trash2 size={16} />删除记录</button>
            </div>
          </div>
          <div className="record-evidence"><span><small>已完成阶段</small><strong>{selected.steps.length} 项</strong></span><span><small>匹配汞线</small><strong>{markerCount} 条</strong></span><span><small>记录状态</small><strong>{selected.quality}</strong></span></div>
          {imageEntries.length > 0 && <div className="record-images">{imageEntries.map(([slot, url]) => <figure key={slot}><img src={url} alt="原始光谱照片" /><figcaption>{slot === "zero_reference" ? "零级参考照片" : slot === "primary" ? "一级单侧谱图" : slot === "repeat_2" ? "重复照片 2" : "重复照片 3"}</figcaption></figure>)}</div>}
          <div className="timeline">{selected.steps.length ? selected.steps.map((step, index) => <div className="timeline-item" key={step}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{step}</strong><p>{step === "d 反演及不确定度评估" ? `${selected.resultLabel} = ${selected.resultValue}` : "该阶段的参数和证据已保存在本机。"}</p></div>{index < selected.steps.length - 1 && <i />}</div>) : <div className="record-empty compact"><History size={28} /><strong>实验尚未开始</strong></div>}</div>
          <div className="record-aura">
            <div className="record-aura-head"><div><strong>AURA 辅助使用历史</strong><p>仅记录页面交互类型、模块和时间，不保存提问或回答原文。</p></div><span>{auraUsage.used ? `${auraUsage.interactionCount} 次` : "未记录"}</span></div>
            {auraUsage.used ? <div className="record-aura-body">
              <div className="record-aura-metrics"><span><small>使用模式</small><strong>{auraModeLabel}</strong></span><span><small>最后模块</small><strong>{auraUsageModuleLabel(auraUsage.lastModule)}</strong></span><span><small>最后使用</small><strong>{auraUsage.lastUsedAt ? formatChinaDateTime(auraUsage.lastUsedAt) : "未记录"}</strong></span></div>
              {auraEvents.length > 0 && <div className="record-aura-events">{auraEvents.map((event, index) => <div key={`${event.at}-${event.action}-${index}`}><span>{formatChinaDateTime(event.at)}</span><strong>{auraUsageActionLabel(event.action)}</strong><small>{auraUsageModuleLabel(event.targetModule ?? event.module)}{event.promptType ? ` · ${auraUsagePromptLabel(event.promptType)}` : ""}</small></div>)}</div>}
            </div> : <p className="record-aura-empty">这条记录没有保存 AURA 使用历史。旧记录不包含该字段，属于正常情况。</p>}
          </div>
          <div className="record-diagnosis"><strong>异常诊断与复核意见</strong><p>{selected.diagnosis || "未填写异常诊断或复核意见。"}</p></div>
        </> : <div className="record-empty"><Microscope size={34} /><strong>选择一条记录开始回放</strong></div>}
      </section>
    </div>
  </div>;
}

function downloadFile(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob(["\ufeff", content], { type: `${type};charset=utf-8` })); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); }
function downloadBlob(name: string, blob: Blob) { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }

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
        assistant: patch.assistant ?? current.assistant,
      });
      return JSON.stringify({ ...next, updatedAt: 0 }) === JSON.stringify({ ...current, updatedAt: 0 }) ? current : next;
    });
  }, []);
  const recordAuraUsage = useCallback((event: AuraUsageEventInput) => {
    setJourney((current) => ({
      ...current,
      assistant: appendAuraUsageEvent(current.assistant, event),
      updatedAt: Date.now(),
    }));
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
    const resetTimer = window.setTimeout(() => setJourney(fresh), 0);
    if (!authenticated) {
      journeyLoadedRef.current = true;
      return () => window.clearTimeout(resetTimer);
    }
    fetch("/api/journey", { method: "DELETE" })
      .catch(() => undefined)
      .finally(() => { journeyLoadedRef.current = true; });
    return () => window.clearTimeout(resetTimer);
  }, [authenticated]);
  const [localRecordCount, setLocalRecordCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const refreshLocalRecordCount = () => {
      void listLocalRecords(100)
        .then((records) => { if (!cancelled) setLocalRecordCount(records.length); })
        .catch(() => { if (!cancelled) setLocalRecordCount(null); });
    };
    const scheduleRefresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refreshLocalRecordCount, 0);
    };
    scheduleRefresh();
    window.addEventListener("focus", scheduleRefresh);
    window.addEventListener("spectra-local-records-changed", scheduleRefresh);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", scheduleRefresh);
      window.removeEventListener("spectra-local-records-changed", scheduleRefresh);
    };
  }, []);

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
  return <main className={`app-shell ${active === "home" ? "" : "module-ambient"}`}><AppHeader active={active} onChange={setActive} localRecordCount={localRecordCount} />{active === "home" && <HomeModule navigate={setActive} />}{active === "simulator" && <SimulatorModule journey={journey} navigate={setActive} updateJourney={updateJourney} />}{active === "assistant" && <AssistantModule journey={journey} navigate={setActive} />}{active === "analysis" && <AnalysisModule key={analyzeSignal} analyzeSignal={analyzeSignal} journey={journey} updateJourney={updateJourney} finishExperiment={resetExperiment} />}{active === "records" && <RecordsModule />}{active !== "assistant" && <footer><span><Aperture size={16} />SPECTRA · AI 分光计实验学习助手</span></footer>}<FloatingAssistant journey={journey} authenticated={authenticated} activeModule={active} localRecordCount={localRecordCount} onNavigate={setActive} onAuraUsage={recordAuraUsage} /><Toaster position="top-center" richColors /></main>;
}
