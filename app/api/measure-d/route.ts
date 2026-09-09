import { measureGrating } from "@/lib/spectrometer";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { lines?: { wavelengthNm: number; thetaDeg: number }[] };
    return Response.json(measureGrating(body.lines ?? []));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "测量失败" }, { status: 400 });
  }
}
