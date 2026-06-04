import { NextResponse } from "next/server";
import { normalizeStateCode } from "@/lib/customerBusinessResolver";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { resolveFactiivScore } from "@/lib/factivScore";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

export const dynamic = "force-dynamic";

type LeanCustomer = CustomerDocument & { _id: unknown };

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function hasText(value: unknown) {
  return Boolean(text(value));
}

function matchingFailureReason(customer: LeanCustomer) {
  const normalized = normalizeEmail(customer.normalizedEmail || customer.email);
  const storedEmail = normalizeEmail(customer.email);
  const matchedEmail = normalizeEmail(customer.factiivProfile?.matchedEmail);
  const reasons = [
    !normalized ? "missing_normalized_email" : "",
    normalized && storedEmail && normalized !== storedEmail ? "email_normalization_mismatch" : "",
    matchedEmail && normalized && matchedEmail !== normalized ? "factiiv_matched_email_differs" : "",
    customer.factiivProfile?.factiivMatchReason === "no_confident_match" ? "no_confident_match" : "",
    customer.factiivProfile?.factiivMatchReason === "no_match" ? "no_match" : "",
    customer.sourceCoverage?.lastFactiivSearchResultsCount && customer.sourceCoverage.lastFactiivSearchResultsCount > 1 ? "multiple_factiiv_search_results" : "",
    !customer.factiivProfile?.factiivMatched && hasText(customer.factiivProfile?.factiivProfileId) ? "profile_id_present_but_not_matched" : "",
  ].filter(Boolean);
  return reasons.join("; ");
}

