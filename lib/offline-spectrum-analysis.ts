export type MercuryLineKey = "violet" | "blue" | "green" | "yellow1" | "yellow2";

export type MercuryStandard = {
  key: MercuryLineKey;
  label: string;
  colorName: string;
  wavelength: number;
  color: string;
};

export type DetectedPeak = {
  x: number;
  height: number;
  family: "yellow" | "green" | "blue" | "violet" | "unknown";
  color: string;
  hue: number;
  saturation: number;
  value: number;
  colorName: string;
};

export type ManualPoint = {
  key: MercuryLineKey;
  label: string;
  color: string;
  wavelength: number;
  x: number;
};

export type MatchedLine = {
  id: string;
  x: number;
  height: number;
  colorName: string;
  color: string;
  matchKey: string;
  matchLabel: string;
  standardNm: number;
  predictedNm: number;
  residualNm: number;
  status: string;
  statusKey: "ok" | "review";
  order: number;
};

export type ProcessStep = { name: string; detail: string; count: number | null };

export type CalibrationResult = {
  summary: {
    mode: "calibration";
    imageWidth: number;
    imageHeight: number;
    detectedCount: number;
    usableCount: number;
    matchedCount: number;
    rmseNm?: number;
    maxAbsResidualNm?: number;
    fitQuality?: string;
    dUm?: number;
    manualCalibration: boolean;
    offlineFallback: boolean;
  };
  calibration?: {
    dUm: number;
    x0Px: number;
    effectiveLPx: number;
    rmseNm: number;
    sourceLineCount: number;
    validRangeNm: [number, number];
    createdAt: string;
  };
  lines: MatchedLine[];
  profile: { x: number; y: number }[];
  annotations: { type: string; x: number; label: string; color: string }[];
  detectedPeaks: DetectedPeak[];
  processing: {
    candidateCount: number;
    detectedCount: number;
    usableCount: number;
    matchedCount: number;
    manual: boolean;
    fallbackRequired: boolean;
    fallbackMessage: string;
    steps: ProcessStep[];
  };
  warnings?: string[];
};

export class PartialAnalysisError extends Error {
  partialResult?: CalibrationResult;
  constructor(message: string, partialResult?: CalibrationResult) {
    super(message);
    this.name = "PartialAnalysisError";
    this.partialResult = partialResult;
  }
}

export const MERCURY_LINES: MercuryStandard[] = [
  { key: "violet", label: "Hg 404.66", colorName: "紫光", wavelength: 404.66, color: "#7c3aed" },
  { key: "blue", label: "Hg 435.84", colorName: "蓝光", wavelength: 435.84, color: "#0ea5e9" },
  { key: "green", label: "Hg 546.07", colorName: "绿光", wavelength: 546.07, color: "#16a34a" },
  { key: "yellow1", label: "Hg 576.96", colorName: "黄光", wavelength: 576.96, color: "#eab308" },
  { key: "yellow2", label: "Hg 579.07", colorName: "黄光", wavelength: 579.07, color: "#facc15" },
];

export function lineDisplayName(key: string) {
  return MERCURY_LINES.find((line) => line.key === key)?.colorName
    || ({ violet: "紫光", blue: "蓝光", green: "绿光", yellow1: "黄光", yellow2: "黄光" } as Record<string, string>)[key]
    || "谱线";
}

export function familyColorName(family: string) {
  return ({ yellow: "黄光", green: "绿光", blue: "蓝光", violet: "紫光" } as Record<string, string>)[family] || "候选峰";
}

function familyColor(family: string) {
  return ({ yellow: "#facc15", green: "#16a34a", blue: "#0ea5e9", violet: "#7c3aed" } as Record<string, string>)[family] || "#94a3b8";
}

function baseFamily(key: string) {
  return key.startsWith("yellow") ? "yellow" : key;
}

function smooth(values: number[], radius: number) {
  const size = Math.max(3, radius % 2 ? radius : radius + 1);
  const half = Math.floor(size / 2);
  return values.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -half; offset <= half; offset++) {
      const value = values[index + offset];
      if (value !== undefined) { sum += value; count += 1; }
    }
    return count ? sum / count : 0;
  });
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))];
}

function rgbToHsv(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { hue, saturation: max ? delta / max : 0, value: max };
}

