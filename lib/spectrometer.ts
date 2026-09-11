export type MeasurementLine = {
  wavelengthNm: number;
  thetaDeg: number;
  label?: string;
};

export type PixelReferenceLine = {
  wavelengthNm: number;
  x: number;
};

export type SpectrumLine = {
  wavelengthNm: number;
  color: string;
  family: "violet" | "blue" | "green" | "yellow" | "red";
  intensity: number;
};

export const SPECTRAL_LIBRARY: Record<string, SpectrumLine[]> = {
  mercury: [
    { wavelengthNm: 404.66, color: "#8b5cf6", family: "violet", intensity: 0.72 },
    { wavelengthNm: 435.84, color: "#3b82f6", family: "blue", intensity: 0.9 },
    { wavelengthNm: 546.07, color: "#30dc84", family: "green", intensity: 1 },
    { wavelengthNm: 576.96, color: "#facc15", family: "yellow", intensity: 0.86 },
    { wavelengthNm: 579.07, color: "#fde047", family: "yellow", intensity: 0.82 },
  ],
  sodium: [
    { wavelengthNm: 588.995, color: "#ffc928", family: "yellow", intensity: 1 },
    { wavelengthNm: 589.592, color: "#ffe062", family: "yellow", intensity: 0.94 },
  ],
  hydrogen: [
    { wavelengthNm: 410.17, color: "#8b5cf6", family: "violet", intensity: 0.45 },
    { wavelengthNm: 434.05, color: "#4f7dff", family: "blue", intensity: 0.62 },
    { wavelengthNm: 486.13, color: "#20d7d1", family: "blue", intensity: 0.88 },
    { wavelengthNm: 656.28, color: "#ff334f", family: "red", intensity: 1 },
  ],
};

const degToRad = (degrees: number) => (degrees * Math.PI) / 180;
const radToDeg = (radians: number) => (radians * 180) / Math.PI;

export function diffractionAngle(wavelengthNm: number, gratingUm = 3.333, order = 1) {
  const ratio = (order * wavelengthNm) / (gratingUm * 1000);
  return Math.abs(ratio) > 1 ? null : radToDeg(Math.asin(ratio));
}

export function measureGrating(
  lines: MeasurementLine[],
  wavelengthUncertaintyNm = 0.02,
  angleResolutionArcmin = 1,
) {
  const valid = lines.filter(
    (line) => Number.isFinite(line.wavelengthNm) && Number.isFinite(line.thetaDeg) && line.thetaDeg > 0,
  );
  if (valid.length < 2) throw new Error("至少需要两条有效谱线读数");

  const thetaUncertainty = degToRad(angleResolutionArcmin / 60 / Math.sqrt(3));
  const weighted = valid.map((line) => {
    const theta = degToRad(line.thetaDeg);
    const sinTheta = Math.sin(theta);
    const dNm = line.wavelengthNm / sinTheta;
    const relative = Math.sqrt(
      (wavelengthUncertaintyNm / line.wavelengthNm) ** 2 +
        (Math.cos(theta) / sinTheta) ** 2 * thetaUncertainty ** 2,
    );
    const sigmaNm = Math.max(dNm * relative, 0.001);
    return { ...line, theta, sinTheta, dNm, sigmaNm, weight: 1 / sigmaNm ** 2 };
  });
  const numerator = weighted.reduce((sum, line) => sum + line.wavelengthNm * line.sinTheta * line.weight, 0);
  const denominator = weighted.reduce((sum, line) => sum + line.sinTheta ** 2 * line.weight, 0);
  const dNm = numerator / denominator;
  const uNm = Math.sqrt(1 / denominator);
  const residuals = weighted.map((line) => line.wavelengthNm - dNm * line.sinTheta);
  const rmseNm = Math.sqrt(residuals.reduce((sum, value) => sum + value ** 2, 0) / residuals.length);
  return {
    dUm: dNm / 1000,
    uncertaintyUm: (2 * uNm) / 1000,
    linesPerMm: 1_000_000 / dNm,
    nominalDeviationPercent: ((dNm / 3333.333 - 1) * 100),
    rmseNm,
    points: weighted.map((line, index) => ({
      wavelengthNm: line.wavelengthNm,
      thetaDeg: line.thetaDeg,
      sinTheta: line.sinTheta,
      residualNm: residuals[index],
    })),
  };
}

/**
 * Jointly fits the zero-order position, image scale and grating constant from
 * pixel locations.  The zero order is deliberately allowed outside the crop:
 * many phone photos contain only one side of the first-order spectrum.
 */
