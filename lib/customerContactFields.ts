import { normalizeStateCode } from "@/lib/customerBusinessResolver";
import type { CustomerDocument } from "@/models/Customer";
import type { CustomerRankingDocument } from "@/models/CustomerRanking";
import type { WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

type LeanCustomer = Partial<CustomerDocument> & { _id?: unknown };
type LeanRanking = Partial<CustomerRankingDocument>;

export type BusinessContactFields = {
  businessAddress: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phoneNumber: string;
  email: string;
  ein: string;
  businessName: string;
  businessNameSource: string;
  rawWooBillingCompany: string;
  rawCreditBusinessName: string;
  rawFactiivMatchedBusiness: string;
  rawFactiivSummaryBusinessName: string;
  sourceUsed: string;
  fieldSources: Record<string, string>;
};

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text && text !== "Missing" && text !== "-" ? text : "";
}

function normalizePhone(value: unknown) {
  return clean(value);
}

function readPath(source: unknown, path: string[]) {
  let current = source;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function firstField(candidates: Array<{ value: unknown; source: string }>) {
  for (const candidate of candidates) {
    const value = clean(candidate.value);
    if (value) return { value, source: candidate.source };
  }
  return { value: "", source: "" };
}

function sortedOrders(orders: WooCommerceOrderDocument[]) {
  return [...orders].sort((a, b) => new Date(b.dateCreated || 0).getTime() - new Date(a.dateCreated || 0).getTime());
}

function latestOrderWith(orders: WooCommerceOrderDocument[], selector: (order: WooCommerceOrderDocument) => unknown, paidOnly: boolean) {
  return sortedOrders(orders).find((order) => (!paidOnly || order.isPaid) && clean(selector(order))) ?? null;
}

function wooField(orders: WooCommerceOrderDocument[], selector: (order: WooCommerceOrderDocument) => unknown, label: string) {
  const paid = latestOrderWith(orders, selector, true);
  if (paid) return { value: selector(paid), source: `latest paid WooCommerce order ${label}` };
  const latest = latestOrderWith(orders, selector, false);
  if (latest) return { value: selector(latest), source: `latest WooCommerce order ${label}` };
  return { value: "", source: "" };
}

function highConfidenceFactiiv(customer: LeanCustomer) {
  const profile = customer.factiivProfile as Record<string, unknown> | undefined;
  if (!profile) return null;
  const confidence = clean(profile.factiivMatchConfidence).toLowerCase();
  const reason = clean(profile.factiivMatchReason).toLowerCase();
  const matched = Boolean(profile.factiivMatched);
  return matched && (confidence === "high" || reason.includes("email_exact") || reason.includes("business_exact")) ? profile : null;
}

function factiivRawValue(profile: Record<string, unknown> | null, keys: string[]) {
  if (!profile) return "";
  for (const key of keys) {
    const direct = clean(profile[key]);
    if (direct) return direct;
  }
  const raw = clean(profile.rawSummary);
  if (!raw) return "";
  for (const key of keys) {
    const pattern = new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:=]\\s*([^|,\\n]+)`, "i");
    const match = raw.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
  return "";
}

function latestWooCompany(orders: WooCommerceOrderDocument[], paidOnly: boolean) {
  return clean(latestOrderWith(orders, (order) => order.billingCompany, paidOnly)?.billingCompany);
}

function rankingField(ranking: LeanRanking | null | undefined, keys: string[]) {
  if (!ranking) return "";
  const record = ranking as Record<string, unknown>;
  for (const key of keys) {
    const value = clean(record[key]);
    if (value) return value;
  }
  return "";
}

function formatAddress(fields: Pick<BusinessContactFields, "address1" | "address2" | "city" | "state" | "zip">) {
  return [fields.address1, fields.address2, fields.city, fields.state, fields.zip].map(clean).filter(Boolean).join(", ");
}

export function extractBestBusinessContactFields(customer: LeanCustomer, ranking?: LeanRanking | null, wooOrders: WooCommerceOrderDocument[] = []): BusinessContactFields {
  const profile = (customer.businessProfile ?? {}) as Record<string, unknown>;
  const credit = (customer.creditProfile ?? {}) as Record<string, unknown>;
  const factiiv = highConfidenceFactiiv(customer);
  const addressObject = readPath(profile, ["address"]) as Record<string, unknown> | undefined;

  const address1 = firstField([
    { value: readPath(profile, ["billingAddress", "address1"]) || profile.address1 || readPath(profile, ["street"]), source: "Customer.businessProfile.address1" },
    { value: addressObject?.address1 || addressObject?.street, source: "Customer.businessProfile.address" },
    wooField(wooOrders, (order) => order.billingAddress?.address1, "billingAddress.address1"),
    { value: factiivRawValue(factiiv, ["address1", "street", "address"]), source: "Factiiv profile rawSummary address" },
    { value: rankingField(ranking, ["address1", "businessAddress"]), source: "CustomerRanking cached address" },
  ]);
  const address2 = firstField([
    { value: readPath(profile, ["billingAddress", "address2"]) || profile.address2, source: "Customer.businessProfile.address2" },
    { value: addressObject?.address2 || addressObject?.suite, source: "Customer.businessProfile.address" },
    wooField(wooOrders, (order) => order.billingAddress?.address2, "billingAddress.address2"),
    { value: factiivRawValue(factiiv, ["address2", "suite", "unit"]), source: "Factiiv profile rawSummary address2" },
    { value: rankingField(ranking, ["address2"]), source: "CustomerRanking cached address2" },
  ]);
  const city = firstField([
    { value: readPath(profile, ["billingAddress", "city"]) || profile.city, source: "Customer.businessProfile.city" },
    { value: addressObject?.city, source: "Customer.businessProfile.address" },
    wooField(wooOrders, (order) => order.billingAddress?.city, "billingAddress.city"),
    { value: factiivRawValue(factiiv, ["city"]), source: "Factiiv profile rawSummary city" },
    { value: rankingField(ranking, ["city"]), source: "CustomerRanking cached city" },
  ]);
  const state = firstField([
    { value: normalizeStateCode(readPath(profile, ["billingAddress", "state"]) || profile.stateCode || profile.state), source: "Customer.businessProfile.state" },
    { value: normalizeStateCode(addressObject?.state), source: "Customer.businessProfile.address" },
    wooField(wooOrders, (order) => normalizeStateCode(order.billingAddress?.state), "billingAddress.state"),
    { value: normalizeStateCode(factiivRawValue(factiiv, ["state", "stateCode", "businessState"])), source: "Factiiv profile rawSummary state" },
    { value: normalizeStateCode(rankingField(ranking, ["stateCode", "state"])), source: "CustomerRanking cached state" },
  ]);
  const zip = firstField([
    { value: readPath(profile, ["billingAddress", "postcode"]) || profile.zip, source: "Customer.businessProfile.zip" },
    { value: addressObject?.postcode || addressObject?.zip, source: "Customer.businessProfile.address" },
    wooField(wooOrders, (order) => order.billingAddress?.postcode, "billingAddress.postcode"),
    { value: factiivRawValue(factiiv, ["zip", "postcode", "postalCode"]), source: "Factiiv profile rawSummary zip" },
    { value: rankingField(ranking, ["zip", "postcode"]), source: "CustomerRanking cached zip" },
  ]);
  const country = firstField([
    { value: readPath(profile, ["billingAddress", "country"]) || profile.country, source: "Customer.businessProfile.country" },
    { value: addressObject?.country, source: "Customer.businessProfile.address" },
    wooField(wooOrders, (order) => order.billingAddress?.country, "billingAddress.country"),
    { value: factiivRawValue(factiiv, ["country"]), source: "Factiiv profile rawSummary country" },
    { value: rankingField(ranking, ["country"]), source: "CustomerRanking cached country" },
  ]);
  const phoneNumber = firstField([
    { value: normalizePhone(profile.phone), source: "Customer.businessProfile.phone" },
    wooField(wooOrders, (order) => order.billingPhone, "billingPhone"),
    { value: normalizePhone(factiivRawValue(factiiv, ["phone", "telephone", "phoneNumber"])), source: "Factiiv profile phone" },
    { value: normalizePhone(rankingField(ranking, ["phone"])), source: "CustomerRanking.phone" },
    { value: normalizePhone(customer.phone), source: "Customer.phone" },
  ]);
  const ein = firstField([
    { value: profile.ein, source: "Customer.businessProfile.ein" },
    wooField(wooOrders, (order) => order.rawSafeMeta?.find((meta) => /ein|tax/i.test(meta.key))?.value, "meta EIN"),
    { value: credit.ein, source: "Customer.creditProfile.ein" },
    { value: rankingField(ranking, ["ein"]), source: "CustomerRanking cached EIN" },
  ]);
  const rawWooBillingCompany = latestWooCompany(wooOrders, true) || latestWooCompany(wooOrders, false);
  const rawCreditBusinessName = clean(credit.company || credit.businessName);
  const rawFactiivMatchedBusiness = clean(factiiv?.matchedBusinessName);
  const rawFactiivSummaryBusinessName = factiivRawValue(factiiv, ["businessName", "business_name", "company", "matchedBusinessName"]);
  const businessName = firstField([
    { value: profile.businessName, source: "Customer.businessProfile.businessName" },
    { value: profile.company, source: "Customer.businessProfile.company" },
    { value: profile.dba, source: "Customer.businessProfile.dba" },
    wooField(wooOrders, (order) => order.billingCompany, "billingCompany"),
    { value: rawCreditBusinessName, source: "Customer.creditProfile.company" },
    { value: rawFactiivMatchedBusiness, source: "Factiiv matched business name" },
    { value: rawFactiivSummaryBusinessName, source: "Factiiv rawSummary businessName" },
    { value: ranking?.businessName, source: "CustomerRanking.businessName" },
  ]);
  const email = firstField([
    { value: profile.email, source: "Customer.businessProfile.email" },
    { value: customer.email || customer.normalizedEmail, source: "Customer.email" },
    wooField(wooOrders, (order) => order.billingEmail || order.normalizedEmail, "billingEmail"),
  ]);

  const fields = {
    address1: address1.value,
    address2: address2.value,
    city: city.value,
    state: state.value,
    zip: zip.value,
    country: country.value,
    phoneNumber: phoneNumber.value,
    email: email.value,
    ein: ein.value,
    businessName: businessName.value,
    businessNameSource: businessName.source,
    rawWooBillingCompany,
    rawCreditBusinessName,
    rawFactiivMatchedBusiness,
    rawFactiivSummaryBusinessName,
  };
  const businessAddress = formatAddress(fields);
  const fieldSources = {
    address1: address1.source,
    address2: address2.source,
    city: city.source,
    state: state.source,
    zip: zip.source,
    country: country.source,
    phoneNumber: phoneNumber.source,
    email: email.source,
    ein: ein.source,
    businessName: businessName.source,
    businessAddress: [address1.source, address2.source, city.source, state.source, zip.source].filter(Boolean).join(", "),
  };

  return {
    businessAddress,
    ...fields,
    sourceUsed: Array.from(new Set(Object.values(fieldSources).filter(Boolean))).join("; "),
    fieldSources,
  };
}