function hueDistance(a: number, b: number) {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

function classifyHue(hue: number, saturation: number, value: number): DetectedPeak["family"] {
  if (saturation < 0.12 || value < 0.12) return "unknown";
  if (hue >= 35 && hue < 75) return "yellow";
  if (hue >= 75 && hue < 170) return "green";
  if (hue >= 170 && hue < 245) return "blue";
  if (hue >= 245 && hue < 330) return "violet";
  return "unknown";
}

function minSeparation(peak: DetectedPeak, other: DetectedPeak, minDistance: number) {
  if (peak.family === "yellow" && other.family === "yellow") return Math.max(2, Math.round(minDistance * 0.32));
  if (peak.family !== other.family) return Math.max(3, Math.round(minDistance * 0.5));
  return Math.max(4, Math.round(minDistance));
}

function parabolicSubpixel(profile: number[], index: number) {
  if (index <= 0 || index >= profile.length - 1) return Number(index.toFixed(2));
  const left = profile[index - 1];
  const mid = profile[index];
  const right = profile[index + 1];
  const denom = left - 2 * mid + right;
  if (Math.abs(denom) < 1e-9) return Number(index.toFixed(2));
  const offset = Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denom));
  return Number((index + offset).toFixed(2));
}

function extractProfile(data: Uint8ClampedArray, width: number, height: number) {
  const profile = new Array<number>(width).fill(0);
  const startRow = Math.floor(height * 0.12);
  const endRow = Math.ceil(height * 0.88);
  for (let x = 0; x < width; x += 1) {
    let score = 0;
    let count = 0;
    for (let y = startRow; y < endRow; y += 1) {
      const index = (y * width + x) * 4;
      const r = data[index] / 255;
      const g = data[index + 1] / 255;
      const b = data[index + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max <= 0 ? 0 : (max - min) / max;
      score += Math.max(0, saturation * max + Math.max(0, max - 0.18) * 0.15);
      count += 1;
    }
    profile[x] = count ? score / count : 0;
  }
  const fine = smooth(profile, Math.max(3, Math.round(width / 420) | 1));
  const baseline = smooth(profile, Math.max(21, Math.round(width / 36) | 1));
  const enhanced = fine.map((value, index) => Math.max(0, value - baseline[index] * 0.72));
  const scale = percentile(enhanced, 99.5) || Math.max(...enhanced) || 1;
  return enhanced.map((value) => Math.min(1, value / scale));
}

function findPeaks(profile: number[], prominence: number, minDistance: number) {
  const peaks: { x: number; score: number }[] = [];
  const radius = Math.max(5, Math.round(minDistance));
  for (let index = 2; index < profile.length - 2; index += 1) {
    const value = profile[index];
    if (
      value < prominence ||
      value < profile[index - 1] ||
      value < profile[index + 1] ||
      value < profile[index - 2] ||
      value < profile[index + 2]
    ) continue;
    const left = Math.max(0, index - radius);
    const right = Math.min(profile.length - 1, index + radius);
    const baseline = Math.min(...profile.slice(left, index + 1), ...profile.slice(index, right + 1));
    const height = value - baseline;
    if (height < prominence * 0.32) continue;
    peaks.push({ x: parabolicSubpixel(profile, index), score: value + height });
  }
  return peaks;
}

function describePeak(x: number, height: number, data: ImageData, width: number, heightPx: number, forcedFamily?: string): DetectedPeak {
  const bytes = data.data;
  const x0 = Math.max(0, Math.round(x) - 2);
  const x1 = Math.min(width - 1, Math.round(x) + 2);
  const y0 = Math.floor(heightPx * 0.18);
  const y1 = Math.ceil(heightPx * 0.82);
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let wSum = 0;
  for (let px = x0; px <= x1; px += 1) {
    for (let py = y0; py < y1; py += 2) {
      const index = (py * width + px) * 4;
      const r = bytes[index] / 255;
      const g = bytes[index + 1] / 255;
      const b = bytes[index + 2] / 255;
      const max = Math.max(r, g, b);
      rSum += r * max;
      gSum += g * max;
      bSum += b * max;
      wSum += max;
    }
  }
  const rgb: [number, number, number] = wSum ? [rSum / wSum, gSum / wSum, bSum / wSum] : [1, 1, 1];
  const hsv = rgbToHsv(...rgb);
  const detected = classifyHue(hsv.hue, hsv.saturation, hsv.value);
  const family = forcedFamily && (detected === "unknown" || detected === forcedFamily || forcedFamily === "yellow")
    ? forcedFamily
    : detected;
  return {
    x: Number(x.toFixed(2)),
    height,
    family: family as DetectedPeak["family"],
    color: familyColor(family),
    hue: hsv.hue,
    saturation: hsv.saturation,
    value: hsv.value,
    colorName: familyColorName(family),
  };
}

function channelProfiles(data: ImageData, width: number, height: number) {
  const bytes = data.data;
  const bands = [
    { family: "yellow" as const, hue: 55, spread: 24 },
    { family: "green" as const, hue: 120, spread: 42 },
    { family: "blue" as const, hue: 202, spread: 36 },
    { family: "violet" as const, hue: 275, spread: 48 },
  ];
  const startRow = Math.floor(height * 0.12);
  const endRow = Math.ceil(height * 0.88);
  const mid = (height - 1) / 2;
  const sigma = Math.max(height / 4.6, 1);
  return bands.map((band) => {
    const channel = new Array<number>(width).fill(0);
    let globalScore = 0;
    let globalWeight = 0;
    for (let x = 0; x < width; x += 1) {
      let score = 0;
      let weight = 0;
      for (let y = startRow; y < endRow; y += 1) {
        const index = (y * width + x) * 4;
        const r = bytes[index] / 255;
        const g = bytes[index + 1] / 255;
        const b = bytes[index + 2] / 255;
        const hsv = rgbToHsv(r, g, b);
        const rowWeight = Math.exp(-0.5 * (((y - mid) / sigma) ** 2));
        const scorePart =
          Math.exp(-((hueDistance(hsv.hue, band.hue) / band.spread) ** 2)) *
          Math.pow(Math.max(0, hsv.saturation), 1.25) *
          Math.max(0, hsv.value - 0.05) *
          rowWeight;
        score += scorePart;
        weight += rowWeight;
      }
      channel[x] = weight ? score / weight : 0;
      globalScore = Math.max(globalScore, channel[x]);
      globalWeight += channel[x];
    }
    const scale = percentile(channel, 99.4) || Math.max(...channel) || 1;
    return {
      family: band.family,
      profile: smooth(channel.map((value) => Math.min(1, value / scale)), Math.max(3, Math.round(width / 620) | 1)),
    };
  });
}

function detectPeaks(data: ImageData, width: number, height: number, options: { prominence: number; minDistance: number }) {
  const profile = extractProfile(data.data, width, height);
  const found: DetectedPeak[] = [];
  for (const { x, score } of findPeaks(profile, Math.max(0.018, options.prominence * 0.45), Math.max(4, options.minDistance))) {
    found.push(describePeak(x, score, data, width, height));
  }
  for (const { family, profile: channel } of channelProfiles(data, width, height)) {
    const threshold = Math.max(0.012, options.prominence * 0.24);
    for (const { x, score } of findPeaks(channel, threshold, Math.max(3, Math.round(options.minDistance * 0.45)))) {
      found.push(describePeak(x, score + 0.2, data, width, height, family));
    }
  }
  const ranked = found.filter((peak) => peak.height >= 0.015).sort((a, b) => b.height - a.height);
  const kept: DetectedPeak[] = [];
  for (const peak of ranked) {
    if (kept.every((other) => Math.abs(other.x - peak.x) >= minSeparation(peak, other, options.minDistance))) kept.push(peak);
    if (kept.length >= 18) break;
  }
  return kept.sort((a, b) => a.x - b.x);
}

function downsampleProfile(profile: number[], width: number) {
  const step = Math.max(1, Math.floor(width / 180));
  const points: { x: number; y: number }[] = [];
  for (let x = 0; x < width; x += step) points.push({ x, y: profile[x] || 0 });
  return points;
}

function peakToStandard(x: number, height: number, family: DetectedPeak["family"]): DetectedPeak {
  return { x: Number(x), height: Number(height), family, color: familyColor(family), hue: 0, saturation: 1, value: 1, colorName: familyColorName(family) };
}

function wavelengthFromX(xPx: number, dUm: number, x0Px: number, effectiveLPx: number) {
  const delta = xPx - x0Px;
  return dUm * 1e3 * Math.abs(delta) / Math.sqrt(delta * delta + effectiveLPx * effectiveLPx);
}

function rmse(xs: number[], ys: number[], dUm: number, x0Px: number, effectiveLPx: number) {
  const residuals = xs.map((x, index) => wavelengthFromX(x, dUm, x0Px, effectiveLPx) - ys[index]);
  return Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length);
}

