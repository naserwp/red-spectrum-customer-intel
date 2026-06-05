import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { syncRecentStripeTransactions } from "@/lib/stripeSync";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { hours?: number; dryRun?: boolean };
  const result = await syncRecentStripeTransactions({
    hours: body.hours ?? 24,
    dryRun: body.dryRun === true,
  });
  return NextResponse.json(result, { status: result.success ? 200 : 400 });
}
