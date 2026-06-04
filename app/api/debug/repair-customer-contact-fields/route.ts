import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { extractBestBusinessContactFields, type BusinessContactFields } from "@/lib/customerContactFields";
import { stateNameForCode } from "@/lib/customerBusinessResolver";
import { computeFundingIntelligence } from "@/lib/fundingIntelligence";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

type RepairBody = {
  dryRun?: boolean;
  limit?: number;
  cursor?: string | null;
};

const contactFields = ["address1", "city", "state", "zip", "phoneNumber", "ein", "businessName"] as const;

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text && text !== "Missing" && text !== "-" ? text : "";
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function hasAddress(customer: LeanCustomer) {
  return Boolean(clean(customer.businessProfile?.address1));
}

function hasCity(customer: LeanCustomer) {
  return Boolean(clean(customer.businessProfile?.city));
}

function hasState(customer: LeanCustomer) {
  return Boolean(clean(customer.businessProfile?.stateCode || customer.businessProfile?.state));
}

function hasZip(customer: LeanCustomer) {
  return Boolean(clean(customer.businessProfile?.zip));
}

function hasPhone(customer: LeanCustomer) {
  return Boolean(clean(customer.businessProfile?.phone || customer.phone));
}

function hasEin(customer: LeanCustomer) {
  return Boolean(clean(customer.businessProfile?.ein || customer.creditProfile?.ein));
}

function hasBusinessName(customer: LeanCustomer) {
  return Boolean(clean(customer.businessProfile?.businessName || customer.businessProfile?.company));
}

function missingFieldList(customer: LeanCustomer) {
  return [
    !hasAddress(customer) ? "address" : "",
    !hasCity(customer) ? "city" : "",
    !hasState(customer) ? "state" : "",
    !hasZip(customer) ? "zip" : "",
    !hasPhone(customer) ? "phone" : "",
    !hasEin(customer) ? "ein" : "",
    !hasBusinessName(customer) ? "businessName" : "",
  ].filter(Boolean);
}

function sourceIncludes(contact: BusinessContactFields, source: string) {
  return Object.values(contact.fieldSources).some((value) => value.toLowerCase().includes(source));
}

function buildCustomerSet(customer: LeanCustomer, contact: BusinessContactFields) {
  const set: Record<string, unknown> = {};
  const profile = (customer.businessProfile ?? {}) as Record<string, unknown>;
  if (contact.businessName && !clean(profile.businessName)) set["businessProfile.businessName"] = contact.businessName;
  if (contact.businessName && !clean(profile.company)) set["businessProfile.company"] = contact.businessName;
  if (contact.address1 && !clean(profile.address1)) set["businessProfile.address1"] = contact.address1;
  if (contact.address2 && !clean(profile.address2)) set["businessProfile.address2"] = contact.address2;
  if (contact.city && !clean(profile.city)) set["businessProfile.city"] = contact.city;
  if (contact.state && !clean(profile.stateCode)) set["businessProfile.stateCode"] = contact.state;
  if (contact.state && !clean(profile.state)) set["businessProfile.state"] = contact.state;
  if (contact.zip && !clean(profile.zip)) set["businessProfile.zip"] = contact.zip;
  if (contact.country && !clean(profile.country)) set["businessProfile.country"] = contact.country;
  if (contact.phoneNumber && !clean(profile.phone)) set["businessProfile.phone"] = contact.phoneNumber;
  if (contact.phoneNumber && !clean(customer.phone)) set.phone = contact.phoneNumber;
  if (contact.ein && !clean(profile.ein)) set["businessProfile.ein"] = contact.ein;

  if (Object.keys(set).length) {
    set["businessProfile.businessNameSource"] = contact.fieldSources.businessName || profile.businessNameSource || "";
    set["businessProfile.businessNameConfidence"] = contact.businessName ? "high" : profile.businessNameConfidence || "";
    set["businessProfile.stateSource"] = contact.fieldSources.state || profile.stateSource || "";
    set["businessProfile.stateConfidence"] = contact.state ? "high" : profile.stateConfidence || "";
    set["sourceCoverage.businessFieldsSource"] = contact.fieldSources;
    set["sourceCoverage.lastContactFieldRepairAt"] = new Date().toISOString();
  }
  return set;
}

function buildRankingSet(contact: BusinessContactFields) {
  const set: Record<string, unknown> = {
    contactFieldSources: contact.fieldSources,
    updatedAt: new Date(),
  };
  if (contact.businessName) {
    set.businessName = contact.businessName;
    set.businessNameSource = contact.fieldSources.businessName;
    set.businessNameConfidence = "high";
  }
  if (contact.phoneNumber) set.phone = contact.phoneNumber;
  if (contact.businessAddress) set.businessAddress = contact.businessAddress;
  if (contact.address1) set.address1 = contact.address1;
  if (contact.address2) set.address2 = contact.address2;
  if (contact.city) set.city = contact.city;
  if (contact.state) {
    set.stateCode = contact.state;
    set.stateName = stateNameForCode(contact.state);
    set.stateSource = contact.fieldSources.state;
    set.stateConfidence = "high";
  }
  if (contact.zip) set.zip = contact.zip;
  if (contact.country) set.country = contact.country;
  if (contact.ein) set.ein = contact.ein;
  return set;
}

