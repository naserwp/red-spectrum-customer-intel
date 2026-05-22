import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { computeFundingIntelligence } from "@/lib/fundingIntelligence";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; dryRun?: boolean };
  const limit = Math.min(50, Math.max(1, Number(body.limit ?? 50)));
  const offset = Math.max(0, Number(body.offset ?? 0));
  const dryRun = Boolean(body.dryRun);

  const customers = await Customer.find({}, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    paidTotal: 1,
    totalPaid: 1,
    lifetimeValue: 1,
    rankingPaidTotal: 1,
    attemptedTotal: 1,
    paidMonths: 1,
    paidOrderCount: 1,
    attemptedOrderCount: 1,
    activeSubscriptions: 1,
    isGatewayRecurring: 1,
    recurringAmount: 1,
    gatewayPaidCount: 1,
    failedPayments: 1,
    chargebacks: 1,
    riskLevel: 1,
    businessProfile: 1,
    creditProfile: 1,
    factiivProfile: 1,
    publicEnrichment: 1,
  }).sort({ updatedAt: -1 }).skip(offset).limit(limit).lean<LeanCustomer[]>();
  const rankingByEmail = new Map(
    (await CustomerRanking.find({ email: { $in: customers.map((customer) => customer.email).filter(Boolean) } }).lean<CustomerRankingDocument[]>())
      .map((ranking) => [ranking.email.toLowerCase(), ranking])
  );

  let updated = 0;
  for (const customer of customers) {
    const summary = computeFundingIntelligence(customer, rankingByEmail.get((customer.email ?? "").toLowerCase()) ?? null);
    if (dryRun) continue;
    await Customer.updateOne(
      { _id: customer._id },
      {
        $set: {
          "businessProfile.fundingReadinessScore": summary.estimatedFundingReadiness,
          "businessProfile.fundingReadinessTier": summary.fundingTier,
          "businessProfile.industry": customer.businessProfile?.industry || customer.publicEnrichment?.inferredIndustry || "",
          "businessProfile.naicsCode": customer.businessProfile?.naicsCode || customer.publicEnrichment?.naicsCode || "",
          "businessProfile.sicCode": customer.businessProfile?.sicCode || customer.publicEnrichment?.sicCode || "",
        },
      }
    ).exec();
    updated += 1;
  }

  return NextResponse.json({
    processed: customers.length,
    updated,
    hasMore: customers.length === limit,
    nextOffset: offset + customers.length,
    warnings: [],
    message: dryRun
      ? `Funding intelligence preview complete for ${customers.length} customers.`
      : `Funding intelligence rebuilt for ${updated} customers.`,
  });
}
