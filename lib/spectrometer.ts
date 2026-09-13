export type MeasurementLine = {
  wavelengthNm: number;
  thetaDeg: number;
  label?: string;
};

export type PixelReferenceLine = {
  wavelengthNm: number;
  x: number;
  uncertaintyPx?: number;
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

export function fitGratingFromPixels(
  references: PixelReferenceLine[],
  zeroX: number,
  imageWidth: number,
  options: {
    zeroUncertaintyPx?: number;
    wavelengthUncertaintyNm?: number;
    repeatDValuesUm?: number[];
    referenceCalibration?: boolean;
  } = {},
) {
  const valid = references.filter(
    (line) => Number.isFinite(line.x) && Number.isFinite(line.wavelengthNm) && line.wavelengthNm > 0,
  );
  if (valid.length < 2) throw new Error("几何拟合至少需要 2 条有效参考线");
  if (!Number.isFinite(zeroX)) throw new Error("未检测到有效零级位置");
  if (!Number.isFinite(imageWidth) || imageWidth <= 0) throw new Error("图像宽度无效");
  if (options.referenceCalibration) {
    const dNm = 3333.333;
    const rows = valid.map((line) => ({ ...line, t: Math.tan(Math.asin(line.wavelengthNm / dNm)), weight: 1 / Math.max(line.uncertaintyPx ?? .35, .1) ** 2 }));
    // When the zero order is outside the frame, it has already been stably
    // inferred from these lines. Refit only the image scale around that x0.
    // A free cubic term is not identifiable from a single-side photograph and
    // used to turn a lens-distortion *diagnostic* into a false hard failure.
    const calibratedX0 = zeroX;
    const denominator = rows.reduce((sum, row) => sum + row.weight * row.t ** 2, 0);
    if (denominator <= 1e-12) throw new Error("参考线跨度不足，无法确定单侧成像尺度");
    const L = rows.reduce((sum, row) => sum + row.weight * row.t * (row.x - calibratedX0), 0) / denominator;
    if (!Number.isFinite(L) || Math.abs(L) < imageWidth) throw new Error("单侧参考线跨度不足，无法稳定标定零级");
    const predictedWavelengths = rows.map((row) => {
      const t = (row.x - calibratedX0) / L;
      return dNm * Math.abs(Math.sin(Math.atan(t)));
    });
    const residualsNm = rows.map((row, index) => row.wavelengthNm - predictedWavelengths[index]);
    const residualPx = rows.map((row) => row.x - (calibratedX0 + L * row.t));
    const rmseNm = Math.sqrt(residualsNm.reduce((sum, value) => sum + value ** 2, 0) / rows.length);
    const rmsePx = Math.sqrt(residualPx.reduce((sum, value) => sum + value ** 2, 0) / rows.length);
    const localizationUm = Math.max(.0001, rmseNm / dNm);
    const geometryStable = rmsePx <= Math.max(5, imageWidth * .012);
    const budget = [
      { key: "zero", label: "参考线联合零级定位", standardUncertaintyUm: localizationUm, status: "已评定" },
      { key: "localization", label: "谱线亚像素定位", standardUncertaintyUm: localizationUm, status: "已评定" },
      { key: "geometry", label: "镜头畸变诊断（不作为阻塞条件）", standardUncertaintyUm: null, status: geometryStable ? "未发现显著偏差" : "提示复核" },
      { key: "wavelength", label: "参考波长（uλ=0.01 nm）", standardUncertaintyUm: .0001, status: "已评定" },
      { key: "repeatability", label: "多张照片重复性", standardUncertaintyUm: null, status: "未评定" },
    ];
    const ucUm = Math.sqrt(budget.reduce((sum, item) => sum + (item.standardUncertaintyUm ?? 0) ** 2, 0));
    const reportable = rows.length >= 4 && geometryStable;
    return {
      dUm: dNm / 1000, uncertaintyUm: 2 * ucUm, standardUncertaintyUm: ucUm, expandedUncertaintyUm: 2 * ucUm,
      coverageFactor: 2, uncertaintyLabel: "参考光栅约束下的校准不确定度", uncertaintyBudget: budget,
      linesPerMm: 1_000_000 / dNm, nominalDeviationPercent: 0, rmseNm, rmsePx, x0: calibratedX0, L,
      lensBiasPx: 0, reportable, calibrationMode: true,
      blockReason: reportable ? "" : rows.length < 4 ? "画外零级校准至少需要 4 条参考线" : "参考线位置与单侧光栅模型不一致，请核对颜色和标记顺序",
      identifiability: { correlation: 0, profileLowUm: dNm / 1000, profileHighUm: dNm / 1000, boundaryHit: false },
      points: rows.map((row, index) => ({ wavelengthNm: row.wavelengthNm, thetaDeg: Math.abs(radToDeg(Math.atan((row.x - calibratedX0) / L))), sinTheta: predictedWavelengths[index] / dNm, residualNm: residualsNm[index] })),
    };
  }
  const lowerBound = Math.max(650, Math.max(...valid.map((line) => line.wavelengthNm)) * 1.02);
  const upperBound = 12_000;
  const fitAt = (dNm: number, lines = valid, x0 = zeroX) => {
    if (lines.some((line) => line.wavelengthNm >= dNm)) return null;
    const t = lines.map((line) => Math.tan(Math.asin(line.wavelengthNm / dNm)));
    const weights = lines.map((line) => 1 / Math.max(line.uncertaintyPx ?? .35, .1) ** 2);
    const denominator = t.reduce((sum, value, index) => sum + weights[index] * value * value, 0);
    if (denominator <= 0) return null;
    const L = t.reduce((sum, value, index) => sum + weights[index] * value * (lines[index].x - x0), 0) / denominator;
    // L is signed: a first-order spectrum may appear on either side of the
    // zero order. Its magnitude is the physical image scale.
    if (!Number.isFinite(L) || Math.abs(L) <= 0) return null;
    const residualPx = lines.map((line, index) => line.x - (x0 + L * t[index]));
    const sse = residualPx.reduce((sum, value, index) => sum + weights[index] * value * value, 0);
    return { dNm, L, t, weights, residualPx, sse };
  };
  const optimize = (lines = valid, x0 = zeroX) => {
    let best: ReturnType<typeof fitAt> = null;
    for (let dNm = lowerBound; dNm <= upperBound; dNm += 10) {
      const candidate = fitAt(dNm, lines, x0);
      if (candidate && (!best || candidate.sse < best.sse)) best = candidate;
    }
    if (!best) return null;
    for (const step of [2, .2, .02]) {
      const center = best.dNm;
      for (let dNm = Math.max(lowerBound, center - 20 * step); dNm <= Math.min(upperBound, center + 20 * step); dNm += step) {
        const candidate = fitAt(dNm, lines, x0);
        if (candidate && candidate.sse < best.sse) best = candidate;
      }
    }
    return best;
  };
  const best = optimize();
  if (!best) throw new Error("零级与一级谱线无法形成有效的光栅模型");
  const rmsePx = Math.sqrt(best.residualPx.reduce((sum, value) => sum + value ** 2, 0) / valid.length);
  const predictedWavelengths = valid.map((line) => best.dNm * Math.abs(Math.sin(Math.atan((line.x - zeroX) / best.L))));
  const residualsNm = valid.map((line, index) => line.wavelengthNm - predictedWavelengths[index]);
  const rmseNm = Math.sqrt(residualsNm.reduce((sum, value) => sum + value ** 2, 0) / valid.length);

  let jdd = 0, jdl = 0, jll = 0;
  best.t.forEach((t, index) => {
    const wavelength = valid[index].wavelengthNm;
    const ratio = wavelength / best.dNm;
    const derivativeD = -best.L * wavelength / best.dNm ** 2 / Math.max((1 - ratio ** 2) ** 1.5, 1e-9);
    const weight = best.weights[index];
    jdd += weight * derivativeD ** 2; jdl += weight * derivativeD * t; jll += weight * t ** 2;
  });
  const determinant = jdd * jll - jdl ** 2;
  const noiseScale = Math.max(1, best.sse / Math.max(valid.length - 2, 1));
  const varianceD = determinant > 0 ? noiseScale * jll / determinant : Number.POSITIVE_INFINITY;
  const varianceL = determinant > 0 ? noiseScale * jdd / determinant : Number.POSITIVE_INFINITY;
  const covarianceDL = determinant > 0 ? -noiseScale * jdl / determinant : Number.POSITIVE_INFINITY;
  const correlation = Number.isFinite(covarianceDL) ? covarianceDL / Math.sqrt(varianceD * varianceL) : 1;

  const profileThreshold = best.sse + 3.841;
  let profileLow = best.dNm, profileHigh = best.dNm;
  for (let dNm = lowerBound; dNm <= upperBound; dNm += 2) {
    const candidate = fitAt(dNm);
    if (candidate && candidate.sse <= profileThreshold) {
      profileLow = Math.min(profileLow, dNm); profileHigh = Math.max(profileHigh, dNm);
    }
  }
  const boundaryHit = best.dNm - lowerBound < 25 || upperBound - best.dNm < 25 || profileLow === lowerBound || profileHigh === upperBound;
  const zeroU = Math.max(options.zeroUncertaintyPx ?? .5, .1);
  const zeroMinus = optimize(valid, zeroX - zeroU)?.dNm ?? best.dNm;
  const zeroPlus = optimize(valid, zeroX + zeroU)?.dNm ?? best.dNm;
  const uZeroUm = Math.abs(zeroPlus - zeroMinus) / 2000;
  const uLocalizationUm = Math.sqrt(varianceD) / 1000;
  const leaveOneOut = valid.map((_, index) => optimize(valid.filter((__, lineIndex) => lineIndex !== index))?.dNm).filter((value): value is number => typeof value === "number");
  const uGeometryUm = leaveOneOut.length > 1 ? Math.sqrt(leaveOneOut.reduce((sum, value) => sum + (value - best.dNm) ** 2, 0) / leaveOneOut.length) / 1000 : 0;
  const wavelengthU = options.wavelengthUncertaintyNm ?? .01;
  const uWavelengthUm = best.dNm * wavelengthU / (valid.reduce((sum, line) => sum + line.wavelengthNm, 0) / valid.length) / 1000;
  const repeats = (options.repeatDValuesUm ?? []).filter(Number.isFinite);
  const repeatMean = repeats.reduce((sum, value) => sum + value, 0) / Math.max(repeats.length, 1);
  const uRepeatUm = repeats.length > 1 ? Math.sqrt(repeats.reduce((sum, value) => sum + (value - repeatMean) ** 2, 0) / (repeats.length - 1)) / Math.sqrt(repeats.length) : null;
  const budget = [
    { key: "zero", label: "零级定位", standardUncertaintyUm: uZeroUm, status: "已评定" },
    { key: "localization", label: "谱线亚像素定位", standardUncertaintyUm: uLocalizationUm, status: "已评定" },
    { key: "geometry", label: "几何拟合与 d–L 相关性", standardUncertaintyUm: uGeometryUm, status: "已评定" },
    { key: "wavelength", label: "汞灯参考波长（uλ=0.01 nm）", standardUncertaintyUm: uWavelengthUm, status: "已评定" },
    { key: "repeatability", label: "多张照片重复性", standardUncertaintyUm: uRepeatUm, status: uRepeatUm === null ? "未评定" : "已评定" },
  ];
  const ucUm = Math.sqrt(budget.reduce((sum, item) => sum + (item.standardUncertaintyUm ?? 0) ** 2, 0));
  const profileRelativeWidth = (profileHigh - profileLow) / Math.max(best.dNm, 1);
  const reasons: string[] = [];
  if (Math.abs(correlation) > .99999) reasons.push("d 与 L 高度相关");
  if (profileRelativeWidth > .2) reasons.push("剖面置信区间过宽");
  if (boundaryHit) reasons.push("拟合命中参数边界");
  const distortionNumerator = best.t.reduce((sum, t, index) => sum + t * t * best.residualPx[index], 0);
  const distortionDenominator = best.t.reduce((sum, t) => sum + t ** 4, 0);
  const lensBiasPx = distortionDenominator > 0 ? distortionNumerator / distortionDenominator : 0;
  if (Math.abs(lensBiasPx) * Math.max(...best.t.map((t) => t * t)) > 1.5) reasons.push("残差显示可能存在镜头畸变");
  const reportable = reasons.length === 0 && Number.isFinite(ucUm);
  return {
    dUm: best.dNm / 1000,
    uncertaintyUm: 2 * ucUm,
    standardUncertaintyUm: ucUm,
    expandedUncertaintyUm: 2 * ucUm,
    coverageFactor: 2,
    uncertaintyLabel: repeats.length > 1 ? "多图像扩展不确定度" : "基于单次图像的扩展不确定度",
    uncertaintyBudget: budget,
    linesPerMm: 1_000_000 / best.dNm,
    nominalDeviationPercent: ((best.dNm / 3333.333 - 1) * 100),
    rmseNm,
    rmsePx,
    x0: zeroX,
    L: best.L,
    lensBiasPx,
    reportable,
    blockReason: reasons.join("；"),
    identifiability: { correlation, profileLowUm: profileLow / 1000, profileHighUm: profileHigh / 1000, boundaryHit },
    points: valid.map((line, index) => ({
      wavelengthNm: line.wavelengthNm,
      thetaDeg: Math.abs(radToDeg(Math.atan((line.x - zeroX) / best.L))),
      sinTheta: predictedWavelengths[index] / best.dNm,
      residualNm: residualsNm[index],
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
