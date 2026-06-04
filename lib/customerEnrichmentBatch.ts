import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking } from "@/models/CustomerRanking";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

function normalizedEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function isMissing(value: unknown) {
  const text = String(value ?? "").trim();
  return !text || text === "-";
}

function readPath(source: unknown, path: string[]) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (text && text !== "-") return text;
  }
  return "";
}

function setIfMissing(set: Record<string, unknown>, customer: CustomerDocument, profileField: string, value: unknown) {
  if (!isMissing(readPath(customer, ["businessProfile", profileField]))) return;
  const text = firstText(value);
  if (text) set[`businessProfile.${profileField}`] = text;
}

async function wooOrdersByEmail(emails: string[]) {
  const normalizedEmails = Array.from(new Set(emails.map(normalizedEmail).filter(Boolean)));
  if (!normalizedEmails.length) return new Map<string, WooCommerceOrderDocument[]>();
  const orders = await WooCommerceOrderRecord.find(
    { normalizedEmail: { $in: normalizedEmails } },
    { normalizedEmail: 1, billingCompany: 1, billingEmail: 1, billingPhone: 1, billing: 1, billingAddress: 1, dateCreated: 1, isPaid: 1 },
  ).sort({ isPaid: -1, dateCreated: -1 }).limit(Math.min(10000, normalizedEmails.length * 10)).lean<WooCommerceOrderDocument[]>();
  const byEmail = new Map<string, WooCommerceOrderDocument[]>();
  for (const order of orders) {
    const email = normalizedEmail(order.normalizedEmail);
    if (!email) continue;
    byEmail.set(email, [...(byEmail.get(email) ?? []), order]);
  }
  return byEmail;
}