function initialFit(xs: number[], ys: number[], dUm: number, reversed: boolean, width: number) {
  const dNm = dUm * 1e3;
  // Matches original V1: O = reversed ? 1 : -1 (not the opposite).
  const sign = reversed ? 1 : -1;
  const tangents = ys.map((wavelength) => {
    const clamped = Math.min(Math.max(wavelength, 1), dNm - 1e-6);
    return (sign * clamped) / Math.sqrt(Math.max(1e-9, dNm * dNm - clamped * clamped));
  });
  const meanT = tangents.reduce((sum, value) => sum + value, 0) / tangents.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const varT = tangents.reduce((sum, value) => sum + (value - meanT) ** 2, 0);
  const cov = tangents.reduce((sum, value, index) => sum + (value - meanT) * (xs[index] - meanX), 0);
  const L = Math.abs(varT > 1e-9 ? cov / varT : Math.max(width * 2.6, 1e3));
  const x0 = meanX - L * meanT;
  if (Number.isFinite(x0) && Number.isFinite(L) && L >= 100) return { x0Px: x0, effectiveLPx: L };
  return {
    x0Px: reversed ? Math.min(...xs) - width * 0.7 : Math.max(...xs) + width * 0.7,
    effectiveLPx: Math.max(width * 2.6, 1e3),
  };
}

