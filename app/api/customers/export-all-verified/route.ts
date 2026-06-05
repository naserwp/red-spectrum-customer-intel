import { NextResponse } from "next/server";
import { extractBestBusinessContactFields } from "@/lib/customerContactFields";
import { verificationStatusParam, verifyCustomer } from "@/lib/customerVerification";
import { calculateCustomerValueMetrics } from "@/lib/customerValue";
import { resolveFactiivScore } from "@/lib/factivScore";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument, type CustomerFactiivProfile } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { StripeTransaction, type StripeTransactionDocument } from "@/models/StripeTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

const columns = [
  "customerId", "customerName", "email", "businessName", "phoneNumber", "businessAddress", "ein", "state", "city", "zip", "country", "website",
  "businessIndustry", "industryCode", "industryCodeType", "industryDescription",
  "factiivProfileId", "factiivScore", "factiivMatchedBusiness", "factiivMatchedEmail", "factiivMatchedBy", "factiivLastSync", "factiivTradeLines", "factiivTotalTradeAmount", "factiivOutstandingBalance", "factiivVerifiedCreditLimit",
  "totalAmountPaid", "totalValueOfThisCustomer", "lifetimeValue", "wooCommerceTotal", "authorizeNetTotal", "nmiTotal", "stripeTotal", "gatewayOnlyTotal", "successfulPaymentCount", "lastPaidDate",
  "fundingScore", "fundingCategory", "recommendedFundingProducts", "dataConfidenceStatus",
  "verificationStatus", "verificationScore", "missingFields", "reviewReasons", "sourceConfidence", "lastVerifiedAt",
] as const;

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text && text !== "Missing" && text !== "-" ? text : "";
}

function missing(value: unknown) {
  return clean(value) || "Missing";
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function dateOnly(value: unknown) {
  const raw = clean(value);
  if (!raw) return "Missing";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "Missing" : parsed.toISOString().slice(0, 10);
}

function csvEscape(value: unknown) {
  const raw = value === undefined || value === null ? "" : Array.isArray(value) ? value.join("; ") : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll("\"", "\"\"")}"` : raw;
}

function toCsv(rows: Record<string, unknown>[]) {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")).join("\r\n");
  return `\uFEFF${header}\r\n${body}\r\n`;
}

function successfulPaymentCount(customer: LeanCustomer, woo: WooCommerceOrderDocument[], auth: AuthorizeNetTransactionDocument[], nmi: NmiQuickPayTransactionDocument[], stripe: StripeTransactionDocument[]) {
  const paidWoo = new Set(woo.filter((order) => order.isPaid).map((order) => order.transactionId || order.orderNumber || order.wooOrderId).filter(Boolean));
  const customerOrders = new Set((customer.orders ?? []).filter((order) => order.isPaid).map((order) => order.transactionId || order.orderNumber || order.orderId).filter(Boolean));
  const authPaid = auth.filter((tx) => /settled|captured|paid/i.test(tx.transactionStatus ?? "")).map((tx) => tx.transactionId).filter(Boolean);
  const nmiPaid = nmi.filter((tx) => /settled|approved|complete|paid/i.test(tx.transactionStatus ?? "")).map((tx) => tx.transactionId).filter(Boolean);
  const stripePaid = stripe.filter((tx) => /succeeded|paid|settled|captured/i.test(tx.status ?? "")).map((tx) => tx.transactionId || tx.chargeId).filter(Boolean);
  return new Set([...paidWoo, ...customerOrders, ...authPaid, ...nmiPaid, ...stripePaid]).size;
}