export async function GET(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") ?? 110)));
  const state = normalizeStateCode(searchParams.get("state")) || "";

  const rankings = await CustomerRanking.find({}).sort({ lifetimeSpent: -1 }).limit(5000).lean<CustomerRankingDocument[]>();
  const rankingByCustomerId = new Map(rankings.map((ranking) => [ranking.customerId, ranking]));
  const customerIds = rankings.map((ranking) => ranking.customerId).filter(Boolean);
  const rankedCustomers = customerIds.length
    ? await Customer.find({ _id: { $in: customerIds } }, {
      name: 1, email: 1, normalizedEmail: 1, phone: 1, businessProfile: 1, factiivProfile: 1, publicEnrichment: 1, sourceCoverage: 1,
      lifetimeValue: 1, rankingPaidTotal: 1, paidTotal: 1, totalPaid: 1,
    }).lean<LeanCustomer[]>()
    : [];
  const fallbackCustomers = rankedCustomers.length ? [] : await Customer.find({}, {
    name: 1, email: 1, normalizedEmail: 1, phone: 1, businessProfile: 1, factiivProfile: 1, publicEnrichment: 1, sourceCoverage: 1,
    lifetimeValue: 1, rankingPaidTotal: 1, paidTotal: 1, totalPaid: 1,
  }).limit(5000).lean<LeanCustomer[]>();

  const candidates = (rankedCustomers.length ? rankedCustomers : fallbackCustomers)
    .map((customer) => {
      const ranking = rankingByCustomerId.get(String(customer._id));
      const enrichment = enrichCustomerProfile(customer);
      return {
        customer,
        ranking,
        enrichment,
        preliminaryValue: money(ranking?.lifetimeSpent ?? customer.lifetimeValue ?? customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid),
      };
    })
    .filter((row) => !state || row.enrichment.stateCode === state || row.ranking?.stateCode === state)
    .sort((a, b) => b.preliminaryValue - a.preliminaryValue)
    .slice(0, limit);

  const emails = candidates.map(({ customer }) => normalizeEmail(customer.email)).filter(Boolean);
  const duplicateEmailCounts = emails.reduce<Map<string, number>>((map, email) => map.set(email, (map.get(email) ?? 0) + 1), new Map());
  const duplicateEmails = Array.from(duplicateEmailCounts.entries()).filter(([, count]) => count > 1).map(([email]) => email);
  const duplicateStoredCustomers = duplicateEmails.length
    ? await Customer.aggregate<{ _id: string; count: number }>([
      { $match: { email: { $in: duplicateEmails } } },
      { $group: { _id: { $toLower: "$email" }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    : [];
  const duplicateStoredEmailSet = new Set(duplicateStoredCustomers.map((row) => row._id));

  const rows = candidates.map(({ customer, ranking, enrichment }) => {
    const score = resolveFactiivScore(customer.factiivProfile);
    const businessName = enrichment.businessName || ranking?.businessName || customer.businessProfile?.businessName || customer.businessProfile?.company || "";
    const failureReason = score.failureReason || matchingFailureReason(customer);
    const duplicateProfileSignal = Boolean(customer.sourceCoverage?.lastFactiivSearchResultsCount && customer.sourceCoverage.lastFactiivSearchResultsCount > 1);
    const matchingFailure = Boolean(matchingFailureReason(customer));
    console.log("[factiiv-score-audit]", customer.email, score.scoreFieldFound || "Missing", score.exportValue);
    return {
      customerId: String(customer._id),
      email: customer.email,
      normalizedEmail: normalizeEmail(customer.normalizedEmail || customer.email),
      businessName,
      factiivProfileFound: score.factiivProfileFound,
      factiivProfileId: score.factiivProfileId,
      scoreFieldFound: score.scoreFieldFound,
      scoreValue: score.scoreValue,
      exportValue: score.exportValue,
      failureReason,
      factiivScoreSourceField: score.scoreFieldFound,
      rawFactiivPayload: score.rawFactiivPayload,
      scoreCandidates: score.scoreCandidates,
      matchingDiagnostics: {
        matchedEmail: customer.factiivProfile?.matchedEmail || "",
        matchedBusinessName: customer.factiivProfile?.matchedBusinessName || "",
        factiivMatched: Boolean(customer.factiivProfile?.factiivMatched),
        factiivMatchConfidence: customer.factiivProfile?.factiivMatchConfidence || "",
        factiivMatchReason: customer.factiivProfile?.factiivMatchReason || customer.sourceCoverage?.lastFactiivMatchReason || "",
        lastFactiivSearchQueries: customer.sourceCoverage?.lastFactiivSearchQueries ?? [],
        lastFactiivSearchResultsCount: customer.sourceCoverage?.lastFactiivSearchResultsCount ?? 0,
        emailCaseOrWhitespaceNormalized: customer.email !== customer.email?.trim() || normalizeEmail(customer.email) !== String(customer.email ?? ""),
        duplicateCustomerEmail: duplicateStoredEmailSet.has(normalizeEmail(customer.email)),
        duplicateProfilesPossible: duplicateProfileSignal,
        matchingFailure,
      },
    };
  });

  const profileExistsButExportMissing = rows.filter((row) => row.factiivProfileFound && row.exportValue === "Missing");
  const report = {
    totalCustomersExported: rows.length,
    customersWithFactiivProfile: rows.filter((row) => row.factiivProfileFound).length,
    customersWithScore: rows.filter((row) => row.exportValue !== "Missing").length,
    customersMissingScore: rows.filter((row) => row.exportValue === "Missing").length,
    customersWithMatchingFailure: rows.filter((row) => row.matchingDiagnostics.matchingFailure).length,
    customersWithDuplicateProfiles: rows.filter((row) => row.matchingDiagnostics.duplicateProfilesPossible).length,
    customersWithDuplicateCustomerRecords: rows.filter((row) => row.matchingDiagnostics.duplicateCustomerEmail).length,
  };

  return NextResponse.json({
    success: true,
    generatedAt: new Date().toISOString(),
    scoreRetrievalFlow: [
      "lib/factiv.ts mapFactiivRecord maps Factiiv API records into customer.factiivProfile.",
      "app/api/factiv/sync persists auto matched profiles when shouldAutoPersistFactiiv returns true.",
      "app/api/factiv/search can auto-persist the best search result for a customer.",
      "app/api/factiv/attach-profile persists a manually selected Factiiv profile.",
      "app/api/customers/export-top-110 now resolves score through lib/factivScore.ts before exporting.",
    ],
    fallbackPriority: [
      "customer.factiivProfile.score",
      "customer.factiivProfile.businessScore",
      "customer.factiivProfile.creditScore",
      "customer.factiivProfile.report.score",
      "customer.factiivProfile.analytics.score",
      "customer.factiivProfile.funding.score",
      "customer.factiivProfile.factiivScore",
      "any nested numeric score field",
      "rawSummary score-like fields",
    ],
    report,
    rows,
    profileExistsButExportMissing,
    totalMs: Date.now() - started,
  });
}
