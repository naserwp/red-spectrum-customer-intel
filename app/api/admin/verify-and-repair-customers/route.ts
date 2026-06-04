import { NextResponse } from "next/server";
import { verifyCustomer } from "@/lib/customerVerification";
import { searchFactiivProfiles, shouldAutoPersistFactiiv, type FactiivSearchResult } from "@/lib/factiv";
import { resolveFactiivScore } from "@/lib/factivScore";
import { computeFundingIntelligence } from "@/lib/fundingIntelligence";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument, type CustomerFactiivProfile } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text && text !== "Missing" && text !== "-" ? text : "";
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function buildQueries(customer: LeanCustomer) {
  return unique([
    normalizeEmail(customer.normalizedEmail || customer.email),
    clean(customer.businessProfile?.businessName || customer.businessProfile?.company),
    clean(customer.name),
    clean(customer.businessProfile?.ein || customer.creditProfile?.ein),
    clean(customer.phone || customer.businessProfile?.phone || customer.creditProfile?.phone),
  ]);
}

function isConservativeHighConfidence(result: FactiivSearchResult, customer: LeanCustomer) {
  if (result.matchConfidence !== "high") return false;
  if (!shouldAutoPersistFactiiv(result.selectedProfileData)) return false;
  const score = resolveFactiivScore(result.selectedProfileData);
  if (score.exportValue === "Missing") return false;
  const reason = String(result.matchReason ?? "");
  const customerEmail = normalizeEmail(customer.normalizedEmail || customer.email);
  const resultEmail = normalizeEmail(result.selectedProfileData.matchedEmail || result.email);
  const customerBusiness = clean(customer.businessProfile?.businessName || customer.businessProfile?.company).toLowerCase();
  const resultBusiness = clean(result.selectedProfileData.matchedBusinessName || result.businessName).toLowerCase();
  const customerPhoneTail = clean(customer.phone || customer.businessProfile?.phone || customer.creditProfile?.phone).replace(/\D/g, "").slice(-7);
  const summary = String(result.selectedProfileData.rawSummary ?? "").toLowerCase();
  const ein = clean(customer.businessProfile?.ein || customer.creditProfile?.ein).replace(/\D/g, "");
  const emailExact = Boolean(customerEmail && resultEmail && customerEmail === resultEmail);
  const businessExact = Boolean(customerBusiness && resultBusiness && customerBusiness === resultBusiness);
  const phoneTail = Boolean(customerPhoneTail && customerPhoneTail.length >= 7 && summary.replace(/\D/g, "").includes(customerPhoneTail));
  const einExact = Boolean(ein && ein.length >= 7 && summary.replace(/\D/g, "").includes(ein));
  const strongSignals = [emailExact, businessExact, phoneTail, einExact, reason.includes("business_exact"), reason.includes("phone_tail_match")].filter(Boolean).length;
  return emailExact || einExact || (businessExact && phoneTail) || strongSignals >= 2;
}

function buildProfile(result: FactiivSearchResult): CustomerFactiivProfile {
  const selectedScore = resolveFactiivScore(result.selectedProfileData);
  return {
    ...result.selectedProfileData,
    factiivProfileId: String(result.profileId),
    factiivScore: Number(selectedScore.scoreValue ?? result.selectedProfileData.factiivScore ?? 0),
    matchedBy: "auto",
    autoPersisted: true,
    autoPersistReason: result.matchReason || result.matchConfidence,
    lastFactiivSync: new Date().toISOString(),
  };
}

async function maybeAttachFactiiv(customer: LeanCustomer, ranking?: CustomerRankingDocument | null) {
  if (resolveFactiivScore(customer.factiivProfile).exportValue !== "Missing") return null;
  const shape = {
    ...customer,
    businessProfile: {
      ...(customer.businessProfile ?? {}),
      company: customer.businessProfile?.company || customer.businessProfile?.businessName || ranking?.businessName || "",
      businessName: customer.businessProfile?.businessName || customer.businessProfile?.company || ranking?.businessName || "",
    },
  };
  for (const query of buildQueries(customer)) {
    const results = await searchFactiivProfiles(query, shape as Partial<CustomerDocument>);
    const match = results.find((result) => isConservativeHighConfidence(result, customer));
    if (match) return buildProfile(match);
  }
  return null;
}

