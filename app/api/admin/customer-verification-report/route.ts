import { NextResponse } from "next/server";
import { verifyCustomer, type VerificationStatus } from "@/lib/customerVerification";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { StripeTransaction, type StripeTransactionDocument } from "@/models/StripeTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text && text !== "Missing" && text !== "-" ? text : "";
}

function emailOf(customer: LeanCustomer) {
  return clean(customer.normalizedEmail || customer.email).toLowerCase();
}

function hasValue(value: unknown) {
  return Boolean(clean(value));
}

function incrementStatus(counts: Record<VerificationStatus, number>, status: VerificationStatus) {
  counts[status] += 1;
}

export async function GET() {
  const started = Date.now();
  await connectToDatabase();
  const totalCustomers = await Customer.countDocuments({});
  const duplicateEmails = await Customer.aggregate<{ _id: string; count: number }>([
    { $project: { emailKey: { $toLower: { $ifNull: ["$normalizedEmail", "$email"] } } } },
    { $match: { emailKey: { $ne: "" } } },
    { $group: { _id: "$emailKey", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  const duplicateEmailCounts = new Map(duplicateEmails.map((row) => [row._id, row.count]));

  const statusCounts: Record<VerificationStatus, number> = {
    Verified: 0,
    "Partially Verified": 0,
    "Needs Review": 0,
    "Missing Critical Data": 0,
  };
  const coverage = {
    businessNamePresent: 0,
    businessNameMissing: 0,
    addressPresent: 0,
    addressMissing: 0,
    cityPresent: 0,
    cityMissing: 0,
    statePresent: 0,
    stateMissing: 0,
    zipPresent: 0,
    zipMissing: 0,
    phonePresent: 0,
    phoneMissing: 0,
    emailPresent: 0,
    emailMissing: 0,
    einPresent: 0,
    einMissing: 0,
    revenueVerified: 0,
    revenueMismatch: 0,
    subscriptionVerified: 0,
    subscriptionMissing: 0,
    factiivProfilePresent: 0,
    factiivProfileMissing: 0,
    factiivScorePresent: 0,
    factiivScoreMissing: 0,
    fundingScorePresent: 0,
    fundingScoreMissing: 0,
  };
  let duplicateSuspects = 0;
  let revenueMismatchCustomers = 0;
  let contactMissingCustomers = 0;
  let factiivMissingCustomers = 0;
  let fundingMissingCustomers = 0;
  const sampleNeedsReview: unknown[] = [];

  let cursor = "";
  const batchSize = 250;
  while (true) {
    const query = cursor ? { _id: { $gt: cursor } } : {};
    const customers = await Customer.find(query, {
      name: 1, email: 1, normalizedEmail: 1, phone: 1, businessProfile: 1, creditProfile: 1, factiivProfile: 1,
      paidTotal: 1, totalPaid: 1, lifetimeValue: 1, rankingPaidTotal: 1, orders: 1, gatewayPayments: 1,
      subscriptionStatus: 1, activeSubscriptions: 1, isGatewayRecurring: 1, recurringAmount: 1, recurringNextEstimatedPayment: 1, recurringLastPayment: 1,
      attemptedTotal: 1, paidOrderCount: 1, paidMonths: 1, firstOrderDate: 1, firstSignupDate: 1, lastPaidDate: 1, recurringPaymentCount: 1,
      sourceCoverage: 1,
    }).sort({ _id: 1 }).limit(batchSize).lean<LeanCustomer[]>();
    if (!customers.length) break;
    cursor = String(customers[customers.length - 1]._id);
    const emails = Array.from(new Set(customers.map(emailOf).filter(Boolean)));
    const ids = customers.map((customer) => String(customer._id));
    const [rankings, wooOrders, authTxs, nmiTxs, stripeTxs, subs] = await Promise.all([
      CustomerRanking.find({ $or: [{ customerId: { $in: ids } }, { email: { $in: emails } }] }).lean<CustomerRankingDocument[]>(),
      WooCommerceOrderRecord.find({ normalizedEmail: { $in: emails } }).lean<WooCommerceOrderDocument[]>(),
      AuthorizeNetTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { customerEmail: { $in: emails } }, { matchedCustomerId: { $in: ids } }] }).lean<AuthorizeNetTransactionDocument[]>(),
      NmiQuickPayTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { customerEmail: { $in: emails } }, { matchedCustomerId: { $in: ids } }] }).lean<NmiQuickPayTransactionDocument[]>(),
      StripeTransaction.find({ $or: [{ normalizedEmail: { $in: emails } }, { emailNormalized: { $in: emails } }, { email: { $in: emails } }, { matchedCustomerId: { $in: ids } }] }).lean<StripeTransactionDocument[]>(),
      WooCommerceSubscriptionRecord.find({ normalizedEmail: { $in: emails } }).lean<WooCommerceSubscriptionDocument[]>(),
    ]);
    const rankingById = new Map(rankings.map((ranking) => [ranking.customerId, ranking]));
    const rankingByEmail = new Map(rankings.map((ranking) => [clean(ranking.email).toLowerCase(), ranking]));

    for (const customer of customers) {
      const email = emailOf(customer);
      const id = String(customer._id);
      const ranking = rankingById.get(id) || rankingByEmail.get(email);
      const customerWoo = wooOrders.filter((order) => clean(order.normalizedEmail || order.billingEmail).toLowerCase() === email);
      const customerAuth = authTxs.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.customerEmail].map((value) => clean(value).toLowerCase()).includes(email) || tx.matchedCustomerId === id);
      const customerNmi = nmiTxs.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.customerEmail].map((value) => clean(value).toLowerCase()).includes(email) || tx.matchedCustomerId === id);
      const customerStripe = stripeTxs.filter((tx) => [tx.normalizedEmail, tx.emailNormalized, tx.email].map((value) => clean(value).toLowerCase()).includes(email) || tx.matchedCustomerId === id);
      const customerSubs = subs.filter((sub) => clean(sub.normalizedEmail || sub.customerEmail).toLowerCase() === email);
      const result = verifyCustomer({
        customer,
        ranking,
        wooOrders: customerWoo,
        authorizeNetTransactions: customerAuth,
        nmiTransactions: customerNmi,
        stripeTransactions: customerStripe,
        subscriptions: customerSubs,
        duplicateEmailCount: duplicateEmailCounts.get(email) ?? 0,
      });
      incrementStatus(statusCounts, result.verificationStatus);
      if (result.duplicateSuspect) duplicateSuspects += 1;
      if (result.revenueMismatch) revenueMismatchCustomers += 1;
      if (result.contactMissing) contactMissingCustomers += 1;
      if (!result.factiivScorePresent) factiivMissingCustomers += 1;
      if (!result.fundingScorePresent) fundingMissingCustomers += 1;
      if (result.revenueMismatch) coverage.revenueMismatch += 1; else coverage.revenueVerified += 1;
      if (result.subscriptionVerified) coverage.subscriptionVerified += 1; else coverage.subscriptionMissing += 1;
      if (result.factiivScorePresent) coverage.factiivScorePresent += 1; else coverage.factiivScoreMissing += 1;
      if (hasValue(customer.factiivProfile?.factiivProfileId || customer.factiivProfile?.profileId || ranking?.factiivProfileId)) coverage.factiivProfilePresent += 1; else coverage.factiivProfileMissing += 1;
      if (result.fundingScorePresent) coverage.fundingScorePresent += 1; else coverage.fundingScoreMissing += 1;
      const fieldSet = new Set(result.missingFields);
      for (const field of ["businessName", "address", "city", "state", "zip", "phone", "email", "ein"] as const) {
        const presentKey = `${field}Present` as keyof typeof coverage;
        const missingKey = `${field}Missing` as keyof typeof coverage;
        if (fieldSet.has(field)) coverage[missingKey] += 1;
        else coverage[presentKey] += 1;
      }
      if (sampleNeedsReview.length < 25 && result.reviewReasons.length) {
        sampleNeedsReview.push({ customerId: id, email, status: result.verificationStatus, score: result.verificationScore, missingFields: result.missingFields, reviewReasons: result.reviewReasons });
      }
    }
    if (customers.length < batchSize) break;
  }

  const exportReadinessScore = totalCustomers ? Math.round(((coverage.businessNamePresent + coverage.addressPresent + coverage.cityPresent + coverage.statePresent + coverage.einPresent + coverage.revenueVerified + coverage.factiivScorePresent + coverage.fundingScorePresent) / (totalCustomers * 8)) * 100) : 0;

  return NextResponse.json({
    success: true,
    generatedAt: new Date().toISOString(),
    totalCustomers,
    verifiedCustomers: statusCounts.Verified,
    partiallyVerifiedCustomers: statusCounts["Partially Verified"],
    needsReviewCustomers: statusCounts["Needs Review"],
    missingCriticalDataCustomers: statusCounts["Missing Critical Data"],
    duplicateSuspects,
    revenueMismatchCustomers,
    contactMissingCustomers,
    factiivMissingCustomers,
    fundingMissingCustomers,
    coverage,
    exportReadinessScore,
    sampleNeedsReview,
    totalMs: Date.now() - started,
  });
}