function projectedCustomer(customer: LeanCustomer, set: Record<string, unknown>) {
  const businessProfile = { ...(customer.businessProfile ?? {}) };
  for (const [key, value] of Object.entries(set)) {
    if (!key.startsWith("businessProfile.")) continue;
    businessProfile[key.replace("businessProfile.", "") as keyof typeof businessProfile] = value as never;
  }
  return {
    ...customer,
    phone: set.phone ? String(set.phone) : customer.phone,
    businessProfile,
  };
}

export async function POST(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as RepairBody;
  const dryRun = body.dryRun !== false;
  const limit = Math.min(1000, Math.max(1, Math.floor(Number(body.limit ?? 500))));
  const cursor = clean(body.cursor);
  const query = cursor && mongoose.isValidObjectId(cursor) ? { _id: { $gt: new mongoose.Types.ObjectId(cursor) } } : {};

  const [totalCustomers, customers] = await Promise.all([
    Customer.countDocuments({}),
    Customer.find(query, {
      name: 1,
      email: 1,
      normalizedEmail: 1,
      phone: 1,
      businessProfile: 1,
      creditProfile: 1,
      factiivProfile: 1,
      publicEnrichment: 1,
      firstPaidDate: 1,
      firstOrderDate: 1,
      customerCreatedAt: 1,
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
    }).sort({ _id: 1 }).limit(limit).lean<LeanCustomer[]>(),
  ]);

  const emails = customers.map((customer) => normalizeEmail(customer.normalizedEmail || customer.email)).filter(Boolean);
  const [rankings, wooOrders] = await Promise.all([
    CustomerRanking.find({ email: { $in: emails } }).lean<Array<CustomerRankingDocument & { _id: unknown }>>(),
    WooCommerceOrderRecord.find({ normalizedEmail: { $in: emails } }).sort({ dateCreated: -1 }).lean<WooCommerceOrderDocument[]>(),
  ]);
  const rankingByEmail = new Map(rankings.map((ranking) => [normalizeEmail(ranking.email), ranking]));
  const ordersByEmail = new Map<string, WooCommerceOrderDocument[]>();
  for (const order of wooOrders) {
    const email = normalizeEmail(order.normalizedEmail || order.billingEmail);
    if (!email) continue;
    ordersByEmail.set(email, [...(ordersByEmail.get(email) ?? []), order]);
  }

  let missingAddressBefore = 0;
  let missingCityBefore = 0;
  let repairableFromWooOrders = 0;
  let repairableFromFactiivProfile = 0;
  let notRepairable = 0;
  let repairedCustomers = 0;
  const sampleRepairable: unknown[] = [];
  const sampleNotRepairable: unknown[] = [];
  const sampleFixedRows: unknown[] = [];

  for (const customer of customers) {
    const email = normalizeEmail(customer.normalizedEmail || customer.email);
    const ranking = rankingByEmail.get(email) ?? null;
    const contact = extractBestBusinessContactFields(customer, ranking, ordersByEmail.get(email) ?? []);
    const missingBefore = missingFieldList(customer);
    if (!hasAddress(customer)) missingAddressBefore += 1;
    if (!hasCity(customer)) missingCityBefore += 1;
    const set = buildCustomerSet(customer, contact);
    const changedFields = Object.keys(set).filter((key) => key.startsWith("businessProfile.") || key === "phone");
    const hasRepair = changedFields.length > 0;
    const fromWoo = sourceIncludes(contact, "woocommerce");
    const fromFactiiv = sourceIncludes(contact, "factiiv");
    if (hasRepair && fromWoo) repairableFromWooOrders += 1;
    else if (hasRepair && fromFactiiv) repairableFromFactiivProfile += 1;
    else if (missingBefore.length) notRepairable += 1;

    const sample = {
      customerId: String(customer._id),
      email,
      missingBefore,
      proposed: contact,
      changedFields,
    };
    if (hasRepair && sampleRepairable.length < 10) sampleRepairable.push(sample);
    if (!hasRepair && missingBefore.length && sampleNotRepairable.length < 10) sampleNotRepairable.push(sample);

    if (!hasRepair) continue;
    repairedCustomers += 1;
    if (sampleFixedRows.length < 10) sampleFixedRows.push(sample);
    if (dryRun) continue;

    const projected = projectedCustomer(customer, set);
    const summary = computeFundingIntelligence(projected as LeanCustomer, ranking);
    await Customer.updateOne(
      { _id: customer._id },
      {
        $set: {
          ...set,
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
        },
      }
    ).exec();
    await CustomerRanking.updateOne(
      { customerId: String(customer._id) },
      {
        $set: {
          ...buildRankingSet(contact),
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

  const last = customers[customers.length - 1];
  const nextCursor = last ? String(last._id) : null;
  const hasMore = customers.length === limit && Boolean(nextCursor);
  return NextResponse.json({
    success: true,
    dryRun,
    totalCustomers,
    checked: customers.length,
    repairedCustomers,
    cursor: nextCursor,
    hasMore,
    missingAddressBefore,
    missingCityBefore,
    repairableFromWooOrders,
    repairableFromFactiivProfile,
    notRepairable,
    sampleRepairable,
    sampleNotRepairable,
    sampleFixedRows,
    fieldsChecked: contactFields,
    totalMs: Date.now() - started,
  });
}
