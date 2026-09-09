import { compareReadings } from "@/lib/spectrometer";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { rows?: { wavelengthNm: number; handDeg: number; aiDeg: number }[] };
    if (!body.rows?.length) throw new Error("缺少对照读数");
    return Response.json(compareReadings(body.rows));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "诊断失败" }, { status: 400 });
  }
}