export async function enrichMissingCustomerProfilesBatch({ limit = 100, offset = 0, allCustomers = false }: { limit?: number; offset?: number; allCustomers?: boolean } = {}) {
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const missingQuery = {
    $or: [
      { "businessProfile.businessName": { $in: ["", "-"] } },
      { "businessProfile.businessName": { $exists: false } },
      { "businessProfile.stateCode": { $in: ["", "-"] } },
      { "businessProfile.stateCode": { $exists: false } },
      { "businessProfile.state": { $in: ["", "-"] } },
      { "businessProfile.state": { $exists: false } },
      { "businessProfile.address1": { $in: ["", "-"] } },
      { "businessProfile.address1": { $exists: false } },
      { "businessProfile.phone": { $in: ["", "-"] } },
      { "businessProfile.phone": { $exists: false } },
      { "businessProfile.website": { $in: ["", "-"] } },
      { "businessProfile.website": { $exists: false } },
      { "businessProfile.ein": { $in: ["", "-"] } },
      { "businessProfile.ein": { $exists: false } },
      { "businessProfile.businessType": { $in: ["", "-"] } },
      { "businessProfile.businessType": { $exists: false } },
    ],
  };
  const customers = await Customer.find(allCustomers ? {} : missingQuery, {
    name: 1, email: 1, normalizedEmail: 1, phone: 1, businessProfile: 1, profile: 1, billingAddress: 1, address: 1, orders: 1, factiivProfile: 1, creditProfile: 1, publicEnrichment: 1,
  }).sort({ _id: 1 }).skip(safeOffset).limit(safeLimit).lean<Array<CustomerDocument & { _id: unknown }>>();
  const ordersByEmail = await wooOrdersByEmail(customers.map((customer) => customer.normalizedEmail || customer.email || ""));
  const rows = [];
  let updated = 0;
  for (const customer of customers) {
    const email = normalizedEmail(customer.normalizedEmail || customer.email);
    const wooOrders = ordersByEmail.get(email) ?? [];
    const resolverInput = { ...customer, latestWooOrder: wooOrders[0], latestWooOrders: wooOrders, wooOrders };
    const enriched = enrichCustomerProfile(resolverInput);
    const existingBusiness = customer.businessProfile?.businessName || customer.businessProfile?.company || "";
    const existingState = customer.businessProfile?.stateCode || customer.businessProfile?.state || "";
    const set: Record<string, unknown> = {};
    if (isMissing(existingBusiness) && enriched.businessName) {
      set["businessProfile.businessName"] = enriched.businessName;
      set["businessProfile.company"] = enriched.businessName;
      set["businessProfile.businessNameSource"] = enriched.businessNameSource;
      set["businessProfile.businessNameConfidence"] = enriched.businessNameConfidence;
    }
    if (isMissing(existingState) && enriched.stateCode) {
      set["businessProfile.state"] = enriched.stateCode;
      set["businessProfile.stateCode"] = enriched.stateCode;
      set["businessProfile.stateSource"] = enriched.stateSource;
      set["businessProfile.stateConfidence"] = enriched.stateConfidence;
    }
    const latestWooOrder = wooOrders[0];
    setIfMissing(set, customer, "email", firstText(readPath(latestWooOrder, ["billingEmail"]), readPath(latestWooOrder, ["billing", "email"]), readPath(customer, ["creditProfile", "email"]), customer.email));
    setIfMissing(set, customer, "phone", firstText(readPath(latestWooOrder, ["billingPhone"]), readPath(latestWooOrder, ["billing", "phone"]), readPath(customer, ["creditProfile", "phone"]), customer.phone));
    setIfMissing(set, customer, "address1", firstText(readPath(latestWooOrder, ["billingAddress", "address1"]), readPath(latestWooOrder, ["billing", "address_1"]), readPath(customer, ["billingAddress", "address1"]), readPath(customer, ["address", "address1"])));
    setIfMissing(set, customer, "address2", firstText(readPath(latestWooOrder, ["billingAddress", "address2"]), readPath(latestWooOrder, ["billing", "address_2"]), readPath(customer, ["billingAddress", "address2"]), readPath(customer, ["address", "address2"])));
    setIfMissing(set, customer, "city", firstText(readPath(latestWooOrder, ["billingAddress", "city"]), readPath(latestWooOrder, ["billing", "city"]), readPath(customer, ["billingAddress", "city"]), readPath(customer, ["address", "city"])));
    setIfMissing(set, customer, "zip", firstText(readPath(latestWooOrder, ["billingAddress", "postcode"]), readPath(latestWooOrder, ["billingAddress", "zip"]), readPath(latestWooOrder, ["billing", "postcode"]), readPath(customer, ["billingAddress", "postcode"]), readPath(customer, ["address", "postcode"])));
    setIfMissing(set, customer, "country", firstText(readPath(latestWooOrder, ["billingAddress", "country"]), readPath(latestWooOrder, ["billing", "country"]), readPath(customer, ["billingAddress", "country"]), readPath(customer, ["address", "country"])));
    setIfMissing(set, customer, "ein", firstText(readPath(customer, ["creditProfile", "ein"]), readPath(customer, ["factiivProfile", "ein"]), readPath(customer, ["profile", "ein"])));
    setIfMissing(set, customer, "businessType", firstText(readPath(customer, ["factiivProfile", "businessType"]), readPath(customer, ["publicEnrichment", "businessType"]), readPath(customer, ["profile", "businessType"])));
    setIfMissing(set, customer, "industry", firstText(readPath(customer, ["factiivProfile", "industry"]), readPath(customer, ["publicEnrichment", "inferredIndustry"]), readPath(customer, ["profile", "industry"])));
    setIfMissing(set, customer, "website", firstText(readPath(customer, ["publicEnrichment", "publicBusinessWebsite"]), readPath(customer, ["publicEnrichment", "websiteDomain"]), readPath(customer, ["profile", "website"])));
    if (Object.keys(set).length) {
      set["businessProfile.enrichmentSource"] = enriched.enrichmentSource;
      set["sourceCoverage.enrichmentSources"] = enriched.enrichmentSource.split(", ").filter(Boolean);
      set["sourceCoverage.lastEnrichmentRun"] = new Date().toISOString();
      await Customer.updateOne({ _id: customer._id }, { $set: set }).exec();
      await CustomerRanking.updateOne({ customerId: String(customer._id) }, {
        $set: {
          ...(enriched.businessName ? { businessName: enriched.businessName, businessNameSource: enriched.businessNameSource, businessNameConfidence: enriched.businessNameConfidence } : {}),
          ...(enriched.stateCode ? { stateCode: enriched.stateCode, stateName: enriched.stateName, stateSource: enriched.stateSource, stateConfidence: enriched.stateConfidence } : {}),
          enrichmentSource: enriched.enrichmentSource,
        },
      }).exec();
      updated += 1;
    }
    rows.push({
      customerId: String(customer._id),
      email: customer.email,
      businessName: enriched.businessName,
      businessNameConfidence: enriched.businessNameConfidence,
      stateCode: enriched.stateCode,
      stateConfidence: enriched.stateConfidence,
      enrichmentSource: enriched.enrichmentSource,
      updated: Object.keys(set).length > 0,
    });
  }
  return { limit: safeLimit, offset: safeOffset, allCustomers, processed: customers.length, updated, hasMore: customers.length === safeLimit, nextOffset: safeOffset + customers.length, rows };
}
