import { NextResponse } from "next/server";
import { isDeclinedOrFailed, isRefundedOrChargeback, isSettledSuccessful } from "@/lib/authorizeNet";
import { extractBestBusinessContactFields } from "@/lib/customerContactFields";
import { normalizeStateCode } from "@/lib/customerBusinessResolver";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { calculateCustomerValueMetrics, type CustomerValueMetrics } from "@/lib/customerValue";
import { resolveFactiivScore } from "@/lib/factivScore";
import { connectToDatabase } from "@/lib/mongodb";
import { generateBusinessIndustryClassifications, type BusinessIndustryClassification, type BusinessIndustryInput } from "@/lib/openai";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";
import { computeVipTier } from "@/lib/fundingIntelligence";
import { isNmiDeclined, isNmiRefundOrChargeback, isNmiSuccessful } from "@/lib/nmiQuickPay";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { StripeTransaction, type StripeTransactionDocument } from "@/models/StripeTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

type LeanCustomer = CustomerDocument & { _id: unknown; createdAt?: Date | string; updatedAt?: Date | string };

type ExportRow = {
  customerId: string;
  customerName: string;
  email: string;
  businessName: string;
  businessNameSource: string;
  rawWooBillingCompany: string;
  rawCreditBusinessName: string;
  rawFactiivMatchedBusiness: string;
  rawFactiivSummaryBusinessName: string;
  phoneNumber: string;
  businessAddress: string;
  ein: string;
  state: string;
  city: string;
  businessIndustry: string;
  industryCode: string;
  industryCodeType: string;
  industryDescription: string;
  factiivProfileId: string;
  factiivScoreSourceField: string;
  rawFactiivPayload: unknown;
  factiivScore: number | string;
  factiivMatchedBusiness: string;
  factiivMatchedEmail: string;
  factiivMatchedOwner: string;
  factiivMatchedBy: string;
  factiivAutoPersist: string;
  factiivLastSync: string;
  factiivReputationScore: number | string;
  factiivHistoryScore: number | string;
  factiivUtilizationScore: number | string;
  factiivActivityQuantity: number | string;
  factiivPaymentActivityTotal: number | string;
  factiivLastKnownBalance: number | string;
  factiivFundingTier: string;
  factiivTradeLines: number | string;
  factiivTotalTradeAmount: number | string;
  factiivOutstandingBalance: number | string;
  factiivVerifiedCreditLimit: number | string;
  factiivVipTier: string;
  factiivMRR: number | string;
  totalAmountPaid: number;
  totalValueOfThisCustomer: number;
  lifetimeValue: number;
  wooCommerceTotal: number;
  authorizeNetTotal: number;
  nmiTotal: number;
  stripeTotal: number;
  gatewayOnlyTotal: number;
  successfulPaymentCount: number;
  lastPaidDate: string;
  fundingScore: number | string;
  fundingCategory: string;
  recommendedFundingProducts: string;
  dataConfidenceStatus: string;
  factiivDebugSourcesChecked?: string[];
  factiivDebugMatchedSource?: string;
  factiivDebugReason?: string;
  factiivScoreResolvedFrom?: string;
  factiivProfileExists?: boolean;
  factiivPayloadExists?: boolean;
  factiivScoreCandidates?: Array<{ path: string; value: number }>;
};

