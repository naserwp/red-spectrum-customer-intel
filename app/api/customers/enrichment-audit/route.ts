import { NextResponse } from "next/server";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";

export const dynamic = "force-dynamic";

function isMissing(value: unknown) {
  const text = String(value ?? "").trim();
  return !text || text === "-";
}

function increment(map: Record<string, number>, key: string) {
  map[key || "unresolved"] = (map[key || "unresolved"] ?? 0) + 1;
}

function hasAnyAddress(customer: CustomerDocument) {
  const profile = customer.businessProfile ?? {};
  const looseCustomer = customer as CustomerDocument & {
    address?: { address1?: string; city?: string; state?: string; postcode?: string };
    billingAddress?: { address1?: string; city?: string; state?: string; postcode?: string };
  };
  const address = looseCustomer.address ?? {};
  const billingAddress = looseCustomer.billingAddress ?? {};
  return Boolean(
    profile.address1 || profile.city || profile.stateCode || profile.state || profile.zip ||
    address.address1 || address.city || address.state || address.postcode ||
    billingAddress.address1 || billingAddress.city || billingAddress.state || billingAddress.postcode
  );
}

function profileCompletionBucket(customer: CustomerDocument) {
  const profile = customer.businessProfile ?? {};
  const fields = [
    profile.businessName || profile.company,
    profile.stateCode || profile.state,
    profile.address1,
    profile.city,
    profile.zip,
    profile.phone,
    profile.email || customer.email,
    profile.ein,
    profile.website,
    profile.industry || profile.businessType,
  ];
  const completed = fields.filter((value) => !isMissing(value)).length;
  const percent = Math.round((completed / fields.length) * 100);
  if (percent >= 80) return "high";
  if (percent >= 50) return "medium";
  if (percent > 0) return "low";
  return "unresolved";
}

export async function GET() {
  await connectToDatabase();
  const customers = await Customer.find({}, {
    email: 1, normalizedEmail: 1, businessProfile: 1, profile: 1, billingAddress: 1, address: 1, orders: 1, factiivProfile: 1, publicEnrichment: 1,
  }).limit(10000).lean<Array<CustomerDocument & { _id: unknown }>>();

  let totalMissingBusiness = 0;
  let totalMissingState = 0;
  let businessNamePresent = 0;
  let statePresent = 0;
  let addressPresent = 0;
  let addressMissing = 0;
  let totalResolved = 0;
  let totalUnresolved = 0;
  const resolutionSources: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  const profileCompletionCounts: Record<string, number> = {};

  for (const customer of customers) {
    const missingBusiness = isMissing(customer.businessProfile?.businessName || customer.businessProfile?.company);
    const missingState = isMissing(customer.businessProfile?.stateCode || customer.businessProfile?.state);
    if (missingBusiness) totalMissingBusiness += 1;
    if (missingState) totalMissingState += 1;
    if (!missingBusiness) businessNamePresent += 1;
    if (!missingState) statePresent += 1;
    if (hasAnyAddress(customer)) addressPresent += 1;
    else addressMissing += 1;
    increment(profileCompletionCounts, profileCompletionBucket(customer));
    if (!missingBusiness && !missingState) continue;
    const enriched = enrichCustomerProfile(customer);
    if (enriched.resolved) {
      totalResolved += 1;
      increment(resolutionSources, enriched.enrichmentSource);
      increment(confidence, [enriched.businessNameConfidence, enriched.stateConfidence].filter((value) => value !== "unresolved").join("+") || "unresolved");
    } else {
      totalUnresolved += 1;
      increment(resolutionSources, "unresolved");
      increment(confidence, "unresolved");
    }
  }

  return NextResponse.json({
    ok: true,
    totalCustomers: customers.length,
    sampledCustomers: customers.length,
    businessNamePresent,
    businessNameMissing: totalMissingBusiness,
    statePresent,
    stateMissing: totalMissingState,
    addressPresent,
    addressMissing,
    profileCompletionCounts,
    totalMissingBusiness,
    totalMissingState,
    totalResolved,
    totalUnresolved,
    resolvedThisRun: totalResolved,
    failedToResolve: totalUnresolved,
    finalAudit: {
      resolved: businessNamePresent + statePresent + addressPresent,
      unresolved: totalMissingBusiness + totalMissingState + addressMissing,
      successRate: customers.length
        ? Math.round(((businessNamePresent + statePresent + addressPresent) / (customers.length * 3)) * 100)
        : 0,
    },
    resolutionSources,
    confidence,
  });
}
