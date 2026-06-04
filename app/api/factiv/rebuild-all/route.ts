import { NextResponse } from "next/server";
import { resolveFactiivScore } from "@/lib/factivScore";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument, type CustomerFactiivProfile } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

export const dynamic = "force-dynamic";

type LeanCustomer = CustomerDocument & {
  _id: unknown;
  rawFactiivPayload?: unknown;
  factiivPayload?: unknown;
  matchedFactiivProfile?: unknown;
  attachedFactiivProfile?: unknown;
};

type FactiivCoverage = {
  totalCustomers: number;
  customersWithFactiivProfile: number;
  customersWithFactiivScore: number;
  customersWithFactiivPayload: number;
  customersWithFactiivTradeLines: number;
  customersShowingFactiivInCustomerDetail: number;
  customersExportingFactiivScore: number;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function positiveNumber(value: unknown) {
  const parsed = money(value);
  return parsed > 0 ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readCaseInsensitive(source: unknown, keys: string[]): unknown {
  const record = asRecord(source);
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key.toLowerCase())) return value;
  }
  for (const value of Object.values(record)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = readCaseInsensitive(value, keys);
    if (text(nested) || typeof nested === "number") return nested;
  }
  return "";
}

function rawSummaryValue(rawSummary: unknown, keys: string[]): string {
  const raw = text(rawSummary);
  if (!raw) return "";
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = raw.match(new RegExp(`${escaped}\\s*[:=]\\s*([^|,\\n\\r]+)`, "i"));
    if (match?.[1]) return match[1].trim().replace(/^"|"$/g, "");
  }
  return "";
}