const exportColumns: Array<keyof ExportRow> = [
  "customerId",
  "customerName",
  "email",
  "businessName",
  "businessNameSource",
  "rawWooBillingCompany",
  "rawCreditBusinessName",
  "rawFactiivMatchedBusiness",
  "rawFactiivSummaryBusinessName",
  "phoneNumber",
  "businessAddress",
  "ein",
  "state",
  "city",
  "businessIndustry",
  "industryCode",
  "industryCodeType",
  "industryDescription",
  "factiivProfileId",
  "factiivScoreSourceField",
  "rawFactiivPayload",
  "factiivScore",
  "factiivMatchedBusiness",
  "factiivMatchedEmail",
  "factiivMatchedOwner",
  "factiivMatchedBy",
  "factiivAutoPersist",
  "factiivLastSync",
  "factiivReputationScore",
  "factiivHistoryScore",
  "factiivUtilizationScore",
  "factiivActivityQuantity",
  "factiivPaymentActivityTotal",
  "factiivLastKnownBalance",
  "factiivFundingTier",
  "factiivTradeLines",
  "factiivTotalTradeAmount",
  "factiivOutstandingBalance",
  "factiivVerifiedCreditLimit",
  "factiivVipTier",
  "factiivMRR",
  "totalAmountPaid",
  "totalValueOfThisCustomer",
  "lifetimeValue",
  "wooCommerceTotal",
  "authorizeNetTotal",
  "nmiTotal",
  "stripeTotal",
  "gatewayOnlyTotal",
  "successfulPaymentCount",
  "lastPaidDate",
  "fundingScore",
  "fundingCategory",
  "recommendedFundingProducts",
  "dataConfidenceStatus",
];

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function missing(value: unknown) {
  const result = text(value);
  return result || "Missing";
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function positiveMoney(value: unknown) {
  const parsed = money(value);
  return parsed > 0 ? parsed : "Missing";
}

function dateOnly(value: unknown) {
  const raw = text(value);
  if (!raw) return "Missing";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "Missing" : parsed.toISOString().slice(0, 10);
}

function arrayText(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean).join("; ") : text(value);
}

function readPath(source: unknown, path: string[]) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function website(customer: LeanCustomer) {
  return text(customer.businessProfile?.website || customer.publicEnrichment?.publicBusinessWebsite || customer.publicEnrichment?.websiteDomain);
}

