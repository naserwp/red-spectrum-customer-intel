import { NextResponse } from "next/server";
import { enrichMissingCustomerProfilesBatch } from "@/lib/customerEnrichmentBatch";
import { connectToDatabase } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; allCustomers?: boolean };
  const result = await enrichMissingCustomerProfilesBatch({ limit: body.limit ?? 100, offset: body.offset ?? 0, allCustomers: Boolean(body.allCustomers) });
  const payload = { ok: true, ...result, totalMs: Date.now() - started };
  if (process.env.NODE_ENV === "development") console.log(`[api] enrich-missing-profiles totalMs=${payload.totalMs} processed=${result.processed} updated=${result.updated}`);
  return NextResponse.json(payload);
}
