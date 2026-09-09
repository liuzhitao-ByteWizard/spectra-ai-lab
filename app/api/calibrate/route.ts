import { calibrateSpectrum } from "@/lib/spectrometer";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      references?: { x: number; wavelengthNm: number }[];
      gratingUm?: number;
      unknownX?: number;
      model?: "plane" | "curved";
    };
    const calibration = calibrateSpectrum(body.references ?? [], body.gratingUm ?? 3.333, body.model);
    return Response.json({
      L: calibration.L,
      x0: calibration.x0,
      rmseNm: calibration.rmseNm,
      model: calibration.model,
      unknownWavelengthNm: Number.isFinite(body.unknownX) ? calibration.predict(body.unknownX as number) : null,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "标定失败" }, { status: 400 });
  }
}
