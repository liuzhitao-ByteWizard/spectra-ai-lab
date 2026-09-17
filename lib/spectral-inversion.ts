// AI 光谱参数反演系统 — 核心算法
// 移植自离线演示 HTML，含强度提取、峰值检测、自动匹配、坐标下降标定

export type SpectralStandard = {
  key: string;
  label: string;
  colorName: string;
  wavelength: number;
  color: string;
};

export const MERCURY_LINES: SpectralStandard[] = [
  { key: "violet", label: "Hg 404.66", colorName: "紫光", wavelength: 404.66, color: "#7c3aed" },
  { key: "blue", label: "Hg 435.84", colorName: "蓝光", wavelength: 435.84, color: "#0ea5e9" },
  { key: "green", label: "Hg 546.07", colorName: "绿光", wavelength: 546.07, color: "#16a34a" },
  { key: "yellow1", label: "Hg 576.96", colorName: "黄光", wavelength: 576.96, color: "#eab308" },
  { key: "yellow2", label: "Hg 579.07", colorName: "黄光", wavelength: 579.07, color: "#facc15" },
];

export type DetectedPeak = {
  x: number;
  height: number;
  family: string;
  color: string;
};

export type MatchedLine = {
  peak: { x: number; height: number; family: string; color: string };
  standard: SpectralStandard;
};

export type Calibration = {
  x0Px: number;
  effectiveLPx: number;
  dUm: number;
  rmseNm: number;
  reversed: boolean;
};

// ── 波长预测：λ = d · |x − x₀| / √((x − x₀)² + L²) ──
export function predictWavelength(xPx: number, dNm: number, x0Px: number, Lpx: number): number {
  const z = xPx - x0Px;
  return dNm * Math.abs(z) / Math.sqrt(z * z + Lpx * Lpx);
}

// ── RMSE ──
export function computeRmse(
  xs: number[],
  wavelengths: number[],
  dNm: number,
  x0Px: number,
  Lpx: number,
): number {
  const residuals = xs.map((x, i) => predictWavelength(x, dNm, x0Px, Lpx) - wavelengths[i]);
  return Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
}

// ── HSV 工具 ──
function rgbToHsv(r: number, g: number, b: number) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { hue: h, saturation: max ? d / max : 0, value: max };
}

function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function classifyFamily(hue: number, sat: number, val: number): string {
  if (sat < 0.12 || val < 0.12) return "unknown";
  if (hue >= 35 && hue < 75) return "yellow";
  if (hue >= 75 && hue < 170) return "green";
  if (hue >= 170 && hue < 245) return "blue";
  if (hue >= 245 && hue < 330) return "violet";
  return "unknown";
}

function familyColor(family: string): string {
  return { yellow: "#facc15", green: "#16a34a", blue: "#0ea5e9", violet: "#7c3aed" }[family] || "#94a3b8";
}

// ── 强度提取：饱和度 × 亮度加权，只取垂直中间带 ──
export function extractIntensityProfile(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Float64Array {
  const profile = new Float64Array(width);
  const yStart = Math.floor(height * 0.12);
  const yEnd = Math.ceil(height * 0.88);
  for (let x = 0; x < width; x++) {
    let sum = 0, count = 0;
    for (let y = yStart; y < yEnd; y++) {
      const idx = (y * width + x) * 4;
      const r = data[idx] / 255, g = data[idx + 1] / 255, b = data[idx + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max <= 0 ? 0 : (max - min) / max;
      sum += Math.max(0, sat * max + Math.max(0, max - 0.18) * 0.15);
      count++;
    }
    profile[x] = count ? sum / count : 0;
  }
  return profile;
}

// ── 分色通道强度提取 ──
const COLOR_FAMILIES = [
  { family: "yellow", hue: 55, spread: 24 },
  { family: "green", hue: 120, spread: 42 },
  { family: "blue", hue: 202, spread: 36 },
  { family: "violet", hue: 275, spread: 48 },
];

export function extractChannelProfiles(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Map<string, Float64Array> {
  const result = new Map<string, Float64Array>();
  const yStart = Math.floor(height * 0.12);
  const yEnd = Math.ceil(height * 0.88);
  const yMid = (height - 1) / 2;
  const ySigma = Math.max(height / 4.6, 1);

  for (const { family, hue, spread } of COLOR_FAMILIES) {
    const profile = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      let weighted = 0, weightSum = 0;
      for (let y = yStart; y < yEnd; y++) {
        const idx = (y * width + x) * 4;
        const r = data[idx] / 255, g = data[idx + 1] / 255, b = data[idx + 2] / 255;
        const hsv = rgbToHsv(r, g, b);
        const gauss = Math.exp(-0.5 * ((y - yMid) / ySigma) ** 2);
        const w = Math.exp(-((hueDist(hsv.hue, hue) / spread) ** 2))
          * Math.pow(Math.max(0, hsv.saturation), 1.25)
          * Math.max(0, hsv.value - 0.05)
          * gauss;
        weighted += w;
        weightSum += gauss;
      }
      profile[x] = weightSum ? weighted / weightSum : 0;
    }
    // 自适应阈值：取排序后 70% 分位
    const sorted = Array.from(profile).sort((a, b) => a - b);
    const thresh = sorted[Math.min(sorted.length - 1, Math.floor(0.7 * sorted.length))] || 0.012;
    result.set(family, profile.map((v) => Math.max(0, v - thresh)));
  }
  return result;
}

// ── 亚像素峰定位（抛物线插值）──
function subpixelPeak(profile: ArrayLike<number>, idx: number): number {
  if (idx <= 0 || idx >= profile.length - 1) return Number(idx.toFixed(2));
  const a = profile[idx - 1], b = profile[idx], c = profile[idx + 1];
  const denom = a - 2 * b + c;
  if (Math.abs(denom) < 1e-9) return Number(idx.toFixed(2));
  const offset = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denom));
  return Number((idx + offset).toFixed(2));
}