function fitCalibration(standards: { peak: { x: number }; standard: { wavelength: number } }[], dUm: number, width: number) {
  const xs = standards.map((row) => row.peak.x);
  const ys = standards.map((row) => row.standard.wavelength);
  const reversed = (xs[xs.length - 1] - xs[0]) * (ys[ys.length - 1] - ys[0]) >= 0;
  const initial = initialFit(xs, ys, dUm, reversed, width);
  let x0 = initial.x0Px;
  let L = initial.effectiveLPx;
  let stepX = Math.max(width * 0.45, Math.abs(L) * 0.12, 30);
  let stepL = Math.max(width * 0.85, Math.abs(L) * 0.22, 80);
  let cost = rmse(xs, ys, dUm, x0, L);
  for (let iteration = 0; iteration < 120; iteration += 1) {
    let improved = false;
    // Absolute candidates from this iteration's baseline — do not accumulate deltas.
    // L decrease is floored at 100 px to match the original offline fitter.
    const candidates: [number, number][] = [
      [x0 - stepX, L],
      [x0 + stepX, L],
      [x0 - stepX * 0.5, L],
      [x0 + stepX * 0.5, L],
      [x0, Math.max(100, L - stepL)],
      [x0, L + stepL],
      [x0, Math.max(100, L - stepL * 0.5)],
      [x0, L + stepL * 0.5],
      [x0 - stepX, Math.max(100, L - stepL)],
      [x0 - stepX, L + stepL],
      [x0 + stepX, Math.max(100, L - stepL)],
      [x0 + stepX, L + stepL],
    ];
    for (const [nextX0, nextL] of candidates) {
      const nextCost = rmse(xs, ys, dUm, nextX0, nextL);
      if (nextCost < cost) {
        cost = nextCost;
        x0 = nextX0;
        L = nextL;
        improved = true;
      }
    }
    if (!improved) {
      stepX *= 0.55;
      stepL *= 0.55;
    }
    if (stepX < 0.01 && stepL < 0.01) break;
  }
  return { x0Px: x0, effectiveLPx: Math.abs(L) };
}

function expectedFamily(key: string) {
  return baseFamily(key);
}

function colorMismatchPenalty(assignments: { peak: { family: string }; standard: { key: string } }[]) {
  return assignments.reduce((score, { peak, standard }) => {
    const expected = expectedFamily(standard.key);
    if (peak.family === expected) return score;
    if (peak.family === "unknown") return score + 0.25;
    if (expected === "yellow" && peak.family === "green") return score + 0.35;
    return score + 1.25;
  }, 0);
}

function combinations<T>(items: T[], choose: number): T[][] {
  const result: T[][] = [];
  const walk = (start: number, path: T[]) => {
    if (path.length === choose) {
      result.push([...path]);
      return;
    }
    for (let index = start; index <= items.length - (choose - path.length); index += 1) {
      path.push(items[index]);
      walk(index + 1, path);
      path.pop();
    }
  };
  walk(0, []);
  return result;
}

type Assignment = { peak: DetectedPeak; standard: MercuryStandard };
type MatchSearchResult = { assignments: Assignment[]; score: number; rmseValue: number };

