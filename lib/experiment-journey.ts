export type ExperimentJourney = {
  prelab: {
    source: "mercury";
    capturedLines: number;
    dUm: number | null;
    rmseNm: number | null;
  };
  capture: {
    imageCount: number;
    exposureOk: boolean;
    sharpnessOk: boolean;
    zeroX: number | null;
    peakCount: number;
  };
  identification: {
    matchedLines: number;
    yellowDoubletResolved: boolean;
  };
  inversion: {
    reportable: boolean;
    dUm: number | null;
    expandedUncertaintyUm: number | null;
    correlation: number | null;
    profileLowUm: number | null;
    profileHighUm: number | null;
    boundaryHit: boolean;
    blockReason: string;
  };
  archive: {
    synced: boolean;
    recordId: string | null;
    syncedAt: number | null;
  };
  updatedAt: number;
};

export const emptyJourney: ExperimentJourney = {
  prelab: { source: "mercury", capturedLines: 0, dUm: null, rmseNm: null },
  capture: { imageCount: 0, exposureOk: false, sharpnessOk: false, zeroX: null, peakCount: 0 },
  identification: { matchedLines: 0, yellowDoubletResolved: false },
  inversion: {
    reportable: false, dUm: null, expandedUncertaintyUm: null, correlation: null,
    profileLowUm: null, profileHighUm: null, boundaryHit: false, blockReason: "尚未完成反演",
  },
  archive: { synced: false, recordId: null, syncedAt: null },
  updatedAt: 0,
};

export function mergeJourney(value: unknown): ExperimentJourney {
  if (!value || typeof value !== "object") return structuredClone(emptyJourney);
  const input = value as Partial<ExperimentJourney>;
  return {
    prelab: { ...emptyJourney.prelab, ...(input.prelab ?? {}), source: "mercury" },
    capture: { ...emptyJourney.capture, ...(input.capture ?? {}) },
    identification: { ...emptyJourney.identification, ...(input.identification ?? {}) },
    inversion: { ...emptyJourney.inversion, ...(input.inversion ?? {}) },
    archive: { ...emptyJourney.archive, ...(input.archive ?? {}) },
    updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : 0,
  };
}