function customerSortTime(customer: LeanCustomer) {
  const raw = customer.lastSyncedAt || customer.updatedAt || customer.createdAt || "";
  const parsed = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function chooseCanonicalCustomer(customers: LeanCustomer[]) {
  return [...customers].sort((a, b) => {
    const orderDiff = Number((b.orders ?? []).length > 0) - Number((a.orders ?? []).length > 0);
    if (orderDiff !== 0) return orderDiff;
    const factiivDiff = Number(Boolean(b.factiivProfile?.factiivMatched || b.factiivProfile?.factiivProfileId)) - Number(Boolean(a.factiivProfile?.factiivMatched || a.factiivProfile?.factiivProfileId));
    if (factiivDiff !== 0) return factiivDiff;
    return customerSortTime(b) - customerSortTime(a);
  })[0];
}

function creditMetaVerified(customer: LeanCustomer) {
  return Boolean(customer.creditProfile?.verified && customer.creditProfile?.source === "wc_cs_credits");
}

function approvedCredits(customer: LeanCustomer) {
  return creditMetaVerified(customer) ? money(customer.creditProfile?.approvedCredits ?? customer.businessProfile?.approvedCredits ?? customer.businessProfile?.creditLimit ?? 0) : 0;
}

function extractFactiivExportFields(customer: LeanCustomer, ranking?: CustomerRankingDocument | null, detailMrr = 0) {
  const profile = customer.factiivProfile ?? {};
  const score = resolveFactiivScore(profile);
  const rankingScore = money(ranking?.factiivScore);
  const exportedScore = score.exportValue === "Missing" && rankingScore > 0 ? rankingScore : score.exportValue;
  const profileId = score.factiivProfileId || ranking?.factiivProfileId || "";
  const sourcesChecked = [
    "customer detail API canonical customer.factiivProfile",
    "customer.businessProfile funding/readiness fields",
    "customer.factiivProfile/factivProfile fields",
    "customer ranking cached funding fields",
    "customer ranking cached Factiiv fields",
    "attached/matched Factiiv payload",
    "recursive Factiiv score fallback",
  ];
  const matchedSource = score.scoreFieldFound || (rankingScore > 0 ? "customerRanking.factiivScore" : score.factiivProfileFound ? "customer.factiivProfile without score" : "no stored Factiiv profile");
  const verifiedCreditLimit = approvedCredits(customer);
  const mrr = money(detailMrr || ranking?.estimatedMRR || customer.recurringAmount);
  const totalPaid = money(ranking?.lifetimeSpent ?? customer.lifetimeValue ?? customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid);
  return {
    factiivScore: exportedScore === "Missing" ? "Missing" : money(exportedScore),
    factiivScoreSourceField: score.scoreFieldFound || (rankingScore > 0 ? "customerRanking.factiivScore" : "Missing"),
    factiivProfileId: missing(profileId),
    factiivMatchedBusiness: missing(profile.matchedBusinessName || ranking?.factiivMatchedBusiness),
    factiivMatchedEmail: missing(profile.matchedEmail || ranking?.factiivMatchedEmail),
    factiivMatchedOwner: missing(profile.matchedUsername),
    factiivMatchedBy: missing(profile.matchedBy),
    factiivAutoPersist: profile.autoPersisted ? `yes${profile.autoPersistReason ? ` (${profile.autoPersistReason})` : ""}` : "no",
    factiivLastSync: dateOnly(profile.lastFactiivSync || ranking?.factiivLastSync),
    factiivReputationScore: positiveMoney(profile.reputationScore || ranking?.factiivReputationScore),
    factiivHistoryScore: positiveMoney(profile.historyScore || ranking?.factiivHistoryScore),
    factiivUtilizationScore: positiveMoney(profile.utilizationScore || ranking?.factiivUtilizationScore),
    factiivActivityQuantity: positiveMoney(profile.activityQuantity),
    factiivPaymentActivityTotal: positiveMoney(profile.activityPaymentAmountTotal),
    factiivLastKnownBalance: positiveMoney(profile.activityLastKnownBalanceTotal),
    factiivFundingTier: missing(customer.businessProfile?.fundingReadinessTier || customer.businessProfile?.fundingCategory || ranking?.fundingCategory),
    factiivTradeLines: positiveMoney(profile.tradeQuantity || ranking?.factiivTradeLines),
    factiivTotalTradeAmount: positiveMoney(profile.tradeAmountTotal || ranking?.factiivTotalTradeAmount),
    factiivOutstandingBalance: positiveMoney(profile.tradeBalanceTotal || profile.activityLastKnownBalanceTotal || ranking?.factiivOutstandingBalance || customer.creditProfile?.outstandingBalance || customer.businessProfile?.outstandingBalance),
    factiivVerifiedCreditLimit: verifiedCreditLimit > 0 ? verifiedCreditLimit : positiveMoney(ranking?.factiivVerifiedCreditLimit),
    factiivVipTier: computeVipTier(totalPaid),
    factiivMRR: mrr > 0 ? mrr : "Missing",
    rawFactiivPayload: score.rawFactiivPayload,
    factiivDebugSourcesChecked: sourcesChecked,
    factiivDebugMatchedSource: matchedSource,
    factiivDebugReason: score.failureReason || `Resolved from ${matchedSource}`,
    factiivScoreResolvedFrom: score.scoreFieldFound || (rankingScore > 0 ? "customerRanking.factiivScore" : "Missing"),
    factiivProfileExists: score.factiivProfileFound,
    factiivPayloadExists: Boolean(score.rawFactiivPayload),
    factiivScoreCandidates: score.scoreCandidates,
  };
}

function storedIndustryClassification(customer: LeanCustomer): BusinessIndustryClassification {
  const profile = customer.businessProfile ?? {};
  const publicProfile = customer.publicEnrichment ?? {};
  const industry = text(profile.industry || publicProfile.inferredIndustry);
  const naics = text(profile.naicsCode || publicProfile.naicsCode);
  const sic = text(profile.sicCode || publicProfile.sicCode);
  return {
    businessIndustry: industry || "Missing",
    industryCode: naics || sic || "Missing",
    industryCodeType: naics ? "NAICS" : sic ? "SIC" : "NAICS",
    industryDescription: industry ? "Stored customer profile industry." : "Needs manual review",
    confidence: industry || naics || sic ? "medium" : "low",
  };
}

function auditBadge(metrics: CustomerValueMetrics, auth: AuthorizeNetTransactionDocument[], nmi: NmiQuickPayTransactionDocument[], stripe: StripeTransactionDocument[]) {
  if (metrics.rankingTotal <= 0) return "No Paid History";
  if (!auth.length && !nmi.length && !stripe.length && metrics.gatewayOnlyPaidTotal <= 0) return "Missing Gateway History";
  if (metrics.duplicateSkipped > 0) return "Possible Duplicate";
  if (metrics.refundsAndChargebacksDetected) return "Needs Review";
  return "Verified";
}

function successfulPaymentCount(customer: LeanCustomer, woo: WooCommerceOrderDocument[], auth: AuthorizeNetTransactionDocument[], nmi: NmiQuickPayTransactionDocument[], stripe: StripeTransactionDocument[]) {
  const orderNumbers = new Set([
    ...woo.map((order) => order.orderNumber).filter(Boolean),
    ...(customer.orders ?? []).map((order) => order.orderNumber).filter(Boolean),
  ]);
  const uniquePayments = new Set<string>();
  woo.filter((order) => order.isPaid).forEach((order) => uniquePayments.add(`woo:${order.orderNumber || order.transactionId || order.wooOrderId}`));
  (customer.orders ?? []).filter((order) => order.isPaid).forEach((order) => uniquePayments.add(`woo:${order.orderNumber || order.transactionId || order.orderId}`));
  auth.filter((tx) => isSettledSuccessful(tx.transactionStatus)).forEach((tx) => {
    if (tx.wooOrderNumberMatched || tx.wooOrderIdMatched || orderNumbers.has(tx.invoiceNumber)) return;
    uniquePayments.add(`auth:${tx.transactionId}`);
  });
  nmi.filter((tx) => isNmiSuccessful(tx.transactionStatus)).forEach((tx) => {
    if (tx.wooOrderNumberMatched || tx.wooOrderIdMatched || orderNumbers.has(tx.invoiceNumber)) return;
    uniquePayments.add(`nmi:${tx.transactionId}`);
  });
  stripe.filter((tx) => /succeeded|paid|settled|captured/i.test(tx.status ?? "")).forEach((tx) => {
    if (tx.wooOrderNumberMatched || tx.wooOrderIdMatched || orderNumbers.has(tx.invoiceNumber)) return;
    uniquePayments.add(`stripe:${tx.transactionId || tx.chargeId}`);
  });
  return uniquePayments.size;
}

function csvEscape(value: unknown) {
  const raw = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll("\"", "\"\"")}"` : raw;
}