export async function GET(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") === "csv" ? "csv" : "json";
  const statusFilter = verificationStatusParam(searchParams.get("verificationStatus") ?? "all");
  const includeDebug = searchParams.get("includeDebug") === "true";
  const customers = await Customer.find({}, {
    name: 1, email: 1, normalizedEmail: 1, phone: 1, businessProfile: 1, creditProfile: 1, factiivProfile: 1, publicEnrichment: 1,
    paidTotal: 1, totalPaid: 1, lifetimeValue: 1, rankingPaidTotal: 1, orders: 1, gatewayPayments: 1, wooPaidTotal: 1, authorizeNetPaidTotal: 1, nmiQuickPayPaidTotal: 1, gatewayOnlyPaidTotal: 1,
    subscriptionStatus: 1, activeSubscriptions: 1, isGatewayRecurring: 1, recurringAmount: 1, recurringNextEstimatedPayment: 1, recurringLastPayment: 1,
    attemptedTotal: 1, paidOrderCount: 1, paidMonths: 1, firstOrderDate: 1, firstSignupDate: 1, lastPaidDate: 1, recurringPaymentCount: 1,
    sourceCoverage: 1, riskLevel: 1,
  }).sort({ lifetimeValue: -1 }).lean<LeanCustomer[]>();
  const emails = Array.from(new Set(customers.map((customer) => normalizeEmail(customer.normalizedEmail || customer.email)).filter(Boolean)));
  const ids = customers.map((customer) => String(customer._id));
  const [rankings, wooOrders, authTxs, nmiTxs, stripeTxs, subs, duplicateEmails] = await Promise.all([
    CustomerRanking.find({ $or: [{ customerId: { $in: ids } }, { email: { $in: emails } }] }).lean<CustomerRankingDocument[]>(),
    WooCommerceOrderRecord.find({ normalizedEmail: { $in: emails } }).lean<WooCommerceOrderDocument[]>(),
    AuthorizeNetTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { customerEmail: { $in: emails } }, { matchedCustomerId: { $in: ids } }] }).lean<AuthorizeNetTransactionDocument[]>(),
    NmiQuickPayTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { customerEmail: { $in: emails } }, { matchedCustomerId: { $in: ids } }] }).lean<NmiQuickPayTransactionDocument[]>(),
    StripeTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { email: { $in: emails } }, { matchedCustomerId: { $in: ids } }] }).lean<StripeTransactionDocument[]>(),
    WooCommerceSubscriptionRecord.find({ normalizedEmail: { $in: emails } }).lean<WooCommerceSubscriptionDocument[]>(),
    Customer.aggregate<{ _id: string; count: number }>([
      { $project: { emailKey: { $toLower: { $ifNull: ["$normalizedEmail", "$email"] } } } },
      { $match: { emailKey: { $ne: "" } } },
      { $group: { _id: "$emailKey", count: { $sum: 1 } } },
    ]),
  ]);
  const rankingById = new Map(rankings.map((ranking) => [ranking.customerId, ranking]));
  const rankingByEmail = new Map(rankings.map((ranking) => [normalizeEmail(ranking.email), ranking]));
  const duplicateEmailCounts = new Map(duplicateEmails.map((row) => [row._id, row.count]));

  const rows = customers.flatMap((customer) => {
    const email = normalizeEmail(customer.normalizedEmail || customer.email);
    const id = String(customer._id);
    const ranking = rankingById.get(id) || rankingByEmail.get(email);
    const customerWoo = wooOrders.filter((order) => normalizeEmail(order.normalizedEmail || order.billingEmail) === email);
    const customerAuth = authTxs.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.customerEmail].map(normalizeEmail).includes(email) || tx.matchedCustomerId === id);
    const customerNmi = nmiTxs.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.customerEmail].map(normalizeEmail).includes(email) || tx.matchedCustomerId === id);
    const customerStripe = stripeTxs.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.email].map(normalizeEmail).includes(email) || tx.matchedCustomerId === id);
    const customerSubs = subs.filter((sub) => normalizeEmail(sub.normalizedEmail || sub.customerEmail) === email);
    const verification = verifyCustomer({
      customer,
      ranking,
      wooOrders: customerWoo,
      authorizeNetTransactions: customerAuth,
      nmiTransactions: customerNmi,
      subscriptions: customerSubs,
      duplicateEmailCount: duplicateEmailCounts.get(email) ?? 0,
    });
    if (statusFilter && verification.verificationStatus !== statusFilter) return [];
    const contact = extractBestBusinessContactFields(customer, ranking, customerWoo);
    const metrics = calculateCustomerValueMetrics({ customer, wooOrders: customerWoo, authorizeNetTransactions: customerAuth, nmiTransactions: customerNmi, stripeTransactions: customerStripe, subscriptions: customerSubs });
    const factiivScore = resolveFactiivScore(customer.factiivProfile);
    const profile = (customer.factiivProfile ?? {}) as Partial<CustomerFactiivProfile>;
    const row: Record<string, unknown> = {
      customerId: id,
      customerName: missing(customer.name),
      email: missing(email || customer.email),
      businessName: missing(contact.businessName || ranking?.businessName || customer.businessProfile?.businessName || customer.businessProfile?.company),
      phoneNumber: missing(contact.phoneNumber || customer.phone || customer.businessProfile?.phone),
      businessAddress: missing(contact.businessAddress),
      ein: missing(contact.ein || customer.businessProfile?.ein || customer.creditProfile?.ein || ranking?.ein),
      state: missing(contact.state || ranking?.stateCode || customer.businessProfile?.stateCode || customer.businessProfile?.state),
      city: missing(contact.city || ranking?.city || customer.businessProfile?.city),
      zip: missing(contact.zip || ranking?.zip || customer.businessProfile?.zip),
      country: missing(contact.country || ranking?.country || customer.businessProfile?.country),
      website: missing(customer.businessProfile?.website || customer.publicEnrichment?.publicBusinessWebsite || customer.publicEnrichment?.websiteDomain),
      businessIndustry: missing(customer.businessProfile?.industry || customer.publicEnrichment?.inferredIndustry),
      industryCode: missing(customer.businessProfile?.naicsCode || customer.publicEnrichment?.naicsCode || customer.businessProfile?.sicCode || customer.publicEnrichment?.sicCode),
      industryCodeType: customer.businessProfile?.naicsCode || customer.publicEnrichment?.naicsCode ? "NAICS" : customer.businessProfile?.sicCode || customer.publicEnrichment?.sicCode ? "SIC" : "NAICS",
      industryDescription: customer.businessProfile?.industry || customer.publicEnrichment?.inferredIndustry ? "Stored customer profile industry." : "Needs manual review",
      factiivProfileId: missing(factiivScore.factiivProfileId || ranking?.factiivProfileId),
      factiivScore: factiivScore.exportValue === "Missing" ? missing(ranking?.factiivScore) : factiivScore.exportValue,
      factiivMatchedBusiness: missing(profile.matchedBusinessName || ranking?.factiivMatchedBusiness),
      factiivMatchedEmail: missing(profile.matchedEmail || ranking?.factiivMatchedEmail),
      factiivMatchedBy: missing(profile.matchedBy),
      factiivLastSync: dateOnly(profile.lastFactiivSync || ranking?.factiivLastSync),
      factiivTradeLines: missing(profile.tradeQuantity || ranking?.factiivTradeLines),
      factiivTotalTradeAmount: missing(profile.tradeAmountTotal || ranking?.factiivTotalTradeAmount),
      factiivOutstandingBalance: missing(profile.tradeBalanceTotal || profile.activityLastKnownBalanceTotal || ranking?.factiivOutstandingBalance),
      factiivVerifiedCreditLimit: missing(customer.creditProfile?.approvedCredits || customer.businessProfile?.approvedCredits || ranking?.factiivVerifiedCreditLimit),
      totalAmountPaid: metrics.rankingTotal,
      totalValueOfThisCustomer: metrics.rankingTotal,
      lifetimeValue: metrics.rankingTotal,
      wooCommerceTotal: metrics.wooPaidTotal,
      authorizeNetTotal: metrics.authorizeNetPaidTotal,
      nmiTotal: metrics.nmiQuickPayPaidTotal,
      stripeTotal: metrics.stripePaidTotal,
      gatewayOnlyTotal: metrics.gatewayOnlyPaidTotal,
      successfulPaymentCount: successfulPaymentCount(customer, customerWoo, customerAuth, customerNmi, customerStripe),
      lastPaidDate: dateOnly(metrics.lastPaidDate || ranking?.latestPaidDate || customer.lastPaidDate),
      fundingScore: missing(customer.businessProfile?.fundingScore || ranking?.fundingScore),
      fundingCategory: missing(customer.businessProfile?.fundingCategory || ranking?.fundingCategory),
      recommendedFundingProducts: missing((customer.businessProfile?.recommendedFundingProducts ?? ranking?.recommendedFundingProducts ?? []).join("; ")),
      dataConfidenceStatus: verification.revenueMismatch ? "Revenue Review" : metrics.refundsAndChargebacksDetected ? "Refund/Chargeback Review" : "Verified",
      verificationStatus: verification.verificationStatus,
      verificationScore: verification.verificationScore,
      missingFields: verification.missingFields.join("; "),
      reviewReasons: verification.reviewReasons.join("; "),
      sourceConfidence: verification.sourceConfidence,
      lastVerifiedAt: dateOnly(customer.sourceCoverage?.lastCustomerVerificationAt),
    };
    if (includeDebug) {
      row.debugChangedFields = verification.changedFields;
      row.debugContactSources = contact.fieldSources;
    }
    return [row];
  });

  if (format === "csv") {
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"all-verified-customers.csv\"",
      },
    });
  }
  return NextResponse.json({ success: true, total: rows.length, generatedAt: new Date().toISOString(), customers: rows, totalMs: Date.now() - started });
}