// ── 基础峰检测 ──
function findPeaks(profile: ArrayLike<number>, threshold: number, minDist: number) {
  const peaks: { x: number; score: number }[] = [];
  const win = Math.max(5, Math.round(minDist));
  for (let i = 2; i < profile.length - 2; i++) {
    if (profile[i] < threshold) continue;
    if (profile[i] < profile[i - 1] || profile[i] < profile[i + 1]) continue;
    if (profile[i] < profile[i - 2] || profile[i] < profile[i + 2]) continue;
    const lo = Math.max(0, i - win), hi = Math.min(profile.length - 1, i + win);
    let localMin = Infinity;
    for (let j = lo; j <= hi; j++) localMin = Math.min(localMin, profile[j]);
    const prom = profile[i] - localMin;
    if (prom < threshold * 0.32) continue;
    peaks.push({ x: subpixelPeak(profile, i), score: profile[i] + prom });
  }
  return peaks;
}

// ── 最小峰间距（按颜色族区分）──
function minDistFor(a: DetectedPeak, b: DetectedPeak, baseDist: number): number {
  if (a.family === "yellow" && b.family === "yellow") return Math.max(2, Math.round(baseDist * 0.32));
  if (a.family !== b.family) return Math.max(3, Math.round(baseDist * 0.5));
  return Math.max(4, Math.round(baseDist));
}

// ── 峰值检测：全局 + 分色通道 ──
export function detectPeaks(
  profile: Float64Array,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  { prominence, minDistance }: { prominence: number; minDistance: number },
): DetectedPeak[] {
  const candidates: DetectedPeak[] = [];

  // 全局通道
  const globalThresh = Math.max(0.018, prominence * 0.45);
  const globalMinDist = Math.max(4, minDistance);
  for (const { x, score } of findPeaks(profile, globalThresh, globalMinDist)) {
    candidates.push({ x, height: score, family: "unknown", color: "#94a3b8" });
  }

  // 分色通道
  const channels = extractChannelProfiles(data, width, height);
  for (const [family, chProfile] of channels) {
    const chThresh = Math.max(0.012, prominence * 0.24);
    const chMinDist = Math.max(3, Math.round(minDistance * 0.45));
    for (const { x, score } of findPeaks(chProfile, chThresh, chMinDist)) {
      candidates.push({ x, height: score + 0.2, family, color: familyColor(family) });
    }
  }

  // 过滤 + NMS
  const valid = candidates.filter((p) => p.height >= 0.015).sort((a, b) => b.height - a.height);
  const selected: DetectedPeak[] = [];
  for (const peak of valid) {
    if (selected.every((s) => Math.abs(s.x - peak.x) >= minDistFor(peak, s, minDistance))) {
      selected.push(peak);
    }
    if (selected.length >= 18) break;
  }
  return selected.sort((a, b) => a.x - b.x);
}

// ── 初始 x₀ 和 L 估计（线性回归）──
function initialEstimate(
  xs: number[],
  wavelengths: number[],
  dNm: number,
  reversed: boolean,
  imageWidth: number,
): { x0Px: number; effectiveLPx: number } {
  const dPx = dNm * 1000;
  const sign = reversed ? -1 : 1;
  const tanThetas = wavelengths.map((lam) => {
    const clamped = Math.min(Math.max(lam, 1), dPx - 1e-6);
    return sign * clamped / Math.sqrt(Math.max(1e-9, dPx * dPx - clamped * clamped));
  });
  const meanT = tanThetas.reduce((s, t) => s + t, 0) / tanThetas.length;
  const meanX = xs.reduce((s, x) => s + x, 0) / xs.length;
  const varT = tanThetas.reduce((s, t) => s + (t - meanT) ** 2, 0);
  const cov = tanThetas.reduce((s, t, i) => s + (t - meanT) * (xs[i] - meanX), 0);
  const L = Math.abs(varT > 1e-9 ? cov / varT : Math.max(imageWidth * 2.6, 1000));
  const x0 = meanX - L * meanT;
  if (Number.isFinite(x0) && Number.isFinite(L) && L >= 100) {
    return { x0Px: x0, effectiveLPx: L };
  }
  return {
    x0Px: reversed ? Math.min(...xs) - imageWidth * 0.7 : Math.max(...xs) + imageWidth * 0.7,
    effectiveLPx: Math.max(imageWidth * 2.6, 1000),
  };
}

