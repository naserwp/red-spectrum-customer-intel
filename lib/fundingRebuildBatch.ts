import { computeFundingIntelligence } from "@/lib/fundingIntelligence";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

export async function rebuildFundingIntelligenceBatch({ limit = 100, offset = 0, dryRun = false, email = "" }: { limit?: number; offset?: number; dryRun?: boolean; email?: string } = {}) {
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const normalizedEmail = email.trim().toLowerCase();
  const query = normalizedEmail ? { $or: [{ normalizedEmail }, { emailNormalized: normalizedEmail }, { email: normalizedEmail }] } : {};
  const customers = await Customer.find(query, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    customerCreatedAt: 1,
    firstOrderDate: 1,
    firstPaidDate: 1,
    lastSyncedAt: 1,
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
    actualCreditLimit: 1,
    businessProfile: 1,
    creditProfile: 1,
    factiivProfile: 1,
    publicEnrichment: 1,
  }).sort({ _id: 1 }).skip(normalizedEmail ? 0 : safeOffset).limit(normalizedEmail ? 1 : safeLimit).lean<LeanCustomer[]>();

  const rankingByEmail = new Map(
    (await CustomerRanking.find({ email: { $in: customers.map((customer) => customer.email).filter(Boolean) } }).lean<CustomerRankingDocument[]>())
      .map((ranking) => [ranking.email.toLowerCase(), ranking])
  );

  let updated = 0;
  const failed: Array<{ customerId: string; email: string; error: string }> = [];
  for (const customer of customers) {
    try {
      const email = String(customer.email ?? "").toLowerCase();
      const summary = computeFundingIntelligence(customer, rankingByEmail.get(email) ?? null);
      if (!dryRun) {
        const fundingSet = {
          "businessProfile.fundingReadinessScore": summary.estimatedFundingReadiness,
          "businessProfile.fundingReadinessTier": summary.fundingTier,
          "businessProfile.fundingScore": summary.fundingScore,
          "businessProfile.fundingCategory": summary.fundingCategory,
          "businessProfile.recommendedFundingProducts": summary.recommendedFundingProducts,
          "businessProfile.fundingStrengths": summary.fundingStrengths,
          "businessProfile.fundingWeaknesses": summary.fundingWeaknesses,
          "businessProfile.nextBestAction": summary.nextBestAction,
          "businessProfile.fundingSummary": summary.fundingSummary,
          "businessProfile.businessVerificationScore": summary.businessVerificationScore,
          "businessProfile.industryRiskScore": summary.industryRiskScore,
          "businessProfile.fundingScoreBreakdown": summary.scoreBreakdown,
          "sourceCoverage.lastFundingRebuildAt": new Date().toISOString(),
        };
        await Customer.updateOne({ _id: customer._id }, { $set: fundingSet }).exec();
        await CustomerRanking.updateOne(
          { customerId: String(customer._id) },
          {
            $set: {
              fundingScore: summary.fundingScore,
              fundingCategory: summary.fundingCategory,
              recommendedFundingProducts: summary.recommendedFundingProducts,
              fundingStrengths: summary.fundingStrengths,
              fundingWeaknesses: summary.fundingWeaknesses,
              nextBestAction: summary.nextBestAction,
              fundingScoreBreakdown: summary.scoreBreakdown,
            },
          }
        ).exec();
      }
      updated += 1;
    } catch (error) {
      failed.push({
        customerId: String(customer._id),
        email: String(customer.email ?? ""),
        error: error instanceof Error ? error.message : "Unknown funding rebuild error",
      });
    }
  }

  return {
    processed: customers.length,
    updated,
    failed: failed.length,
    failures: failed.slice(0, 20),
    hasMore: normalizedEmail ? false : customers.length === safeLimit,
    nextOffset: normalizedEmail ? customers.length : safeOffset + customers.length,
  };
}
