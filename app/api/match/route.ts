import { SPECTRAL_LIBRARY } from "@/lib/spectrometer";

export async function POST(request: Request) {
  const body = (await request.json()) as { peaks?: { x: number; family?: string; confidence?: number }[] };
  const peaks = (body.peaks ?? []).slice().sort((a, b) => a.x - b.x);
  const standard = SPECTRAL_LIBRARY.mercury;
  const matches = peaks.slice(0, standard.length).map((peak, index) => ({
    x: peak.x,
    wavelengthNm: standard[index].wavelengthNm,
    family: peak.family ?? standard[index].family,
    confidence: peak.confidence ?? .75,
    residualNm: 0,
  }));
  return Response.json({ matches, usableCount: matches.length, needsManualSelection: matches.length < 3 });
}