function toCsv(rows: ExportRow[]) {
  const header = exportColumns.join(",");
  const body = rows.map((row) => exportColumns.map((column) => csvEscape(row[column])).join(",")).join("\r\n");
  return `\uFEFF${header}\r\n${body}\r\n`;
}

function chunk<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function failedAuth(tx: Partial<AuthorizeNetTransactionDocument>) {
  return isDeclinedOrFailed(tx.transactionStatus ?? "");
}

function failedNmi(tx: Partial<NmiQuickPayTransactionDocument>) {
  return isNmiDeclined(tx.transactionStatus ?? "");
}

export async function GET(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") === "csv" ? "csv" : "json";
  const limitParam = searchParams.get("limit");
  const limit = limitParam === "all" ? 10000 : Math.min(10000, Math.max(1, Number(limitParam ?? 110)));
  const useAIIndustry = searchParams.get("useAIIndustry") !== "false";
  const debugFactiiv = searchParams.get("debugFactiiv") === "true";
  const state = normalizeStateCode(searchParams.get("state")) || "";
  const stateParam = state || "all";
  const search = text(searchParams.get("search")).toLowerCase();
  const candidateLimit = limit >= 10000 || state || search ? 10000 : limit;

  const rankings = await CustomerRanking.find({}).sort({ lifetimeSpent: -1 }).limit(candidateLimit).lean<CustomerRankingDocument[]>();
  const fallbackCustomers = rankings.length ? [] : await Customer.find({}, {
      name: 1, email: 1, normalizedEmail: 1, phone: 1, businessProfile: 1, profile: 1, publicEnrichment: 1, factiivProfile: 1, creditProfile: 1,
      lifetimeValue: 1, rankingPaidTotal: 1, paidTotal: 1, totalPaid: 1, paidOrderCount: 1, orders: 1, gatewayPayments: 1, lastPaidDate: 1,
      wooPaidTotal: 1, authorizeNetPaidTotal: 1, nmiQuickPayPaidTotal: 1, gatewayOnlyPaidTotal: 1,
    }).limit(candidateLimit).lean<LeanCustomer[]>();

  const rankingByCustomerId = new Map(rankings.map((ranking) => [ranking.customerId, ranking]));
  const rankingByEmail = new Map(rankings.map((ranking) => [normalizeEmail(ranking.email), ranking]));
  const customerIds = rankings.length ? rankings.map((ranking) => ranking.customerId).filter(Boolean) : [];
  const rankingEmails = rankings.map((ranking) => normalizeEmail(ranking.email)).filter(Boolean);
  const rankedCustomerCandidates = customerIds.length || rankingEmails.length
    ? await Customer.find({ $or: [{ _id: { $in: customerIds } }, { normalizedEmail: { $in: rankingEmails } }, { emailNormalized: { $in: rankingEmails } }, { email: { $in: rankings.map((ranking) => ranking.email).filter(Boolean) } }] }, {
      name: 1, email: 1, normalizedEmail: 1, phone: 1, businessProfile: 1, profile: 1, publicEnrichment: 1, factiivProfile: 1, creditProfile: 1,
      lifetimeValue: 1, rankingPaidTotal: 1, paidTotal: 1, totalPaid: 1, paidOrderCount: 1, orders: 1, gatewayPayments: 1, lastPaidDate: 1,
      wooPaidTotal: 1, authorizeNetPaidTotal: 1, nmiQuickPayPaidTotal: 1, gatewayOnlyPaidTotal: 1, recurringAmount: 1, isGatewayRecurring: 1,
      lastSyncedAt: 1, updatedAt: 1, createdAt: 1,
    }).lean<LeanCustomer[]>()
    : [];
  const candidatesByEmail = new Map<string, LeanCustomer[]>();
  for (const customer of rankedCustomerCandidates) {
    const email = normalizeEmail(customer.normalizedEmail || customer.email);
    if (!email) continue;
    candidatesByEmail.set(email, [...(candidatesByEmail.get(email) ?? []), customer]);
  }
  const canonicalRankedCustomers = rankings.map((ranking) => {
    const email = normalizeEmail(ranking.email);
    const byEmail = email ? candidatesByEmail.get(email) ?? [] : [];
    const direct = rankedCustomerCandidates.find((customer) => String(customer._id) === ranking.customerId);
    const customer = chooseCanonicalCustomer([...byEmail, ...(direct ? [direct] : [])]);
    return customer ? { customer, ranking } : null;
  }).filter((row): row is { customer: LeanCustomer; ranking: CustomerRankingDocument } => Boolean(row));
  const customers = (canonicalRankedCustomers.length ? canonicalRankedCustomers : fallbackCustomers.map((customer) => ({ customer, ranking: rankingByCustomerId.get(String(customer._id)) ?? rankingByEmail.get(normalizeEmail(customer.email)) })))
    .map(({ customer, ranking }) => {
      const enrichment = enrichCustomerProfile(customer);
      return { customer, ranking, enrichment, preliminaryValue: money(ranking?.lifetimeSpent ?? customer.lifetimeValue ?? customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid) };
    })
    .filter((row) => !state || row.enrichment.stateCode === state || row.ranking?.stateCode === state)
    .filter((row) => {
      if (!search) return true;
      const haystack = [
        row.customer.email,
        row.customer.normalizedEmail,
        row.customer.name,
        row.customer.businessProfile?.businessName,
        row.customer.businessProfile?.company,
        row.customer.factiivProfile?.matchedBusinessName,
        row.ranking?.email,
        row.ranking?.name,
        row.ranking?.businessName,
      ].map((value) => text(value).toLowerCase()).join(" ");
      return haystack.includes(search);
    })
    .sort((a, b) => b.preliminaryValue - a.preliminaryValue)
    .slice(0, limit);

  const selectedCustomers = customers.map((row) => row.customer);
  const emails = Array.from(new Set(selectedCustomers.map((customer) => normalizeEmail(customer.normalizedEmail || customer.email)).filter(Boolean)));
  const ids = selectedCustomers.map((customer) => String(customer._id));
  const orderNumbers = Array.from(new Set(selectedCustomers.flatMap((customer) => (customer.orders ?? []).map((order) => order.orderNumber).filter(Boolean))));

  const [wooOrders, authTransactions, nmiTransactions, stripeTransactions, subscriptions] = await Promise.all([
    emails.length || orderNumbers.length ? WooCommerceOrderRecord.find({ $or: [{ normalizedEmail: { $in: emails } }, ...(orderNumbers.length ? [{ orderNumber: { $in: orderNumbers } }] : [])] }).lean<WooCommerceOrderDocument[]>() : [],
    emails.length || ids.length || orderNumbers.length ? AuthorizeNetTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { customerEmail: { $in: emails } }, { matchedCustomerId: { $in: ids } }, ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : [])] }).lean<AuthorizeNetTransactionDocument[]>() : [],
    emails.length || ids.length || orderNumbers.length ? NmiQuickPayTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { customerEmail: { $in: emails } }, { matchedCustomerId: { $in: ids } }, ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : [])] }).lean<NmiQuickPayTransactionDocument[]>() : [],
    emails.length || ids.length || orderNumbers.length ? StripeTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { email: { $in: emails } }, { matchedCustomerId: { $in: ids } }, ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : [])] }).lean<StripeTransactionDocument[]>() : [],
    emails.length ? WooCommerceSubscriptionRecord.find({ normalizedEmail: { $in: emails } }).lean<WooCommerceSubscriptionDocument[]>() : [],
  ]);

  const industryInputs: BusinessIndustryInput[] = customers.map(({ customer, ranking, enrichment }) => ({
    id: String(customer._id),
    businessName: enrichment.businessName || ranking?.businessName || customer.businessProfile?.businessName || customer.businessProfile?.company || "",
    website: website(customer),
    city: missing(customer.businessProfile?.city),
    state: enrichment.stateCode || ranking?.stateCode || "",
    businessProfile: {
      businessName: customer.businessProfile?.businessName,
      company: customer.businessProfile?.company,
      businessType: customer.businessProfile?.businessType,
      industry: customer.businessProfile?.industry,
      industryClassification: customer.businessProfile?.industryClassification,
      naicsCode: customer.businessProfile?.naicsCode,
      sicCode: customer.businessProfile?.sicCode,
      website: customer.businessProfile?.website,
    },
    customerProfile: {
      inferredIndustry: customer.publicEnrichment?.inferredIndustry,
      naicsCode: customer.publicEnrichment?.naicsCode,
      sicCode: customer.publicEnrichment?.sicCode,
      publicBusinessWebsite: customer.publicEnrichment?.publicBusinessWebsite,
      websiteDomain: customer.publicEnrichment?.websiteDomain,
      factiivMatchedBusinessName: customer.factiivProfile?.matchedBusinessName,
    },
  }));
  const industryById = useAIIndustry
    ? (await Promise.all(chunk(industryInputs, 20).map((batch) => generateBusinessIndustryClassifications(batch)))).reduce<Record<string, BusinessIndustryClassification>>((acc, batch) => ({ ...acc, ...batch }), {})
    : Object.fromEntries(customers.map(({ customer }) => [String(customer._id), storedIndustryClassification(customer)]));

  const rows = customers.map(({ customer, ranking, enrichment }) => {
    const customerEmail = normalizeEmail(customer.normalizedEmail || customer.email);
    const customerId = String(customer._id);
    const customerOrderNumbers = new Set((customer.orders ?? []).map((order) => order.orderNumber).filter(Boolean));
    const woo = wooOrders.filter((order) => normalizeEmail(order.normalizedEmail) === customerEmail || customerOrderNumbers.has(order.orderNumber));
    const auth = authTransactions.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.customerEmail].map(normalizeEmail).includes(customerEmail) || tx.matchedCustomerId === customerId || customerOrderNumbers.has(tx.invoiceNumber));
    const nmi = nmiTransactions.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.customerEmail].map(normalizeEmail).includes(customerEmail) || tx.matchedCustomerId === customerId || customerOrderNumbers.has(tx.invoiceNumber));
    const stripe = stripeTransactions.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.email].map(normalizeEmail).includes(customerEmail) || tx.matchedCustomerId === customerId || customerOrderNumbers.has(tx.invoiceNumber));
    const subs = subscriptions.filter((sub) => normalizeEmail(sub.normalizedEmail || sub.customerEmail) === customerEmail);
    const activeSubscriptionMrr = subs
      .filter((sub) => String(sub.status ?? "").toLowerCase() === "active")
      .reduce((sum, sub) => sum + money(readPath(sub, ["monthlyRecurringRevenue"]) ?? sub.amount), 0);
    const detailMrr = activeSubscriptionMrr + (customer.isGatewayRecurring ? money(customer.recurringAmount) : 0);
    const metrics = calculateCustomerValueMetrics({ customer, wooOrders: woo, authorizeNetTransactions: auth, nmiTransactions: nmi, stripeTransactions: stripe, subscriptions: subs });
    const contact = extractBestBusinessContactFields(customer, ranking, woo);
    const industry = industryById[customerId] ?? storedIndustryClassification(customer);
    const fundingScore = Number(customer.businessProfile?.fundingScore ?? ranking?.fundingScore ?? 0);
    const totalValue = money(metrics.rankingTotal || ranking?.lifetimeSpent || customer.lifetimeValue || customer.rankingPaidTotal || customer.paidTotal || customer.totalPaid);
    const chargebackOrRefund = auth.some((tx) => isRefundedOrChargeback(tx.transactionStatus) || failedAuth(tx)) || nmi.some((tx) => isNmiRefundOrChargeback(tx.transactionStatus) || failedNmi(tx)) || stripe.some((tx) => /refund|dispute|chargeback|failed/i.test(tx.status ?? ""));
    const dataConfidenceStatus = chargebackOrRefund ? "Needs Review" : auditBadge(metrics, auth, nmi, stripe);
    const factiiv = extractFactiivExportFields(customer, ranking, detailMrr);
    const debugFields = debugFactiiv ? {
      factiivDebugSourcesChecked: factiiv.factiivDebugSourcesChecked,
      factiivDebugMatchedSource: factiiv.factiivDebugMatchedSource,
      factiivDebugReason: factiiv.factiivDebugReason,
      factiivScoreResolvedFrom: factiiv.factiivScoreResolvedFrom,
      factiivProfileExists: factiiv.factiivProfileExists,
      factiivPayloadExists: factiiv.factiivPayloadExists,
      factiivScoreCandidates: factiiv.factiivScoreCandidates,
    } : {};
    return {
      customerId,
      customerName: missing(customer.name),
      email: missing(contact.email || customer.email),
      businessName: missing(contact.businessName || enrichment.businessName || ranking?.businessName || customer.businessProfile?.businessName || customer.businessProfile?.company),
      businessNameSource: missing(contact.businessNameSource),
      rawWooBillingCompany: missing(contact.rawWooBillingCompany),
      rawCreditBusinessName: missing(contact.rawCreditBusinessName),
      rawFactiivMatchedBusiness: missing(contact.rawFactiivMatchedBusiness),
      rawFactiivSummaryBusinessName: missing(contact.rawFactiivSummaryBusinessName),
      phoneNumber: missing(contact.phoneNumber || customer.phone || customer.businessProfile?.phone || customer.creditProfile?.phone),
      businessAddress: missing(contact.businessAddress),
      ein: missing(contact.ein || customer.businessProfile?.ein || customer.creditProfile?.ein),
      state: missing(contact.state || enrichment.stateCode || ranking?.stateCode || customer.businessProfile?.stateCode || customer.businessProfile?.state),
      city: missing(contact.city),
      businessIndustry: industry.businessIndustry,
      industryCode: industry.industryCode,
      industryCodeType: industry.industryCodeType,
      industryDescription: industry.industryDescription,
      factiivProfileId: factiiv.factiivProfileId,
      factiivScoreSourceField: factiiv.factiivScoreSourceField,
      rawFactiivPayload: factiiv.rawFactiivPayload,
      factiivScore: factiiv.factiivScore,
      factiivMatchedBusiness: factiiv.factiivMatchedBusiness,
      factiivMatchedEmail: factiiv.factiivMatchedEmail,
      factiivMatchedOwner: factiiv.factiivMatchedOwner,
      factiivMatchedBy: factiiv.factiivMatchedBy,
      factiivAutoPersist: factiiv.factiivAutoPersist,
      factiivLastSync: factiiv.factiivLastSync,
      factiivReputationScore: factiiv.factiivReputationScore,
      factiivHistoryScore: factiiv.factiivHistoryScore,
      factiivUtilizationScore: factiiv.factiivUtilizationScore,
      factiivActivityQuantity: factiiv.factiivActivityQuantity,
      factiivPaymentActivityTotal: factiiv.factiivPaymentActivityTotal,
      factiivLastKnownBalance: factiiv.factiivLastKnownBalance,
      factiivFundingTier: factiiv.factiivFundingTier,
      factiivTradeLines: factiiv.factiivTradeLines,
      factiivTotalTradeAmount: factiiv.factiivTotalTradeAmount,
      factiivOutstandingBalance: factiiv.factiivOutstandingBalance,
      factiivVerifiedCreditLimit: factiiv.factiivVerifiedCreditLimit,
      factiivVipTier: factiiv.factiivVipTier,
      factiivMRR: factiiv.factiivMRR,
      totalAmountPaid: totalValue,
      totalValueOfThisCustomer: totalValue,
      lifetimeValue: totalValue,
      wooCommerceTotal: money(metrics.wooPaidTotal),
      authorizeNetTotal: money(metrics.authorizeNetPaidTotal),
      nmiTotal: money(metrics.nmiQuickPayPaidTotal),
      stripeTotal: money(metrics.stripePaidTotal),
      gatewayOnlyTotal: money(metrics.gatewayOnlyPaidTotal),
      successfulPaymentCount: successfulPaymentCount(customer, woo, auth, nmi, stripe),
      lastPaidDate: dateOnly(metrics.lastPaidDate || ranking?.latestPaidDate || customer.lastPaidDate),
      fundingScore: fundingScore > 0 ? fundingScore : "Missing",
      fundingCategory: missing(customer.businessProfile?.fundingCategory || ranking?.fundingCategory),
      recommendedFundingProducts: missing(arrayText(customer.businessProfile?.recommendedFundingProducts) || arrayText(ranking?.recommendedFundingProducts)),
      dataConfidenceStatus,
      ...debugFields,
    } satisfies ExportRow;
  }).sort((a, b) => b.totalAmountPaid - a.totalAmountPaid);

  if (format === "csv") {
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="top-${limit}-customers.csv"`,
      },
    });
  }

  return NextResponse.json({
    success: true,
    total: rows.length,
    generatedAt: new Date().toISOString(),
    downloadCsvUrl: `/api/customers/export-top-110?format=csv&limit=${limit}&useAIIndustry=${useAIIndustry ? "true" : "false"}&state=${stateParam}`,
    customers: rows,
    totalMs: Date.now() - started,
  });
}