export function fitGratingFromPixels(
  references: PixelReferenceLine[],
  imageWidth: number,
) {
  const valid = references.filter(
    (line) => Number.isFinite(line.x) && Number.isFinite(line.wavelengthNm) && line.wavelengthNm > 0,
  );
  if (valid.length < 4) throw new Error("自动几何拟合至少需要 4 条有效参考谱线");

  const width = Math.max(100, imageWidth);
  const evaluate = (x0: number, L: number) => {
    const sines = valid.map((line) => {
      const delta = Math.abs(line.x - x0);
      return delta / Math.sqrt(L * L + delta * delta);
    });
    const denominator = sines.reduce((sum, value) => sum + value * value, 0);
    if (denominator < 1e-12) return { score: Number.POSITIVE_INFINITY, dNm: 0 };
    const dNm = valid.reduce((sum, line, index) => sum + line.wavelengthNm * sines[index], 0) / denominator;
    if (!Number.isFinite(dNm) || dNm < 1_000 || dNm > 8_000) return { score: Number.POSITIVE_INFINITY, dNm };
    const squared = valid.reduce((sum, line, index) => {
      const residual = line.wavelengthNm - dNm * sines[index];
      return sum + residual * residual;
    }, 0);
    return { score: Math.sqrt(squared / valid.length), dNm };
  };

  let best = { x0: width / 2, L: width * 4, score: Number.POSITIVE_INFINITY, dNm: 3333 };
  const minL = width * 0.4;
  // A camera FOV cannot support an arbitrarily large px/rad scale. Keeping a
  // realistic interval also removes the near-linear d/L degeneracy of a
  // one-sided crop instead of reporting a tiny residual with an absurd d.
  const maxL = width * 8;
  const optimizeScale = (x0: number) => {
    let lo = Math.log(minL), hi = Math.log(maxL);
    for (let iteration = 0; iteration < 48; iteration++) {
      const left = lo + (hi - lo) / 3;
      const right = hi - (hi - lo) / 3;
      if (evaluate(x0, Math.exp(left)).score <= evaluate(x0, Math.exp(right)).score) hi = right;
      else lo = left;
    }
    const L = Math.exp((lo + hi) / 2);
    return { x0, L, ...evaluate(x0, L) };
  };

  // Global search over x₀ with an independently optimized scale at every
  // position. This follows the narrow coupled x₀/L valley that defeated the
  // former fixed-geometry and simple coordinate-search approaches.
  const coarseStep = (5 * width) / 800;
  for (let xi = 0; xi <= 800; xi++) {
    const candidate = optimizeScale(-2 * width + coarseStep * xi);
    if (candidate.score < best.score) best = candidate;
  }
  let xStep = coarseStep;
  for (let round = 0; round < 10; round++) {
    const candidates = [-1, -.5, 0, .5, 1].map((offset) => optimizeScale(
      Math.min(3 * width, Math.max(-2 * width, best.x0 + offset * xStep)),
    ));
    best = candidates.reduce((winner, candidate) => candidate.score < winner.score ? candidate : winner, best);
    xStep *= .3;
  }

  if (!Number.isFinite(best.score)) throw new Error("参考线位置无法形成有效的光栅模型");
  const measurement = measureGrating(valid.map((line) => ({
    wavelengthNm: line.wavelengthNm,
    thetaDeg: radToDeg(Math.atan(Math.abs(line.x - best.x0) / best.L)),
  })));
  return { ...measurement, x0: best.x0, L: best.L };
}

export function calibrateSpectrum(
  references: { x: number; wavelengthNm: number }[],
  gratingUm: number,
  model: "plane" | "curved" = "plane",
) {
  if (references.length < 2) throw new Error("至少需要两条参考谱线");
  const dNm = gratingUm * 1000;
  const values = references.map((item) => {
    const base = Math.asin(item.wavelengthNm / dNm);
    return { ...item, t: model === "plane" ? Math.tan(base) : base };
  });
  const meanT = values.reduce((sum, item) => sum + item.t, 0) / values.length;
  const meanX = values.reduce((sum, item) => sum + item.x, 0) / values.length;
  const covariance = values.reduce((sum, item) => sum + (item.t - meanT) * (item.x - meanX), 0);
  const variance = values.reduce((sum, item) => sum + (item.t - meanT) ** 2, 0);
  const L = covariance / variance;
  const x0 = meanX - L * meanT;
  const predictedWavelength = (x: number) => {
    const t = (x - x0) / L;
    const theta = model === "plane" ? Math.atan(t) : t;
    return dNm * Math.sin(theta);
  };
  const errors = values.map((item) => predictedWavelength(item.x) - item.wavelengthNm);
  const rmseNm = Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length);
  return { L, x0, rmseNm, model, predict: predictedWavelength };
}

export function compareReadings(rows: { wavelengthNm: number; handDeg: number; aiDeg: number }[]) {
  const table = rows.map((row) => {
    const diffArcmin = (row.handDeg - row.aiDeg) * 60;
    return { ...row, diffArcmin, relativePercent: (diffArcmin / Math.max(row.aiDeg * 60, 0.001)) * 100 };
  });
  const differences = table.map((row) => row.diffArcmin);
  const average = differences.reduce((sum, value) => sum + value, 0) / Math.max(differences.length, 1);
  const spread = Math.sqrt(differences.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(differences.length, 1));
  const issues: string[] = [];
  if (Math.abs(average) > 1.2 && spread < 0.8) issues.push("各谱线偏差方向一致：检查零级方向或游标零位。");
  const largest = table.reduce((best, row) => Math.abs(row.diffArcmin) > Math.abs(best.diffArcmin) ? row : best, table[0]);
  if (largest && Math.abs(largest.diffArcmin) > 2.2) issues.push(`${largest.wavelengthNm.toFixed(2)} nm 单线偏差较大：复核认线与手读。`);
  const blue = table.filter((row) => row.wavelengthNm < 460);
  if (blue.length && blue.some((row) => Math.abs(row.diffArcmin) > 1.8)) issues.push("蓝紫端定位偏差偏大：弱谱线或短波像差可能影响读数。");
  if (!issues.length) issues.push("手读与 AI 读数一致性良好，未发现显著系统偏差。");
  return { table, averageArcmin: average, spreadArcmin: spread, issues, quality: Math.abs(average) < 1 && spread < 1 ? "优秀" : "需复核" };
}