export async function POST(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { dryRun?: boolean; limit?: number; cursor?: string | null; includeFactiivSearch?: boolean };
  const dryRun = body.dryRun !== false;
  const limit = Math.min(500, Math.max(1, Number(body.limit ?? 250)));
  const cursor = clean(body.cursor);
  const includeFactiivSearch = body.includeFactiivSearch === true;
  const query = cursor ? { _id: { $gt: cursor } } : {};
  const customers = await Customer.find(query, {
    name: 1, email: 1, normalizedEmail: 1, phone: 1, businessProfile: 1, creditProfile: 1, factiivProfile: 1, publicEnrichment: 1,
    paidTotal: 1, totalPaid: 1, lifetimeValue: 1, rankingPaidTotal: 1, orders: 1, gatewayPayments: 1,
    subscriptionStatus: 1, activeSubscriptions: 1, isGatewayRecurring: 1, recurringAmount: 1, recurringNextEstimatedPayment: 1, recurringLastPayment: 1,
    attemptedTotal: 1, paidOrderCount: 1, paidMonths: 1, firstOrderDate: 1, firstSignupDate: 1, lastPaidDate: 1, recurringPaymentCount: 1,
    sourceCoverage: 1, riskLevel: 1, failedPayments: 1, chargebacks: 1,
  }).sort({ _id: 1 }).limit(limit).lean<LeanCustomer[]>();

  const emails = Array.from(new Set(customers.map((customer) => normalizeEmail(customer.normalizedEmail || customer.email)).filter(Boolean)));
  const ids = customers.map((customer) => String(customer._id));
  const duplicateEmails = emails.length ? await Customer.aggregate<{ _id: string; count: number }>([
    { $project: { emailKey: { $toLower: { $ifNull: ["$normalizedEmail", "$email"] } } } },
    { $match: { emailKey: { $in: emails } } },
    { $group: { _id: "$emailKey", count: { $sum: 1 } } },
  ]) : [];
  const duplicateEmailCounts = new Map(duplicateEmails.map((row) => [row._id, row.count]));

  const [rankings, wooOrders, authTxs, nmiTxs, subs] = await Promise.all([
    CustomerRanking.find({ $or: [{ customerId: { $in: ids } }, { email: { $in: emails } }] }).lean<CustomerRankingDocument[]>(),
    WooCommerceOrderRecord.find({ normalizedEmail: { $in: emails } }).lean<WooCommerceOrderDocument[]>(),
    AuthorizeNetTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { customerEmail: { $in: emails } }, { matchedCustomerId: { $in: ids } }] }).lean<AuthorizeNetTransactionDocument[]>(),
    NmiQuickPayTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { customerEmail: { $in: emails } }, { matchedCustomerId: { $in: ids } }] }).lean<NmiQuickPayTransactionDocument[]>(),
    WooCommerceSubscriptionRecord.find({ normalizedEmail: { $in: emails } }).lean<WooCommerceSubscriptionDocument[]>(),
  ]);
  const rankingById = new Map(rankings.map((ranking) => [ranking.customerId, ranking]));
  const rankingByEmail = new Map(rankings.map((ranking) => [normalizeEmail(ranking.email), ranking]));

  let repairable = 0;
  let repaired = 0;
  let needsReview = 0;
  let notRepairable = 0;
  let factiivAttached = 0;
  const sampleRepairable: unknown[] = [];
  const sampleNeedsReview: unknown[] = [];
  const sampleFactiivAttached: unknown[] = [];

  for (const customer of customers) {
    const email = normalizeEmail(customer.normalizedEmail || customer.email);
    const id = String(customer._id);
    const ranking = rankingById.get(id) || rankingByEmail.get(email);
    const customerWoo = wooOrders.filter((order) => normalizeEmail(order.normalizedEmail || order.billingEmail) === email);
    const customerAuth = authTxs.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.customerEmail].map(normalizeEmail).includes(email) || tx.matchedCustomerId === id);
    const customerNmi = nmiTxs.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.customerEmail].map(normalizeEmail).includes(email) || tx.matchedCustomerId === id);
    const customerSubs = subs.filter((sub) => normalizeEmail(sub.normalizedEmail || sub.customerEmail) === email);
    const result = verifyCustomer({
      customer,
      ranking,
      wooOrders: customerWoo,
      authorizeNetTransactions: customerAuth,
      nmiTransactions: customerNmi,
      subscriptions: customerSubs,
      duplicateEmailCount: duplicateEmailCounts.get(email) ?? 0,
    });
    const hasRepair = result.changedFields.length > 0 || Object.keys(result.rankingSet).length > 0;
    if (hasRepair) repairable += 1;
    else notRepairable += 1;
    if (result.reviewReasons.length) needsReview += 1;
    if (sampleRepairable.length < 20 && hasRepair) sampleRepairable.push({ customerId: id, email, status: result.verificationStatus, score: result.verificationScore, changedFields: result.changedFields, missingFields: result.missingFields });
    if (sampleNeedsReview.length < 20 && result.reviewReasons.length) sampleNeedsReview.push({ customerId: id, email, status: result.verificationStatus, score: result.verificationScore, reviewReasons: result.reviewReasons, missingFields: result.missingFields });

    let factiivProfile: CustomerFactiivProfile | null = null;
    if (includeFactiivSearch) factiivProfile = await maybeAttachFactiiv(customer, ranking);
    if (factiivProfile) {
      result.set.factiivProfile = factiivProfile;
      result.set["sourceCoverage.factiivMatchReason"] = factiivProfile.factiivMatchReason;
      result.set["sourceCoverage.lastFactiivMatchReason"] = factiivProfile.factiivMatchReason;
      result.rankingSet.factiivProfileId = factiivProfile.factiivProfileId;
      result.rankingSet.factiivScore = factiivProfile.factiivScore;
      result.rankingSet.factiivTradeLines = factiivProfile.tradeQuantity;
      result.rankingSet.factiivTotalTradeAmount = factiivProfile.tradeAmountTotal;
      result.rankingSet.factiivOutstandingBalance = factiivProfile.tradeBalanceTotal || factiivProfile.activityLastKnownBalanceTotal;
      result.rankingSet.factiivMatchedBusiness = factiivProfile.matchedBusinessName;
      result.rankingSet.factiivMatchedEmail = factiivProfile.matchedEmail;
      result.rankingSet.factiivLastSync = factiivProfile.lastFactiivSync;
      factiivAttached += 1;
      if (sampleFactiivAttached.length < 10) sampleFactiivAttached.push({ customerId: id, email, profileId: factiivProfile.factiivProfileId, score: factiivProfile.factiivScore, matchedBusiness: factiivProfile.matchedBusinessName, matchedEmail: factiivProfile.matchedEmail, reason: factiivProfile.factiivMatchReason });
    }

    if (!dryRun && (Object.keys(result.set).length || Object.keys(result.rankingSet).length)) {
      const set = { ...result.set };
      if (factiivProfile) {
        const refreshedFunding = computeFundingIntelligence({ ...customer, factiivProfile }, ranking);
        set["businessProfile.fundingReadinessScore"] = refreshedFunding.estimatedFundingReadiness;
        set["businessProfile.fundingReadinessTier"] = refreshedFunding.fundingTier;
        set["businessProfile.fundingScore"] = refreshedFunding.fundingScore;
        set["businessProfile.fundingCategory"] = refreshedFunding.fundingCategory;
        set["businessProfile.recommendedFundingProducts"] = refreshedFunding.recommendedFundingProducts;
        set["businessProfile.fundingStrengths"] = refreshedFunding.fundingStrengths;
        set["businessProfile.fundingWeaknesses"] = refreshedFunding.fundingWeaknesses;
        set["businessProfile.nextBestAction"] = refreshedFunding.nextBestAction;
        set["businessProfile.fundingScoreBreakdown"] = refreshedFunding.scoreBreakdown;
        result.rankingSet.fundingScore = refreshedFunding.fundingScore;
        result.rankingSet.fundingCategory = refreshedFunding.fundingCategory;
        result.rankingSet.recommendedFundingProducts = refreshedFunding.recommendedFundingProducts;
        result.rankingSet.fundingStrengths = refreshedFunding.fundingStrengths;
        result.rankingSet.fundingWeaknesses = refreshedFunding.fundingWeaknesses;
        result.rankingSet.nextBestAction = refreshedFunding.nextBestAction;
        result.rankingSet.fundingScoreBreakdown = refreshedFunding.scoreBreakdown;
      }
      await Customer.updateOne({ _id: customer._id }, { $set: set }).exec();
      await CustomerRanking.updateOne({ customerId: id }, { $set: result.rankingSet }, { upsert: false }).exec();
      repaired += 1;
    }
  }

  const nextCursor = customers.length ? String(customers[customers.length - 1]._id) : cursor;
  const hasMore = customers.length === limit && Boolean(await Customer.exists({ _id: { $gt: nextCursor } }));
  return NextResponse.json({
    success: true,
    dryRun,
    includeFactiivSearch,
    checked: customers.length,
    repairable,
    repaired,
    needsReview,
    notRepairable,
    factiivAttached,
    sampleRepairable,
    sampleNeedsReview,
    sampleFactiivAttached,
    cursor: nextCursor || null,
    hasMore,
    totalMs: Date.now() - started,
  });
}