// ── 坐标下降优化 x₀ 和 L ──
export function calibrate(
  lines: MatchedLine[],
  dUm: number,
  imageWidth: number,
): Calibration {
  const xs = lines.map((l) => l.peak.x);
  const wavelengths = lines.map((l) => l.standard.wavelength);
  const reversed = (xs[xs.length - 1] - xs[0]) * (wavelengths[wavelengths.length - 1] - wavelengths[0]) < 0;
  const dNm = dUm * 1000;

  let { x0Px, effectiveLPx } = initialEstimate(xs, wavelengths, dNm, reversed, imageWidth);
  let x0Step = Math.max(imageWidth * 0.45, Math.abs(effectiveLPx) * 0.12, 30);
  let lStep = Math.max(imageWidth * 0.85, Math.abs(effectiveLPx) * 0.22, 80);
  let bestRmse = computeRmse(xs, wavelengths, dNm, x0Px, effectiveLPx);

  for (let iter = 0; iter < 120; iter++) {
    let improved = false;
    const candidates: [number, number][] = [
      [x0Px - x0Step, effectiveLPx], [x0Px + x0Step, effectiveLPx],
      [x0Px - x0Step * 0.5, effectiveLPx], [x0Px + x0Step * 0.5, effectiveLPx],
      [x0Px, Math.max(100, effectiveLPx - lStep)], [x0Px, effectiveLPx + lStep],
      [x0Px, Math.max(100, effectiveLPx - lStep * 0.5)], [x0Px, effectiveLPx + lStep * 0.5],
      [x0Px - x0Step, Math.max(100, effectiveLPx - lStep)], [x0Px - x0Step, effectiveLPx + lStep],
      [x0Px + x0Step, Math.max(100, effectiveLPx - lStep)], [x0Px + x0Step, effectiveLPx + lStep],
    ];
    for (const [nx, nl] of candidates) {
      const rmse = computeRmse(xs, wavelengths, dNm, nx, nl);
      if (rmse < bestRmse) { bestRmse = rmse; x0Px = nx; effectiveLPx = nl; improved = true; }
    }
    if (!improved) { x0Step *= 0.55; lStep *= 0.55; }
    if (x0Step < 0.01 && lStep < 0.01) break;
  }

  return { x0Px, effectiveLPx: Math.abs(effectiveLPx), dUm, rmseNm: bestRmse, reversed };
}

// ── 组合枚举 ──
function combinations<T>(arr: T[], k: number): T[][] {
  const result: T[][] = [];
  const pick: T[] = [];
  function helper(start: number) {
    if (pick.length === k) { result.push([...pick]); return; }
    for (let i = start; i <= arr.length - (k - pick.length); i++) {
      pick.push(arr[i]); helper(i + 1); pick.pop();
    }
  }
  helper(0);
  return result;
}

// ── 自动匹配：组合搜索 + RMSE 评分 ──
export function autoMatch(
  peaks: DetectedPeak[],
  dUm: number,
  imageWidth: number,
): MatchedLine[] {
  const usable = [...peaks]
    .filter((p) => p.family !== "unknown" || p.height >= 0.12)
    .sort((a, b) => b.height - a.height)
    .slice(0, 9)
    .sort((a, b) => a.x - b.x);
  if (usable.length < 3) return [];

  let bestAssignments: MatchedLine[] = [];
  let bestScore = Infinity;
  let bestRmse = Infinity;
  const maxSize = Math.min(5, usable.length, MERCURY_LINES.length);

  for (let size = maxSize; size >= 3; size--) {
    for (const peakCombo of combinations(usable, size)) {
      for (const stdCombo of combinations(MERCURY_LINES, size)) {
        for (const reversed of [false, true]) {
          const ordered = reversed ? [...stdCombo].reverse() : stdCombo;
          const assignments: MatchedLine[] = peakCombo.map((peak, i) => ({
            peak,
            standard: ordered[i],
          }));
          const calib = calibrate(assignments, dUm, imageWidth);
          const rmse = computeRmse(
            assignments.map((a) => a.peak.x),
            assignments.map((a) => a.standard.wavelength),
            dUm * 1000,
            calib.x0Px,
            calib.effectiveLPx,
          );
          const score = rmse + size * 1.5 - size * 0.85;
          if (score < bestScore) { bestScore = score; bestRmse = rmse; bestAssignments = assignments; }
        }
      }
      if (bestAssignments.length > 0 && size >= 4 && bestRmse <= 6) return bestAssignments;
    }
    if (bestAssignments.length > 0 && bestRmse <= 6) return bestAssignments;
  }
  return bestAssignments;
}
