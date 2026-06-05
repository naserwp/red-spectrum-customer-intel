import { NextResponse } from "next/server";
import { runNmiBackfill, type NmiBackfillOptions } from "@/lib/nmiBackfill";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ error: "Method not allowed. Use POST to import NMI Quick Pay transactions." }, { status: 405 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as NmiBackfillOptions;
  return NextResponse.json(await runNmiBackfill(body));
}