function matchBySearch(peaks: DetectedPeak[], dUm: number, width: number): MatchSearchResult | null {
  const usable = [...peaks]
    .filter((peak) => peak.family !== "unknown" || peak.height >= 0.12)
    .sort((a, b) => b.height - a.height)
    .slice(0, 9)
    .sort((a, b) => a.x - b.x);
  if (usable.length < 3) return null;
  let best: MatchSearchResult | null = null;
  const maxLines = Math.min(5, usable.length, MERCURY_LINES.length);
  for (let count = maxLines; count >= 3; count -= 1) {
    for (const peakSet of combinations(usable, count)) {
      for (const standardSet of combinations(MERCURY_LINES, count)) {
        for (const reverse of [false, true]) {
          const standards: Assignment[] = (reverse ? [...peakSet].reverse() : peakSet).map((peak, index) => ({
            peak,
            standard: standardSet[index],
          }));
          const fit = fitCalibration(standards, dUm, width);
          const residual = rmse(
            standards.map((row) => row.peak.x),
            standards.map((row) => row.standard.wavelength),
            dUm,
            fit.x0Px,
            fit.effectiveLPx,
          );
          const score = residual + colorMismatchPenalty(standards) - count * 0.85;
          if (!best || score < best.score) best = { assignments: standards, score, rmseValue: residual };
        }
      }
    }
    const candidate: MatchSearchResult | null = best;
    if (candidate && count >= 4 && candidate.rmseValue <= 6) return candidate;
  }
  return best;
}

function matchLines(peaks: DetectedPeak[], dUm: number, width: number): Assignment[] {
  const search = matchBySearch(peaks, dUm, width);
  if (search) return search.assignments;
  const byFamily: Record<string, MercuryLineKey[]> = {
    violet: ["violet"],
    blue: ["blue"],
    green: ["green"],
    yellow: ["yellow1", "yellow2"],
  };
  const assignments: { peak: DetectedPeak; standard: MercuryStandard }[] = [];
  const used = new Set<string>();
  for (const peak of peaks) {
    const key = (byFamily[peak.family] || []).find((candidate) => !used.has(candidate));
    if (!key) continue;
    const standard = MERCURY_LINES.find((line) => line.key === key);
    if (!standard) continue;
    used.add(key);
    assignments.push({ peak, standard });
  }
  if (assignments.length >= 3) return assignments.sort((a, b) => a.peak.x - b.peak.x);
  const fallbackPeaks = peaks.filter((peak) => peak.family !== "unknown").slice(0, 5).sort((a, b) => a.x - b.x);
  const fallbackStandards = [...MERCURY_LINES].sort((a, b) => b.wavelength - a.wavelength).slice(0, fallbackPeaks.length);
  return fallbackPeaks.map((peak, index) => ({ peak, standard: fallbackStandards[index] }));
}

function makePartialResult(input: {
  width: number;
  height: number;
  profile: number[];
  detectedPeaks: DetectedPeak[];
  dUm: number;
}) {
  return {
    summary: {
      mode: "calibration" as const,
      imageWidth: input.width,
      imageHeight: input.height,
      detectedCount: input.detectedPeaks.length,
      usableCount: input.detectedPeaks.length,
      matchedCount: 0,
      manualCalibration: false,
      offlineFallback: true,
    },
    lines: [] as MatchedLine[],
    profile: downsampleProfile(input.profile, input.width),
    annotations: input.detectedPeaks.map((peak) => ({
      type: "candidate",
      x: peak.x,
      label: `${familyColorName(peak.family)} ${peak.x.toFixed(0)}px`,
      color: peak.color,
    })),
    detectedPeaks: input.detectedPeaks,
    processing: {
      candidateCount: input.detectedPeaks.length,
      detectedCount: input.detectedPeaks.length,
      usableCount: input.detectedPeaks.length,
      matchedCount: 0,
      manual: false,
      fallbackRequired: true,
      fallbackMessage: "自动谱线不足，请在照片上补选标准汞灯谱线，或降低峰值突出度后重新执行。",
      steps: [
        { name: "浏览器读取图像", detail: "已读取上传照片像素。", count: null },
        { name: "多通道峰值检测", detail: "已结合总光强和颜色通道搜索候选谱线。", count: input.detectedPeaks.length },
        { name: "等待人工补点", detail: "需要至少 3 条标准谱线才能完成物理约束标定。", count: 0 },
      ],
    },
    warnings: [`当前光栅常数 d=${input.dUm} μm；自动谱线不足时，请点选照片中清晰的汞灯谱线中心。`],
  } satisfies CalibrationResult;
}