function firstPositive(...values: unknown[]) {
  for (const value of values) {
    const parsed = positiveNumber(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const parsed = text(value);
    if (parsed) return parsed;
  }
  return "";
}

function hasStoredProfile(customer: LeanCustomer) {
  const score = resolveFactiivScore(customer.factiivProfile);
  return score.factiivProfileFound
    || Boolean(customer.factiivProfile?.factiivMatched)
    || Boolean(text(customer.factiivProfile?.factiivProfileId || customer.factiivProfile?.profileId))
    || Boolean(customer.factiivProfile?.trades?.length)
    || Boolean(text(customer.factiivProfile?.rawSummary));
}

function storedFactiivPayload(customer: LeanCustomer) {
  return customer.rawFactiivPayload
    || customer.factiivPayload
    || customer.matchedFactiivProfile
    || customer.attachedFactiivProfile
    || customer.factiivProfile?.report
    || customer.factiivProfile?.analytics
    || customer.factiivProfile?.funding
    || null;
}

function normalizeFactiivProfile(customer: LeanCustomer) {
  const existing = asRecord(customer.factiivProfile);
  const payload = asRecord(storedFactiivPayload(customer));
  const score = resolveFactiivScore(existing);
  const payloadScore = resolveFactiivScore(payload);
  const rawSummary = firstText(existing.rawSummary, payload.rawSummary);
  const resolvedScore = positiveNumber(score.scoreValue) || positiveNumber(payloadScore.scoreValue) || positiveNumber(rawSummaryValue(rawSummary, ["factiivScore", "factivScore", "score", "businessScore", "creditScore"]));
  const trades = Array.isArray(existing.trades) ? existing.trades : [];
  const activities = Array.isArray(existing.activities) ? existing.activities : [];
  const tradeQuantity = firstPositive(existing.tradeQuantity, trades.length, readCaseInsensitive(payload, ["tradequantity", "tradelines", "trade_lines"]), rawSummaryValue(rawSummary, ["tradeQuantity", "tradeLines", "trade_lines"]));
  const profileId = firstText(existing.factiivProfileId, existing.profileId, readCaseInsensitive(payload, ["factiivprofileid", "profileid", "id", "accountid"]));
  const matchedBusiness = firstText(existing.matchedBusinessName, readCaseInsensitive(payload, ["matchedbusinessname", "businessname", "business_name", "company"]), rawSummaryValue(rawSummary, ["matchedBusinessName", "businessName", "company"]));
  const matchedEmail = firstText(existing.matchedEmail, readCaseInsensitive(payload, ["matchedemail", "email", "user_email"]), rawSummaryValue(rawSummary, ["matchedEmail", "email"]));
  const profile: Partial<CustomerFactiivProfile> = {
    profileId: firstText(existing.profileId, profileId),
    factiivProfileId: profileId,
    score: firstPositive(existing.score, readCaseInsensitive(payload, ["score"]), resolvedScore),
    businessScore: firstPositive(existing.businessScore, readCaseInsensitive(payload, ["businessscore", "business_score"])),
    creditScore: firstPositive(existing.creditScore, readCaseInsensitive(payload, ["creditscore", "credit_score"])),
    factiivScore: resolvedScore,
    reputationScore: firstPositive(existing.reputationScore, readCaseInsensitive(payload, ["reputationscore", "reputation_score"]), rawSummaryValue(rawSummary, ["reputationScore"])),
    historyScore: firstPositive(existing.historyScore, readCaseInsensitive(payload, ["historyscore", "history_score"]), rawSummaryValue(rawSummary, ["historyScore"])),
    utilizationScore: firstPositive(existing.utilizationScore, readCaseInsensitive(payload, ["utilizationscore", "utilization_score"]), rawSummaryValue(rawSummary, ["utilizationScore"])),
    tradeQuantity,
    tradeAmountTotal: firstPositive(existing.tradeAmountTotal, readCaseInsensitive(payload, ["tradeamounttotal", "tradetotal", "trade_amount_total"]), rawSummaryValue(rawSummary, ["tradeAmountTotal", "totalTradeAmount"])),
    tradeBalanceTotal: firstPositive(existing.tradeBalanceTotal, readCaseInsensitive(payload, ["tradebalancetotal", "outstandingbalance", "trade_balance_total"]), rawSummaryValue(rawSummary, ["tradeBalanceTotal", "outstandingBalance"])),
    activityQuantity: firstPositive(existing.activityQuantity, readCaseInsensitive(payload, ["activityquantity", "paymentactivitycount", "activity_count"]), rawSummaryValue(rawSummary, ["activityQuantity"])),
    activityPaymentAmountTotal: firstPositive(existing.activityPaymentAmountTotal, readCaseInsensitive(payload, ["activitypaymentamounttotal", "paymentamounttotal", "payment_activity_total"]), rawSummaryValue(rawSummary, ["activityPaymentAmountTotal", "paymentActivityTotal"])),
    activityLastKnownBalanceTotal: firstPositive(existing.activityLastKnownBalanceTotal, readCaseInsensitive(payload, ["activitylastknownbalancetotal", "lastknownbalancetotal", "last_balance_total"]), rawSummaryValue(rawSummary, ["activityLastKnownBalanceTotal", "lastKnownBalance"])),
    matchedBusinessName: matchedBusiness,
    matchedEmail,
    matchedUsername: firstText(existing.matchedUsername, readCaseInsensitive(payload, ["matchedusername", "username", "ownername"]), rawSummaryValue(rawSummary, ["matchedUsername", "username"])),
    factiivMatched: Boolean(existing.factiivMatched || profileId || resolvedScore || matchedBusiness || matchedEmail),
    factiivMatchConfidence: firstText(existing.factiivMatchConfidence, profileId || matchedEmail ? "high" : resolvedScore ? "medium" : ""),
    matchedBy: firstText(existing.matchedBy, "stored_payload_rebuild"),
    autoPersisted: Boolean(existing.autoPersisted),
    autoPersistReason: firstText(existing.autoPersistReason),
    factiivSearchQuery: firstText(existing.factiivSearchQuery, matchedEmail, matchedBusiness),
    factiivMatchReason: firstText(existing.factiivMatchReason, "stored_payload_rebuild"),
    lastFactiivSync: firstText(existing.lastFactiivSync, new Date().toISOString()),
    manualAttachedBy: firstText(existing.manualAttachedBy),
    manualAttachedAt: firstText(existing.manualAttachedAt),
    trades,
    activities,
    source: firstText(existing.source, "stored_payload_rebuild"),
    rawSummary,
  };
  return { profile, scoreBefore: score, scoreAfter: resolveFactiivScore(profile), payload };
}

function coverage(customers: LeanCustomer[], rankingsByCustomerId: Map<string, CustomerRankingDocument>): FactiivCoverage {
  let customersWithFactiivProfile = 0;
  let customersWithFactiivScore = 0;
  let customersWithFactiivPayload = 0;
  let customersWithFactiivTradeLines = 0;
  let customersShowingFactiivInCustomerDetail = 0;
  let customersExportingFactiivScore = 0;

  for (const customer of customers) {
    const profile = customer.factiivProfile ?? {};
    const score = resolveFactiivScore(profile);
    const ranking = rankingsByCustomerId.get(String(customer._id));
    if (hasStoredProfile(customer)) customersWithFactiivProfile += 1;
    if (score.exportValue !== "Missing") customersWithFactiivScore += 1;
    if (storedFactiivPayload(customer) || text(profile.rawSummary)) customersWithFactiivPayload += 1;
    if (Number(profile.tradeQuantity ?? 0) > 0 || (profile.trades ?? []).length > 0) customersWithFactiivTradeLines += 1;
    if (profile.factiivMatched) customersShowingFactiivInCustomerDetail += 1;
    if (score.exportValue !== "Missing" || Number(ranking?.factiivScore ?? 0) > 0) customersExportingFactiivScore += 1;
  }

  return {
    totalCustomers: customers.length,
    customersWithFactiivProfile,
    customersWithFactiivScore,
    customersWithFactiivPayload,
    customersWithFactiivTradeLines,
    customersShowingFactiivInCustomerDetail,
    customersExportingFactiivScore,
  };
}

function mismatchRows(customers: LeanCustomer[], rankingsByCustomerId: Map<string, CustomerRankingDocument>) {
  return customers.flatMap((customer) => {
    const score = resolveFactiivScore(customer.factiivProfile);
    const ranking = rankingsByCustomerId.get(String(customer._id));
    const detailShows = Boolean(customer.factiivProfile?.factiivMatched);
    const exportShows = score.exportValue !== "Missing" || Number(ranking?.factiivScore ?? 0) > 0;
    if (detailShows === exportShows) return [];
    return [{
      customer: customer.name,
      email: customer.email,
      detailPageShowsFactiiv: detailShows,
      exportShowsFactiiv: exportShows,
      persistedProfile: hasStoredProfile(customer),
      persistedScore: score.exportValue,
      factiivProfileId: score.factiivProfileId || ranking?.factiivProfileId || "",
    }];
  }).slice(0, 50);
}

export async function POST() {
  const started = Date.now();
  await connectToDatabase();
  const customers = await Customer.find({}, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    businessProfile: 1,
    creditProfile: 1,
    factiivProfile: 1,
    sourceCoverage: 1,
    rawFactiivPayload: 1,
    factiivPayload: 1,
    matchedFactiivProfile: 1,
    attachedFactiivProfile: 1,
  }).lean<LeanCustomer[]>();
  const rankings = await CustomerRanking.find({}, { customerId: 1, email: 1, factiivScore: 1, factiivProfileId: 1 }).lean<CustomerRankingDocument[]>();
  const rankingByCustomerId = new Map(rankings.map((ranking) => [ranking.customerId, ranking]));
  const factiivCoverageBefore = coverage(customers, rankingByCustomerId);
  const mismatchesBefore = mismatchRows(customers, rankingByCustomerId);

  let profilesRecovered = 0;
  let scoresRecovered = 0;
  let rankingRecordsUpdated = 0;
  let customersUpdated = 0;

  for (const customer of customers) {
    if (!hasStoredProfile(customer) && !storedFactiivPayload(customer)) continue;
    const { profile, scoreBefore, scoreAfter } = normalizeFactiivProfile(customer);
    const hasUsefulProfile = Boolean(profile.factiivMatched || profile.factiivProfileId || profile.factiivScore || profile.tradeQuantity);
    if (!hasUsefulProfile) continue;

    const set: Record<string, unknown> = {
      factiivProfile: { ...(customer.factiivProfile ?? {}), ...profile },
      "sourceCoverage.lastFactiivMatchReason": profile.factiivMatchReason,
    };
    await Customer.updateOne({ _id: customer._id }, { $set: set }).exec();
    customersUpdated += 1;
    if (!scoreBefore.factiivProfileFound && scoreAfter.factiivProfileFound) profilesRecovered += 1;
    if (scoreBefore.exportValue === "Missing" && scoreAfter.exportValue !== "Missing") scoresRecovered += 1;

    const creditLimit = firstPositive(customer.creditProfile?.approvedCredits, customer.businessProfile?.approvedCredits, customer.businessProfile?.creditLimit);
    const rankingUpdate = await CustomerRanking.updateOne(
      { customerId: String(customer._id) },
      {
        $set: {
          factiivProfileId: profile.factiivProfileId || "",
          factiivScore: profile.factiivScore || 0,
          factiivReputationScore: profile.reputationScore || 0,
          factiivHistoryScore: profile.historyScore || 0,
          factiivUtilizationScore: profile.utilizationScore || 0,
          factiivTradeLines: profile.tradeQuantity || 0,
          factiivTotalTradeAmount: profile.tradeAmountTotal || 0,
          factiivOutstandingBalance: profile.tradeBalanceTotal || profile.activityLastKnownBalanceTotal || 0,
          factiivVerifiedCreditLimit: creditLimit,
          factiivMatchedBusiness: profile.matchedBusinessName || "",
          factiivMatchedEmail: profile.matchedEmail || "",
          factiivLastSync: profile.lastFactiivSync || "",
        },
      }
    ).exec();
    if (rankingUpdate.matchedCount) rankingRecordsUpdated += 1;
  }

  const refreshedCustomers = await Customer.find({}, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    businessProfile: 1,
    creditProfile: 1,
    factiivProfile: 1,
    rawFactiivPayload: 1,
    factiivPayload: 1,
    matchedFactiivProfile: 1,
    attachedFactiivProfile: 1,
  }).lean<LeanCustomer[]>();
  const refreshedRankings = await CustomerRanking.find({}, { customerId: 1, email: 1, factiivScore: 1, factiivProfileId: 1 }).lean<CustomerRankingDocument[]>();
  const refreshedRankingByCustomerId = new Map(refreshedRankings.map((ranking) => [ranking.customerId, ranking]));
  const factiivCoverageAfter = coverage(refreshedCustomers, refreshedRankingByCustomerId);
  const mismatchesAfter = mismatchRows(refreshedCustomers, refreshedRankingByCustomerId);

  return NextResponse.json({
    success: true,
    generatedAt: new Date().toISOString(),
    factiivCoverageBefore,
    factiivCoverageAfter,
    profilesRecovered,
    scoresRecovered,
    customersUpdated,
    rankingRecordsUpdated,
    mismatchesBefore,
    mismatchesAfter,
    totalMs: Date.now() - started,
  });
}
