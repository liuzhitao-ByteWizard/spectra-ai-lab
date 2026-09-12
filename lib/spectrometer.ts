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

function solveSymmetric3(matrix: number[][], vector: number[]) {
  const a = matrix.map((row) => [...row]);
  const b = [...vector];
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    [b[column], b[pivot]] = [b[pivot], b[column]];
    const divisor = a[column][column];
    if (Math.abs(divisor) < 1e-14) return null;
    for (let index = column; index < 3; index++) a[column][index] /= divisor;
    b[column] /= divisor;
    for (let row = 0; row < 3; row++) if (row !== column) {
      const factor = a[row][column];
      for (let index = column; index < 3; index++) a[row][index] -= factor * a[column][index];
      b[row] -= factor * b[column];
    }
  }
  return b;
}

/**
 * Fits the grating projection together with a second-order camera-distortion
 * term. A phone lens is not an ideal pinhole; ignoring this small curvature
 * creates the opposite-sign residuals normally seen at the blue/violet edge.
 */
export function fitGratingFromPixels(
  references: PixelReferenceLine[],
  imageWidth: number,
) {
  const valid = references.filter(
    (line) => Number.isFinite(line.x) && Number.isFinite(line.wavelengthNm) && line.wavelengthNm > 0,
  );
  if (valid.length < 4) throw new Error("自动几何拟合至少需要 4 条有效参考谱线");
  if (!Number.isFinite(imageWidth) || imageWidth <= 0) throw new Error("图像宽度无效");

  const fitAt = (dNm: number) => {
    const t = valid.map((line) => Math.tan(Math.asin(line.wavelengthNm / dNm)));
    const sums = Array.from({ length: 5 }, (_, power) => t.reduce((sum, value) => sum + value ** power, 0));
    const right = Array.from({ length: 3 }, (_, power) => t.reduce((sum, value, index) => sum + valid[index].x * value ** power, 0));
    const coefficients = solveSymmetric3([
      [sums[0], sums[1], sums[2]],
      [sums[1], sums[2], sums[3]],
      [sums[2], sums[3], sums[4]],
    ], right);
    if (!coefficients) return null;
    const [x0, L, distortion] = coefficients;
    const predict = (x: number) => {
      if (Math.abs(distortion) < 1e-10) return dNm * Math.sin(Math.atan((x - x0) / L));
      const discriminant = Math.max(0, L * L - 4 * distortion * (x0 - x));
      const roots = [(-L + Math.sqrt(discriminant)) / (2 * distortion), (-L - Math.sqrt(discriminant)) / (2 * distortion)];
      const meanT = t.reduce((sum, value) => sum + value, 0) / t.length;
      const root = roots.reduce((closest, value) => Math.abs(value - meanT) < Math.abs(closest - meanT) ? value : closest, roots[0]);
      return dNm * Math.sin(Math.atan(root));
    };
    const residuals = valid.map((line) => line.wavelengthNm - predict(line.x));
    const rmseNm = Math.sqrt(residuals.reduce((sum, value) => sum + value * value, 0) / residuals.length);
    // The nominal grating value is only a very weak tie-breaker along the
    // d/L degeneracy; real spectral curvature still determines the minimum.
    const score = rmseNm + .02 * Math.abs(Math.log(dNm / 3333.333));
    return { dNm, x0, L, distortion, predict, residuals, rmseNm, score };
  };

  let best: ReturnType<typeof fitAt> = null;
  for (let dNm = 1500; dNm <= 8000; dNm += 5) {
    const candidate = fitAt(dNm);
    if (candidate && (!best || candidate.score < best.score)) best = candidate;
  }
  if (!best) throw new Error("参考线位置无法形成有效的光栅模型");
  for (let step = 1; step >= .01; step /= 10) {
    for (let dNm = best.dNm - 6 * step; dNm <= best.dNm + 6 * step; dNm += step) {
      const candidate = fitAt(dNm);
      if (candidate && candidate.score < best.score) best = candidate;
    }
  }

  const uncertaintyUm = Math.max(.001, best.rmseNm / Math.sqrt(valid.length) / 1000);
  return {
    dUm: best.dNm / 1000,
    uncertaintyUm,
    linesPerMm: 1_000_000 / best.dNm,
    nominalDeviationPercent: ((best.dNm / 3333.333 - 1) * 100),
    rmseNm: best.rmseNm,
    x0: best.x0,
    L: Math.abs(best.L),
    distortion: best.distortion,
    points: valid.map((line, index) => ({
      wavelengthNm: line.wavelengthNm,
      thetaDeg: radToDeg(Math.asin(best!.predict(line.x) / best!.dNm)),
      sinTheta: best!.predict(line.x) / best!.dNm,
      residualNm: best!.residuals[index],
    })),
  };
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