function readImageData(file: File) {
  return new Promise<{ imageData: ImageData; width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("无法读取离线图像，请更换照片后重试。"));
        return;
      }
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve({ imageData: data, width: canvas.width, height: canvas.height });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取离线图像，请更换照片后重试。"));
    };
    image.src = url;
  });
}

export async function analyzeSpectrumOffline(
  file: File,
  options: { dUm: number; prominence: number; minDistance: number; manualPoints: ManualPoint[] },
): Promise<CalibrationResult> {
  const { imageData, width, height } = await readImageData(file);
  const profile = extractProfile(imageData.data, width, height);
  const peaks = detectPeaks(imageData, width, height, options);

  const assignments: Assignment[] = options.manualPoints.length >= 3
    ? options.manualPoints.flatMap((point): Assignment[] => {
        const standard = MERCURY_LINES.find((line) => line.key === point.key);
        if (!standard) return [];
        return [{
          peak: peakToStandard(point.x, 1, baseFamily(standard.key) as DetectedPeak["family"]),
          standard,
        }];
      })
    : matchLines(peaks, options.dUm, width);

  if (assignments.length < 3) {
    throw new PartialAnalysisError(
      `离线分析只检测到 ${peaks.length} 条有效谱线。请降低峰值突出度，或在照片中手动点选至少 3 条标准汞灯谱线后再执行标定。`,
      makePartialResult({ width, height, profile, detectedPeaks: peaks, dUm: options.dUm }),
    );
  }

  const fit = fitCalibration(assignments, options.dUm, width);
  const lines: MatchedLine[] = assignments.map(({ peak, standard }, index): MatchedLine => {
    const predicted = wavelengthFromX(peak.x, options.dUm, fit.x0Px, fit.effectiveLPx);
    const residual = predicted - standard.wavelength;
    return {
      id: `offline-${standard.key}-${index}`,
      x: peak.x,
      height: peak.height,
      colorName: lineDisplayName(standard.key),
      color: standard.color,
      matchKey: standard.key,
      matchLabel: standard.colorName,
      standardNm: standard.wavelength,
      predictedNm: predicted,
      residualNm: residual,
      status: Math.abs(residual) <= 2 ? "通过" : "复核",
      statusKey: Math.abs(residual) <= 2 ? "ok" : "review",
      order: index + 1,
    };
  }).sort((a, b) => a.x - b.x);

  const residuals = lines.map((line) => line.residualNm);
  const rmseNm = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length);
  const maxAbsResidualNm = Math.max(...residuals.map(Math.abs));

  return {
    summary: {
      mode: "calibration",
      imageWidth: width,
      imageHeight: height,
      detectedCount: peaks.length,
      usableCount: assignments.length,
      matchedCount: lines.length,
      rmseNm,
      maxAbsResidualNm,
      fitQuality: rmseNm <= 2 ? "优秀" : rmseNm <= 5 ? "可用" : "需复核",
      dUm: options.dUm,
      manualCalibration: options.manualPoints.length >= 3,
      offlineFallback: true,
    },
    calibration: {
      dUm: options.dUm,
      x0Px: fit.x0Px,
      effectiveLPx: fit.effectiveLPx,
      rmseNm,
      sourceLineCount: lines.length,
      validRangeNm: [Math.min(...lines.map((line) => line.standardNm)), Math.max(...lines.map((line) => line.standardNm))],
      createdAt: new Date().toISOString(),
    },
    lines,
    profile: downsampleProfile(profile, width),
    annotations: lines.map((line) => ({ type: "line", x: line.x, label: line.matchLabel, color: line.color })),
    detectedPeaks: peaks,
    processing: {
      candidateCount: peaks.length,
      detectedCount: peaks.length,
      usableCount: assignments.length,
      matchedCount: lines.length,
      manual: options.manualPoints.length >= 3,
      fallbackRequired: false,
      fallbackMessage: "",
      steps: [
        { name: "浏览器读取图像", detail: "使用 Canvas 读取上传照片像素。", count: null },
        { name: "光强剖面提取", detail: "按列统计颜色饱和度与亮度，得到一维光强曲线。", count: null },
        { name: "谱线峰值检测", detail: "在增强后的光强曲线中寻找局部峰值并估计颜色类型。", count: peaks.length },
        { name: "物理约束标定", detail: "用汞灯标准谱线拟合有效参数 x₀ 与 L。", count: lines.length },
      ],
    },
    warnings: [],
  };
}
