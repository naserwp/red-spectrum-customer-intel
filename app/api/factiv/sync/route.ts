import { NextResponse } from "next/server";
import { syncFactiivProfile } from "@/lib/factiv";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; dryRun?: boolean };
  const limit = Math.min(25, Math.max(1, Number(body.limit ?? 25)));
  const offset = Math.max(0, Number(body.offset ?? 0));
  const dryRun = Boolean(body.dryRun);

  const customers = await Customer.find({}, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    phone: 1,
    paidTotal: 1,
    totalPaid: 1,
    paidOrderCount: 1,
    attemptedOrderCount: 1,
    activeSubscriptions: 1,
    isGatewayRecurring: 1,
    gatewayPaidCount: 1,
    failedPayments: 1,
    chargebacks: 1,
    businessProfile: 1,
    creditProfile: 1,
    factiivProfile: 1,
  }).sort({ "factiivProfile.lastFactiivSync": 1, updatedAt: -1 }).skip(offset).limit(limit).lean<LeanCustomer[]>();

  const warnings: string[] = [];
  let matched = 0;
  let updated = 0;

  for (const customer of customers) {
    const result = await syncFactiivProfile(customer);
    warnings.push(...result.warnings);
    if (result.profile.factiivMatched) matched += 1;
    if (dryRun) continue;
    await Customer.updateOne(
      { _id: customer._id },
      {
        $set: {
          factiivProfile: result.profile,
          "sourceCoverage.factiivSearchQuery": result.profile.factiivSearchQuery,
          "sourceCoverage.factiivMatchReason": result.profile.factiivMatchReason,
        },
      }
    ).exec();
    updated += 1;
  }

  return NextResponse.json({
    processed: customers.length,
    matched,
    updated,
    hasMore: customers.length === limit,
    nextOffset: offset + customers.length,
    warnings: warnings.filter(Boolean).slice(0, 20),
    message: dryRun
      ? `Factiiv test complete. ${matched} customers matched in this batch.`
      : `Factiiv sync updated ${updated} customers.`,
  });
}
