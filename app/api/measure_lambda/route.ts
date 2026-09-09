import { calibrateSpectrum } from "@/lib/spectrometer";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      references?: { x: number; wavelengthNm: number }[];
      unknownLines?: { x: number }[];
      dUm?: number;
      model?: "plane" | "curved";
    };
    const calibration = calibrateSpectrum(body.references ?? [], body.dUm ?? 3.333, body.model);
    return Response.json({
      lines: (body.unknownLines ?? []).map((line) => {
        const wavelengthNm = calibration.predict(line.x);
        const min = Math.min(...(body.references ?? []).map((item) => item.wavelengthNm));
        const max = Math.max(...(body.references ?? []).map((item) => item.wavelengthNm));
        return { x: line.x, wavelengthNm, uncertaintyNm: Math.max(.4, calibration.rmseNm), status: wavelengthNm >= min && wavelengthNm <= max ? "范围内" : "外推" };
      }),
      calibration: { L: calibration.L, x0: calibration.x0, rmseNm: calibration.rmseNm, model: calibration.model },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "波长测量失败" }, { status: 400 });
  }
}
