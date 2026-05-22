import { normalizePhone } from "@/lib/wooOrderImport";
import type { CustomerBusinessProfile } from "@/models/Customer";

const wpStoreUrl = process.env.WP_STORE_URL ?? "";
const wpUsername = process.env.WP_APPLICATION_USERNAME ?? "";
const wpPassword = process.env.WP_APPLICATION_PASSWORD ?? "";
const wcStoreUrl = process.env.WC_STORE_URL ?? wpStoreUrl;
const wcConsumerKey = process.env.WC_CONSUMER_KEY ?? "";
const wcConsumerSecret = process.env.WC_CONSUMER_SECRET ?? "";

type WpRecord = Record<string, unknown>;
type ProfileSource = "wordpress_users" | "woocommerce_customers";
const profileFetchTimeoutMs = 60000;
const wooRequestDelayMs = 200;
const sensitiveMetaPattern = /(password|secret|token|nonce|signature|cvv|cvc|api[_-]?key|consumer[_-]?key|consumer[_-]?secret)/i;

export type WordPressProfileUser = {
  id: number;
  name: string;
  email: string;
  normalizedEmail: string;
  profile: CustomerBusinessProfile;
};

type MetaInspectEntry = {
  key: string;
  normalizedKey: string;
  namespace: string;
  rawType: string;
  rawValue: string;
  serializedValue: string;
  value: unknown;
};

type CreditMetaDetection = {
  detectedCreditMetaKeys: string[];
  rejectedCandidateKeys: string[];
  selectedApprovedCreditKey: string;
  selectedAvailableCreditKey: string;
  selectedOutstandingKey: string;
  selectedEinKey: string;
  selectedCreditStatusKey: string;
  selectedLastBillDateKey: string;
  selectedNextBillingDateKey: string;
  parsedNumericValues: Record<string, number>;
  approvedCredits: number;
  availableCredit: number;
  outstandingBalance: number;
  potentialCreditLimit: number;
  creditLimit: number;
  creditStatus: string;
  lastBillDate: string;
  nextBillingDate: string;
  ein: string;
  verified: boolean;
  fallbackReason: string;
  pluginNamespaceKeys: Record<string, string[]>;
  entries: MetaInspectEntry[];
};

function hasMeaningfulText(value: unknown) {
  return String(value ?? "").trim().length > 0;
}

function positiveNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export class ProfileSourceError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class ProfileTimeoutError extends Error {
  constructor() {
    super("Request timed out during batch fetch");
  }
}

export function asRecord(value: unknown): WpRecord {
  return value && typeof value === "object" ? value as WpRecord : {};
}

function asString(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function asNumber(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeEmail(value: unknown) {
  return asString(value).toLowerCase();
}

function metaValue(meta: WpRecord, keys: string[]) {
  const lowerMeta = Object.fromEntries(Object.entries(meta).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lowerMeta[key.toLowerCase()];
    if (Array.isArray(value) && value.length) return asString(value[0]);
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function normalizeMetaKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function keyNamespace(key: string) {
  const normalized = normalizeMetaKey(key);
  const [first] = normalized.split("_");
  return first || "root";
}

function safeMetaOutput(key: string, value: unknown) {
  if (sensitiveMetaPattern.test(key)) return "[redacted]";
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function parsePhpSerialized(value: string): unknown {
  let index = 0;

  function expect(char: string) {
    if (value[index] !== char) throw new Error(`Expected ${char}`);
    index += 1;
  }

  function readUntil(delimiter: string) {
    const start = index;
    const end = value.indexOf(delimiter, index);
    if (end < 0) throw new Error(`Missing delimiter ${delimiter}`);
    index = end + delimiter.length;
    return value.slice(start, end);
  }

  function parseValue(): unknown {
    const type = value[index];
    index += 2; // skip type and :
    switch (type) {
      case "N":
        return null;
      case "b":
        return readUntil(";") === "1";
      case "i":
        return Number(readUntil(";"));
      case "d":
        return Number(readUntil(";"));
      case "s": {
        const len = Number(readUntil(":"));
        expect('"');
        const str = value.slice(index, index + len);
        index += len;
        expect('"');
        expect(";");
        return str;
      }
      case "a": {
        const len = Number(readUntil(":"));
        expect("{");
        const result: Record<string, unknown> = {};
        const list: unknown[] = [];
        let sequential = true;
        for (let i = 0; i < len; i += 1) {
          const key = parseValue();
          const entry = parseValue();
          if (typeof key === "number" && key === i) {
            list.push(entry);
          } else {
            sequential = false;
            result[String(key)] = entry;
          }
        }
        expect("}");
        return sequential ? list : result;
      }
      default:
        throw new Error(`Unsupported serialized type ${type}`);
    }
  }

  try {
    if (!/^[abdisNO]:/.test(value)) return value;
    return parseValue();
  } catch {
    return value;
  }
}

function decodeMetaValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  if (/^[abdisNO]:/.test(trimmed)) return parsePhpSerialized(trimmed);
  return value;
}

function flattenMetaEntries(meta: WpRecord, prefix = ""): MetaInspectEntry[] {
  const entries: MetaInspectEntry[] = [];
  for (const [rawKey, rawValue] of Object.entries(meta)) {
    const path = prefix ? `${prefix}.${rawKey}` : rawKey;
    const decoded = decodeMetaValue(rawValue);
    const normalizedKey = normalizeMetaKey(path);
    entries.push({
      key: path,
      normalizedKey,
      namespace: keyNamespace(path),
      rawType: Array.isArray(rawValue) ? "array" : rawValue === null ? "null" : typeof rawValue,
      rawValue: safeMetaOutput(path, rawValue),
      serializedValue: rawValue !== decoded ? safeMetaOutput(path, decoded) : "",
      value: decoded,
    });
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      entries.push(...flattenMetaEntries(decoded as WpRecord, path));
    }
    if (Array.isArray(decoded)) {
      decoded.forEach((item, index) => {
        if (item && typeof item === "object") {
          entries.push(...flattenMetaEntries(asRecord(item), `${path}.${index}`));
        } else {
          entries.push({
            key: `${path}.${index}`,
            normalizedKey: normalizeMetaKey(`${path}.${index}`),
            namespace: keyNamespace(path),
            rawType: item === null ? "null" : typeof item,
            rawValue: safeMetaOutput(`${path}.${index}`, item),
            serializedValue: "",
            value: item,
          });
        }
      });
    }
  }
  return entries;
}

function scoreMetaEntry(entry: MetaInspectEntry, kind: "approved" | "available" | "outstanding" | "ein" | "status" | "lastBill" | "nextBill") {
  const key = entry.normalizedKey;
  const valueText = String(entry.rawValue ?? "").toLowerCase();
  let score = 0;
  if (kind === "approved") {
    if (key.includes("approved")) score += 6;
    if (key.includes("credit")) score += 4;
    if (key.includes("limit")) score += 4;
    if (key.includes("available")) score -= 4;
  }
  if (kind === "available") {
    if (key.includes("available")) score += 7;
    if (key.includes("credit")) score += 4;
    if (key.includes("limit")) score += 2;
  }
  if (kind === "outstanding") {
    if (key.includes("outstanding")) score += 7;
    if (key.includes("balance")) score += 5;
    if (key.includes("due")) score += 2;
  }
  if (kind === "ein") {
    if (/(^|_)ein($|_)/.test(key)) score += 10;
    if (key.includes("tax_id") || key.includes("federal_tax")) score += 7;
  }
  if (kind === "status") {
    if (key.includes("status")) score += 5;
    if (key.includes("credit")) score += 4;
    if (key.includes("net30")) score += 3;
    if (valueText.includes("approved") || valueText.includes("active")) score += 1;
  }
  if (kind === "lastBill") {
    if (key.includes("last_bill")) score += 8;
    if (key.includes("last_billing")) score += 8;
  }
  if (kind === "nextBill") {
    if (key.includes("next_bill")) score += 8;
    if (key.includes("next_billing")) score += 8;
  }
  const numericValue = asNumber(entry.rawValue);
  if (["approved", "available", "outstanding"].includes(kind) && numericValue > 0) score += 1;
  return score;
}

function pickBestMetaEntry(entries: MetaInspectEntry[], kind: "approved" | "available" | "outstanding" | "ein" | "status" | "lastBill" | "nextBill") {
  return [...entries]
    .map((entry) => ({ entry, score: scoreMetaEntry(entry, kind) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.key.length - a.entry.key.length)[0]?.entry;
}

export function inspectCreditMeta(meta: WpRecord): CreditMetaDetection {
  const entries = flattenMetaEntries(meta);
  const approvedEntry = pickBestMetaEntry(entries, "approved");
  const availableEntry = pickBestMetaEntry(entries, "available");
  const outstandingEntry = pickBestMetaEntry(entries, "outstanding");
  const einEntry = pickBestMetaEntry(entries, "ein");
  const statusEntry = pickBestMetaEntry(entries, "status");
  const lastBillEntry = pickBestMetaEntry(entries, "lastBill");
  const nextBillEntry = pickBestMetaEntry(entries, "nextBill");
  const pluginNamespaceKeys = entries.reduce<Record<string, string[]>>((acc, entry) => {
    if (!/(credit|approved|available|outstanding|balance|bill|ein|net30|account_status|subscription)/i.test(entry.normalizedKey)) return acc;
    acc[entry.namespace] = Array.from(new Set([...(acc[entry.namespace] ?? []), entry.key]));
    return acc;
  }, {});
  const detectedCreditMetaKeys = Array.from(new Set(entries
    .filter((entry) => /(credit|approved|available|outstanding|balance|bill|ein|net30|account_status|subscription)/i.test(entry.normalizedKey))
    .map((entry) => entry.key)));
  const selectedKeys = new Set([
    approvedEntry?.key,
    availableEntry?.key,
    outstandingEntry?.key,
    einEntry?.key,
    statusEntry?.key,
    lastBillEntry?.key,
    nextBillEntry?.key,
  ].filter(Boolean));
  const rejectedCandidateKeys = detectedCreditMetaKeys.filter((key) => !selectedKeys.has(key));
  const approvedCredits = asNumber(approvedEntry?.rawValue);
  const availableCredit = asNumber(availableEntry?.rawValue);
  const outstandingBalance = asNumber(outstandingEntry?.rawValue);
  const potentialCreditLimit = Math.max(approvedCredits, asNumber(metaValue(meta, ["potential_credit_limit", "max_approved_credit"])));
  const creditLimit = approvedCredits || asNumber(metaValue(meta, ["credit_limit", "my_credit_limit"]));
  const verified = approvedCredits > 0 || availableCredit > 0;
  const fallbackReason = verified
    ? ""
    : detectedCreditMetaKeys.length
      ? "Credit-related meta keys were found, but none exposed a verified approved or available credit value."
      : "No credit-related WordPress or WooCommerce meta keys were exposed for this customer.";
  return {
    detectedCreditMetaKeys,
    rejectedCandidateKeys,
    selectedApprovedCreditKey: approvedEntry?.key ?? "",
    selectedAvailableCreditKey: availableEntry?.key ?? "",
    selectedOutstandingKey: outstandingEntry?.key ?? "",
    selectedEinKey: einEntry?.key ?? "",
    selectedCreditStatusKey: statusEntry?.key ?? "",
    selectedLastBillDateKey: lastBillEntry?.key ?? "",
    selectedNextBillingDateKey: nextBillEntry?.key ?? "",
    parsedNumericValues: {
      approvedCredits,
      availableCredit,
      outstandingBalance,
      potentialCreditLimit,
      creditLimit,
    },
    approvedCredits,
    availableCredit,
    outstandingBalance,
    potentialCreditLimit,
    creditLimit,
    creditStatus: String(statusEntry?.rawValue ?? ""),
    lastBillDate: String(lastBillEntry?.rawValue ?? ""),
    nextBillingDate: String(nextBillEntry?.rawValue ?? ""),
    ein: String(einEntry?.rawValue ?? metaValue(meta, ["ein"])),
    verified,
    fallbackReason,
    pluginNamespaceKeys,
    entries,
  };
}

const approvedCreditKeys = [
  "approved_credits",
  "approved_credit",
  "approvedcredits",
  "approved_credit_limit",
  "approved_limit",
  "max_approved_credit",
  "credit_limit",
  "my_credit_limit",
];

const availableCreditKeys = [
  "available_credits",
  "available_credit",
  "availablecredits",
  "available_credit_limit",
];

const outstandingCreditKeys = [
  "total_outstanding",
  "outstanding_balance",
  "outstanding",
  "outstanding_total",
];

const lastBillDateKeys = [
  "last_bill_date",
  "last_billing_date",
];

const nextBillDateKeys = [
  "next_bill_date",
  "next_billing_date",
];

const creditStatusKeys = [
  "credit_status",
  "credits_status",
  "net30_status",
  "account_status",
];

function resolveCreditProfile(meta: WpRecord) {
  const detected = inspectCreditMeta(meta);
  const approvedCredits = detected.verified ? (detected.approvedCredits || asNumber(metaValue(meta, approvedCreditKeys))) : 0;
  const availableCredit = detected.verified ? (detected.availableCredit || asNumber(metaValue(meta, availableCreditKeys))) : 0;
  const outstandingBalance = detected.verified ? (detected.outstandingBalance || asNumber(metaValue(meta, outstandingCreditKeys))) : 0;
  const potentialCreditLimit = Math.max(
    approvedCredits,
    detected.verified ? detected.potentialCreditLimit : 0,
    detected.verified ? asNumber(metaValue(meta, ["potential_credit_limit", "max_approved_credit"])) : 0
  );
  const creditLimit = approvedCredits || (detected.verified ? detected.creditLimit || asNumber(metaValue(meta, ["credit_limit", "my_credit_limit"])) : 0);
  return {
    approvedCredits,
    availableCredit,
    outstandingBalance,
    potentialCreditLimit,
    creditLimit,
    creditStatus: detected.creditStatus || metaValue(meta, creditStatusKeys),
    lastBillDate: detected.lastBillDate || metaValue(meta, lastBillDateKeys),
    nextBillingDate: detected.nextBillingDate || metaValue(meta, nextBillDateKeys),
    ein: detected.ein || metaValue(meta, ["ein"]),
    creditMetaVerified: detected.verified,
    creditMetaSource: detected.verified ? "wordpress_meta" : "unknown",
    creditFallbackReason: detected.fallbackReason,
    detection: detected,
  };
}

function authHeader() {
  return `Basic ${Buffer.from(`${wpUsername}:${wpPassword}`).toString("base64")}`;
}

function wooAuthHeader() {
  if (wcConsumerKey && wcConsumerSecret) return `Basic ${Buffer.from(`${wcConsumerKey}:${wcConsumerSecret}`).toString("base64")}`;
  return authHeader();
}

function metaDataObject(value: unknown) {
  const result: WpRecord = {};
  if (!Array.isArray(value)) return result;
  for (const item of value.map(asRecord)) {
    const key = asString(item.key).toLowerCase();
    if (key) result[key] = item.value;
  }
  return result;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithStatus(url: string, headers: HeadersInit, signal?: AbortSignal, timeoutMs = profileFetchTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let response: Response;
  try {
    response = await fetch(url, { headers, cache: "no-store", signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ProfileTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  if (!response.ok) throw new ProfileSourceError(`${response.status} ${response.statusText}`, response.status);
  const data = await response.json() as unknown[];
  return { data, total: Number(response.headers.get("x-wp-total") ?? 0), status: response.status };
}

async function fetchJsonWithRetry(url: string, headers: HeadersInit, signal?: AbortSignal, delayBeforeFetch = 0) {
  if (delayBeforeFetch > 0) await delay(delayBeforeFetch);
  try {
    return await fetchJsonWithStatus(url, headers, signal);
  } catch (error) {
    if (error instanceof ProfileTimeoutError) {
      return fetchJsonWithStatus(url, headers, signal);
    }
    throw error;
  }
}

async function fetchUnknownWithStatus(url: string, headers: HeadersInit, signal?: AbortSignal, timeoutMs = profileFetchTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let response: Response;
  try {
    response = await fetch(url, { headers, cache: "no-store", signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ProfileTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
  if (!response.ok) throw new ProfileSourceError(`${response.status} ${response.statusText}`, response.status);
  return { data: await response.json(), status: response.status };
}

export function isWordPressProfileImportConfigured() {
  return Boolean(wpStoreUrl && wpUsername && wpPassword);
}

export function isWooCommerceCustomerFallbackConfigured() {
  return Boolean((wcStoreUrl || wpStoreUrl) && ((wcConsumerKey && wcConsumerSecret) || (wpUsername && wpPassword)));
}

export function normalizeWordPressProfileUser(user: WpRecord, importedAt = new Date().toISOString()): WordPressProfileUser {
  const meta = { ...asRecord(user.meta), ...asRecord(user.acf), ...asRecord(user.billing) };
  const credit = resolveCreditProfile(meta);
  const firstName = metaValue(meta, ["first_name", "billing_first_name"]) || asString(user.first_name);
  const lastName = metaValue(meta, ["last_name", "billing_last_name"]) || asString(user.last_name);
  const email = normalizeEmail(metaValue(meta, ["billing_email"]) || user.email);
  const company = metaValue(meta, ["billing_company", "business_name", "company"]);
  const phone = normalizePhone(metaValue(meta, ["billing_phone", "phone"]));
  const address1 = metaValue(meta, ["billing_address_1", "business_address"]);
  return {
    id: Number(user.id ?? 0),
    name: asString(user.name) || `${firstName} ${lastName}`.trim(),
    email,
    normalizedEmail: email,
    profile: {
      firstName,
      lastName,
      company,
      dba: metaValue(meta, ["dba", "doing_business_as"]),
      email,
      phone,
      address1,
      address2: metaValue(meta, ["billing_address_2"]),
      shippingAddress1: metaValue(meta, ["shipping_address_1"]),
      shippingAddress2: metaValue(meta, ["shipping_address_2"]),
      shippingCity: metaValue(meta, ["shipping_city"]),
      shippingState: metaValue(meta, ["shipping_state"]),
      shippingZip: metaValue(meta, ["shipping_postcode"]),
      shippingCountry: metaValue(meta, ["shipping_country"]),
      city: metaValue(meta, ["billing_city"]),
      state: metaValue(meta, ["billing_state"]),
      zip: metaValue(meta, ["billing_postcode"]),
      country: metaValue(meta, ["billing_country"]),
      website: metaValue(meta, ["website", "business_website"]),
      sourcePlatform: "wordpress",
      customerSince: asString(user.registered_date || user.date),
      lastActivity: importedAt,
      ein: credit.ein || metaValue(meta, ["ein"]),
      approvedCredits: credit.approvedCredits,
      availableCredit: credit.availableCredit,
      outstandingBalance: credit.outstandingBalance,
      creditStatus: credit.creditStatus,
      creditMetaVerified: credit.creditMetaVerified,
      creditMetaSource: credit.creditMetaSource,
      creditFallbackReason: credit.creditFallbackReason,
      potentialCreditLimit: credit.potentialCreditLimit,
      creditLimit: credit.creditLimit,
      creditLimitLastUpdated: metaValue(meta, ["last_credit_limit_update"]),
      lastBillDate: credit.lastBillDate,
      nextBillingDate: credit.nextBillingDate,
      net30Status: metaValue(meta, ["net30_status"]),
      accountStatus: metaValue(meta, ["account_status"]),
      businessType: metaValue(meta, ["business_type"]),
      industry: metaValue(meta, ["industry"]),
      industryClassification: metaValue(meta, ["industry_classification", "industryClassification"]),
      naicsCode: metaValue(meta, ["naics", "naics_code", "naicsCode"]),
      sicCode: metaValue(meta, ["sic", "sic_code", "sicCode"]),
      fundingReadinessScore: asNumber(metaValue(meta, ["funding_readiness_score", "fundingReadinessScore"])),
      fundingReadinessTier: metaValue(meta, ["funding_readiness_tier", "fundingReadinessTier"]),
      source: "wordpress_user_meta",
      importedAt,
    },
  };
}

export function normalizeWooCommerceProfileCustomer(customer: WpRecord, importedAt = new Date().toISOString()): WordPressProfileUser {
  const billing = asRecord(customer.billing);
  const shipping = asRecord(customer.shipping);
  const meta = { ...metaDataObject(customer.meta_data), ...asRecord(customer.meta), ...asRecord(customer.acf) };
  const credit = resolveCreditProfile(meta);
  const firstName = asString(customer.first_name || billing.first_name);
  const lastName = asString(customer.last_name || billing.last_name);
  const email = normalizeEmail(customer.email || billing.email || metaValue(meta, ["billing_email"]));
  const company = asString(billing.company) || metaValue(meta, ["billing_company", "business_name", "company"]);
  const phone = normalizePhone(asString(billing.phone) || metaValue(meta, ["billing_phone", "phone"]));
  return {
    id: Number(customer.id ?? 0),
    name: `${firstName} ${lastName}`.trim() || asString(customer.username || customer.email),
    email,
    normalizedEmail: email,
    profile: {
      firstName,
      lastName,
      company,
      dba: metaValue(meta, ["dba", "doing_business_as"]),
      email,
      phone,
      address1: asString(billing.address_1) || metaValue(meta, ["billing_address_1", "business_address"]),
      address2: asString(billing.address_2) || metaValue(meta, ["billing_address_2"]),
      shippingAddress1: asString(shipping.address_1) || metaValue(meta, ["shipping_address_1"]),
      shippingAddress2: asString(shipping.address_2) || metaValue(meta, ["shipping_address_2"]),
      shippingCity: asString(shipping.city) || metaValue(meta, ["shipping_city"]),
      shippingState: asString(shipping.state) || metaValue(meta, ["shipping_state"]),
      shippingZip: asString(shipping.postcode) || metaValue(meta, ["shipping_postcode"]),
      shippingCountry: asString(shipping.country) || metaValue(meta, ["shipping_country"]),
      city: asString(billing.city) || metaValue(meta, ["billing_city"]),
      state: asString(billing.state) || metaValue(meta, ["billing_state"]),
      zip: asString(billing.postcode) || metaValue(meta, ["billing_postcode"]),
      country: asString(billing.country) || metaValue(meta, ["billing_country"]),
      website: metaValue(meta, ["website", "business_website"]),
      sourcePlatform: "woocommerce",
      customerSince: asString(customer.date_created),
      lastActivity: asString(customer.date_modified) || importedAt,
      ein: credit.ein || metaValue(meta, ["ein"]),
      approvedCredits: credit.approvedCredits,
      availableCredit: credit.availableCredit,
      outstandingBalance: credit.outstandingBalance,
      creditStatus: credit.creditStatus,
      creditMetaVerified: credit.creditMetaVerified,
      creditMetaSource: credit.creditMetaSource,
      creditFallbackReason: credit.creditFallbackReason,
      potentialCreditLimit: credit.potentialCreditLimit,
      creditLimit: credit.creditLimit,
      creditLimitLastUpdated: metaValue(meta, ["last_credit_limit_update"]),
      lastBillDate: credit.lastBillDate,
      nextBillingDate: credit.nextBillingDate,
      net30Status: metaValue(meta, ["net30_status"]),
      accountStatus: metaValue(meta, ["account_status"]),
      businessType: metaValue(meta, ["business_type"]),
      industry: metaValue(meta, ["industry"]),
      industryClassification: metaValue(meta, ["industry_classification", "industryClassification"]),
      naicsCode: metaValue(meta, ["naics", "naics_code", "naicsCode"]),
      sicCode: metaValue(meta, ["sic", "sic_code", "sicCode"]),
      fundingReadinessScore: asNumber(metaValue(meta, ["funding_readiness_score", "fundingReadinessScore"])),
      fundingReadinessTier: metaValue(meta, ["funding_readiness_tier", "fundingReadinessTier"]),
      source: "woocommerce_customer",
      importedAt,
    },
  };
}

export function mergeBusinessProfile(existing: Partial<CustomerBusinessProfile> | undefined, incoming: Partial<CustomerBusinessProfile>, importedAt: string) {
  const current = existing ?? {};
  return {
    ...current,
    ...incoming,
    firstName: hasMeaningfulText(incoming.firstName) ? incoming.firstName : current.firstName || "",
    lastName: hasMeaningfulText(incoming.lastName) ? incoming.lastName : current.lastName || "",
    company: hasMeaningfulText(incoming.company) ? incoming.company : current.company || "",
    dba: hasMeaningfulText(incoming.dba) ? incoming.dba : current.dba || "",
    email: hasMeaningfulText(incoming.email) ? incoming.email : current.email || "",
    phone: hasMeaningfulText(incoming.phone) ? incoming.phone : current.phone || "",
    address1: hasMeaningfulText(incoming.address1) ? incoming.address1 : current.address1 || "",
    address2: hasMeaningfulText(incoming.address2) ? incoming.address2 : current.address2 || "",
    shippingAddress1: hasMeaningfulText(incoming.shippingAddress1) ? incoming.shippingAddress1 : current.shippingAddress1 || "",
    shippingAddress2: hasMeaningfulText(incoming.shippingAddress2) ? incoming.shippingAddress2 : current.shippingAddress2 || "",
    shippingCity: hasMeaningfulText(incoming.shippingCity) ? incoming.shippingCity : current.shippingCity || "",
    shippingState: hasMeaningfulText(incoming.shippingState) ? incoming.shippingState : current.shippingState || "",
    shippingZip: hasMeaningfulText(incoming.shippingZip) ? incoming.shippingZip : current.shippingZip || "",
    shippingCountry: hasMeaningfulText(incoming.shippingCountry) ? incoming.shippingCountry : current.shippingCountry || "",
    city: hasMeaningfulText(incoming.city) ? incoming.city : current.city || "",
    state: hasMeaningfulText(incoming.state) ? incoming.state : current.state || "",
    zip: hasMeaningfulText(incoming.zip) ? incoming.zip : current.zip || "",
    country: hasMeaningfulText(incoming.country) ? incoming.country : current.country || "",
    website: hasMeaningfulText(incoming.website) ? incoming.website : current.website || "",
    sourcePlatform: hasMeaningfulText(incoming.sourcePlatform) ? incoming.sourcePlatform : current.sourcePlatform || "",
    customerSince: hasMeaningfulText(incoming.customerSince) ? incoming.customerSince : current.customerSince || "",
    lastActivity: hasMeaningfulText(incoming.lastActivity) ? incoming.lastActivity : current.lastActivity || importedAt,
    ein: hasMeaningfulText(incoming.ein) ? incoming.ein : current.ein || "",
    approvedCredits: positiveNumber(incoming.approvedCredits) || positiveNumber(current.approvedCredits),
    availableCredit: positiveNumber(incoming.availableCredit) || positiveNumber(current.availableCredit),
    outstandingBalance: positiveNumber(incoming.outstandingBalance) || positiveNumber(current.outstandingBalance),
    creditStatus: hasMeaningfulText(incoming.creditStatus) ? incoming.creditStatus : current.creditStatus || "",
    creditMetaVerified: incoming.creditMetaVerified === true || current.creditMetaVerified === true,
    creditMetaSource: hasMeaningfulText(incoming.creditMetaSource) ? incoming.creditMetaSource : current.creditMetaSource || "",
    creditFallbackReason: hasMeaningfulText(incoming.creditFallbackReason) ? incoming.creditFallbackReason : current.creditFallbackReason || "",
    potentialCreditLimit: positiveNumber(incoming.potentialCreditLimit) || positiveNumber(incoming.approvedCredits) || positiveNumber(current.potentialCreditLimit) || positiveNumber(current.approvedCredits),
    creditLimit: positiveNumber(incoming.creditLimit) || positiveNumber(incoming.approvedCredits) || positiveNumber(current.creditLimit) || positiveNumber(current.approvedCredits),
    creditLimitLastUpdated: hasMeaningfulText(incoming.creditLimitLastUpdated) ? incoming.creditLimitLastUpdated : current.creditLimitLastUpdated || "",
    lastBillDate: hasMeaningfulText(incoming.lastBillDate) ? incoming.lastBillDate : current.lastBillDate || "",
    nextBillingDate: hasMeaningfulText(incoming.nextBillingDate) ? incoming.nextBillingDate : current.nextBillingDate || "",
    net30Status: hasMeaningfulText(incoming.net30Status) ? incoming.net30Status : current.net30Status || "",
    accountStatus: hasMeaningfulText(incoming.accountStatus) ? incoming.accountStatus : current.accountStatus || "",
    businessType: hasMeaningfulText(incoming.businessType) ? incoming.businessType : current.businessType || "",
    industry: hasMeaningfulText(incoming.industry) ? incoming.industry : current.industry || "",
    industryClassification: hasMeaningfulText(incoming.industryClassification) ? incoming.industryClassification : current.industryClassification || "",
    naicsCode: hasMeaningfulText(incoming.naicsCode) ? incoming.naicsCode : current.naicsCode || "",
    sicCode: hasMeaningfulText(incoming.sicCode) ? incoming.sicCode : current.sicCode || "",
    fundingReadinessScore: positiveNumber(incoming.fundingReadinessScore) || positiveNumber(current.fundingReadinessScore),
    fundingReadinessTier: hasMeaningfulText(incoming.fundingReadinessTier) ? incoming.fundingReadinessTier : current.fundingReadinessTier || "",
    source: hasMeaningfulText(incoming.source) ? incoming.source : current.source || "",
    importedAt,
  } satisfies Partial<CustomerBusinessProfile>;
}

export function deriveCustomerCreditLimits(profile: Partial<CustomerBusinessProfile>, currentActual?: number | null, currentEstimated?: number) {
  if (profile.creditMetaVerified !== true) {
    return {
      actualCreditLimit: currentActual ?? null,
      estimatedCreditLimit: currentEstimated ?? 0,
    };
  }
  const approved = positiveNumber(profile.approvedCredits);
  const explicitCredit = positiveNumber(profile.creditLimit);
  const explicitPotential = positiveNumber(profile.potentialCreditLimit);
  return {
    actualCreditLimit: approved || explicitCredit || currentActual || null,
    estimatedCreditLimit: Math.max(approved, explicitPotential, explicitCredit, positiveNumber(currentEstimated)),
  };
}

export async function fetchWordPressProfileUsers({ limit, offset, signal }: { limit: number; offset: number; signal?: AbortSignal }) {
  if (!isWordPressProfileImportConfigured()) throw new Error("WordPress profile import is not configured.");
  const safeLimit = Math.min(25, Math.max(1, limit));
  const base = wpStoreUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/wp-json/wp/v2/users`);
  url.searchParams.set("context", "edit");
  url.searchParams.set("per_page", String(safeLimit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("_fields", "id,name,email,first_name,last_name,meta,acf,billing");
  const { data: users, total } = await fetchJsonWithRetry(url.toString(), { Authorization: authHeader(), Accept: "application/json" }, signal);
  return {
    users: users.map((user) => normalizeWordPressProfileUser(asRecord(user))).filter((user) => user.id || user.email),
    total,
    sourceUsed: "wordpress_users" as ProfileSource,
  };
}

export async function fetchWooCommerceProfileCustomers({ limit, offset, signal }: { limit: number; offset: number; signal?: AbortSignal }) {
  if (!isWooCommerceCustomerFallbackConfigured()) throw new Error("WooCommerce customer fallback is not configured.");
  const safeLimit = Math.min(25, Math.max(1, limit));
  const base = (wcStoreUrl || wpStoreUrl).replace(/\/+$/, "");
  const page = Math.floor(offset / safeLimit) + 1;
  const url = new URL(`${base}/wp-json/wc/v3/customers`);
  url.searchParams.set("per_page", String(safeLimit));
  url.searchParams.set("page", String(page));
  url.searchParams.set("_fields", "id,email,username,first_name,last_name,billing,meta_data,meta,acf");
  const { data: customers, total } = await fetchJsonWithRetry(url.toString(), { Authorization: wooAuthHeader(), Accept: "application/json" }, signal, wooRequestDelayMs);
  return {
    users: customers.map((customer) => normalizeWooCommerceProfileCustomer(asRecord(customer))).filter((user) => user.id || user.email),
    total,
    sourceUsed: "woocommerce_customers" as ProfileSource,
  };
}

export async function fetchProfileUsersWithFallback({ limit, offset, signal }: { limit: number; offset: number; signal?: AbortSignal }) {
  const warnings: string[] = [];
  if (isWordPressProfileImportConfigured()) {
    try {
      return { ...(await fetchWordPressProfileUsers({ limit, offset, signal })), warnings };
    } catch (error) {
      if (error instanceof ProfileSourceError && [401, 403, 404].includes(error.status)) {
        warnings.push("WP users endpoint unavailable, used WooCommerce customers fallback.");
      } else {
        throw error;
      }
    }
  }
  const fallback = await fetchWooCommerceProfileCustomers({ limit, offset, signal });
  return { ...fallback, warnings };
}

function sanitizeDebugRecord(record: WpRecord) {
  const sanitized: WpRecord = {};
  for (const [key, value] of Object.entries(record)) {
    sanitized[key] = sensitiveMetaPattern.test(key) ? "[redacted]" : value;
  }
  return sanitized;
}

function metaEntriesForDebug(meta: WpRecord) {
  const inspection = inspectCreditMeta(meta);
  const selectedKeyMap = new Map<string, string>(
    [
      [inspection.selectedApprovedCreditKey, "selected_approved"],
      [inspection.selectedAvailableCreditKey, "selected_available"],
      [inspection.selectedOutstandingKey, "selected_outstanding"],
      [inspection.selectedEinKey, "selected_ein"],
      [inspection.selectedCreditStatusKey, "selected_status"],
      [inspection.selectedLastBillDateKey, "selected_last_bill"],
      [inspection.selectedNextBillingDateKey, "selected_next_bill"],
    ].filter(([key]) => Boolean(key)) as [string, string][]
  );
  const rejected = new Set(inspection.rejectedCandidateKeys);
  return inspection.entries.map((entry) => ({
    key: entry.key,
    namespace: entry.namespace,
    rawType: entry.rawType,
    rawValue: entry.rawValue,
    serializedValue: entry.serializedValue,
    parsedValue: typeof entry.value === "string" ? entry.value.slice(0, 500) : safeMetaOutput(entry.key, entry.value),
    parsedNumericValue: asNumber(entry.value),
    selectedStatus: selectedKeyMap.get(entry.key) ?? (rejected.has(entry.key) ? "rejected_candidate" : "ignored"),
  }));
}

export async function fetchCustomerCreditMetaDebug({ email, userId, signal }: { email?: string; userId?: string; signal?: AbortSignal }) {
  const warnings: string[] = [];
  const base = (wcStoreUrl || wpStoreUrl).replace(/\/+$/, "");
  if (!base) throw new Error("WordPress/WooCommerce profile source is not configured.");

  const wpHeaders: HeadersInit = { Authorization: authHeader(), Accept: "application/json" };
  const wooHeaders: HeadersInit = { Authorization: wooAuthHeader(), Accept: "application/json" };

  let wpUser: WpRecord | null = null;
  let wooCustomer: WpRecord | null = null;
  let wooOrders: WpRecord[] = [];
  let wooSubscriptions: WpRecord[] = [];

  if (isWordPressProfileImportConfigured()) {
    try {
      if (userId) {
        const userUrl = `${wpStoreUrl.replace(/\/+$/, "")}/wp-json/wp/v2/users/${encodeURIComponent(userId)}?context=edit&_fields=id,name,email,first_name,last_name,meta,acf,billing`;
        wpUser = asRecord((await fetchUnknownWithStatus(userUrl, wpHeaders, signal)).data);
      } else if (email) {
        const searchUrl = new URL(`${wpStoreUrl.replace(/\/+$/, "")}/wp-json/wp/v2/users`);
        searchUrl.searchParams.set("context", "edit");
        searchUrl.searchParams.set("per_page", "25");
        searchUrl.searchParams.set("search", email);
        searchUrl.searchParams.set("_fields", "id,name,email,first_name,last_name,meta,acf,billing");
        const users = (await fetchUnknownWithStatus(searchUrl.toString(), wpHeaders, signal)).data as unknown[];
        wpUser = users.map(asRecord).find((user) => normalizeEmail(user.email) === normalizeEmail(email)) ?? null;
      }
    } catch (error) {
      warnings.push(`WP users debug fetch failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  if (isWooCommerceCustomerFallbackConfigured()) {
    try {
      if (userId) {
        const customerUrl = `${base}/wp-json/wc/v3/customers/${encodeURIComponent(userId)}?_fields=id,email,username,first_name,last_name,billing,shipping,meta_data,meta,acf,date_created,date_modified`;
        wooCustomer = asRecord((await fetchUnknownWithStatus(customerUrl, wooHeaders, signal)).data);
      }
    } catch (error) {
      warnings.push(`WooCommerce customer id debug fetch failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    try {
      if (!wooCustomer && email) {
        const customerSearchUrl = new URL(`${base}/wp-json/wc/v3/customers`);
        customerSearchUrl.searchParams.set("per_page", "25");
        customerSearchUrl.searchParams.set("search", email);
        customerSearchUrl.searchParams.set("_fields", "id,email,username,first_name,last_name,billing,shipping,meta_data,meta,acf,date_created,date_modified");
        const customers = (await fetchUnknownWithStatus(customerSearchUrl.toString(), wooHeaders, signal, profileFetchTimeoutMs)).data as unknown[];
        wooCustomer = customers.map(asRecord).find((customer) => normalizeEmail(customer.email || asRecord(customer.billing).email) === normalizeEmail(email)) ?? null;
      }
    } catch (error) {
      warnings.push(`WooCommerce customer email debug fetch failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  const resolvedEmail = normalizeEmail(email || wpUser?.email || wooCustomer?.email || asRecord(wooCustomer?.billing).email);
  const resolvedCustomerId = Number(userId || wooCustomer?.id || 0);

  if (isWooCommerceCustomerFallbackConfigured()) {
    try {
      const orderUrl = new URL(`${base}/wp-json/wc/v3/orders`);
      orderUrl.searchParams.set("per_page", "20");
      orderUrl.searchParams.set("_fields", "id,number,status,total,date_created,customer_id,billing,shipping,meta_data");
      if (resolvedCustomerId > 0) orderUrl.searchParams.set("customer", String(resolvedCustomerId));
      if (resolvedEmail) orderUrl.searchParams.set("search", resolvedEmail);
      const orders = (await fetchUnknownWithStatus(orderUrl.toString(), wooHeaders, signal, profileFetchTimeoutMs)).data as unknown[];
      wooOrders = orders.map(asRecord).filter((order) => {
        if (resolvedCustomerId > 0 && Number(order.customer_id ?? 0) === resolvedCustomerId) return true;
        return normalizeEmail(asRecord(order.billing).email) === resolvedEmail;
      });
    } catch (error) {
      warnings.push(`WooCommerce orders debug fetch failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    try {
      const subscriptionUrl = new URL(`${base}/wp-json/wc/v3/subscriptions`);
      subscriptionUrl.searchParams.set("per_page", "20");
      subscriptionUrl.searchParams.set("_fields", "id,number,status,customer_id,billing,meta_data,start_date,next_payment_date,last_payment_date");
      if (resolvedCustomerId > 0) subscriptionUrl.searchParams.set("customer", String(resolvedCustomerId));
      if (resolvedEmail) subscriptionUrl.searchParams.set("search", resolvedEmail);
      const subscriptions = (await fetchUnknownWithStatus(subscriptionUrl.toString(), wooHeaders, signal, profileFetchTimeoutMs)).data as unknown[];
      wooSubscriptions = subscriptions.map(asRecord).filter((subscription) => {
        if (resolvedCustomerId > 0 && Number(subscription.customer_id ?? 0) === resolvedCustomerId) return true;
        return normalizeEmail(asRecord(subscription.billing).email) === resolvedEmail;
      });
    } catch (error) {
      warnings.push(`WooCommerce subscriptions debug fetch failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  const wpMeta = wpUser ? { ...asRecord(wpUser.meta), ...asRecord(wpUser.acf), ...asRecord(wpUser.billing) } : {};
  const wooCustomerMeta = wooCustomer ? { ...metaDataObject(wooCustomer.meta_data), ...asRecord(wooCustomer.meta), ...asRecord(wooCustomer.acf), ...asRecord(wooCustomer.billing) } : {};
  const orderMeta = wooOrders.reduce<WpRecord>((acc, order, orderIndex) => {
    const meta = metaDataObject(order.meta_data);
    for (const [key, value] of Object.entries(meta)) acc[`order_${orderIndex}_${key}`] = value;
    return acc;
  }, {});
  const subscriptionMeta = wooSubscriptions.reduce<WpRecord>((acc, subscription, subIndex) => {
    const meta = metaDataObject(subscription.meta_data);
    for (const [key, value] of Object.entries(meta)) acc[`subscription_${subIndex}_${key}`] = value;
    return acc;
  }, {});
  const combinedMeta = { ...wpMeta, ...wooCustomerMeta, ...orderMeta, ...subscriptionMeta };
  const detected = inspectCreditMeta(combinedMeta);

  return {
    email: resolvedEmail || email || "",
    requestedUserId: userId || "",
    wordpressUserFound: Boolean(wpUser),
    wooCustomerFound: Boolean(wooCustomer),
    wooOrdersFound: wooOrders.length,
    wooSubscriptionsFound: wooSubscriptions.length,
    detectedCreditMetaKeys: detected.detectedCreditMetaKeys,
    rejectedCandidateKeys: detected.rejectedCandidateKeys,
    selectedApprovedCreditKey: detected.selectedApprovedCreditKey,
    selectedAvailableCreditKey: detected.selectedAvailableCreditKey,
    selectedOutstandingKey: detected.selectedOutstandingKey,
    selectedEinKey: detected.selectedEinKey,
    selectedCreditStatusKey: detected.selectedCreditStatusKey,
    selectedLastBillDateKey: detected.selectedLastBillDateKey,
    selectedNextBillingDateKey: detected.selectedNextBillingDateKey,
    parsedNumericValues: detected.parsedNumericValues,
    creditMetaVerified: detected.verified,
    fallbackReason: detected.fallbackReason,
    pluginNamespaceKeys: detected.pluginNamespaceKeys,
    normalizedProfilePreview: {
      approvedCredits: detected.approvedCredits,
      availableCredit: detected.availableCredit,
      outstandingBalance: detected.outstandingBalance,
      creditLimit: detected.creditLimit,
      totalCreditLimit: Math.max(detected.approvedCredits, detected.potentialCreditLimit, detected.creditLimit),
      creditStatus: detected.creditStatus,
      lastBillDate: detected.lastBillDate,
      nextBillingDate: detected.nextBillingDate,
      ein: detected.ein,
    },
    wordpressUser: wpUser ? {
      id: Number(wpUser.id ?? 0),
      email: normalizeEmail(wpUser.email),
      name: asString(wpUser.name),
      metaEntries: metaEntriesForDebug(wpMeta),
      raw: sanitizeDebugRecord({ meta: wpMeta, billing: asRecord(wpUser.billing), acf: asRecord(wpUser.acf) }),
    } : null,
    wooCustomer: wooCustomer ? {
      id: Number(wooCustomer.id ?? 0),
      email: normalizeEmail(wooCustomer.email || asRecord(wooCustomer.billing).email),
      name: `${asString(wooCustomer.first_name)} ${asString(wooCustomer.last_name)}`.trim(),
      billing: sanitizeDebugRecord(asRecord(wooCustomer.billing)),
      shipping: sanitizeDebugRecord(asRecord(wooCustomer.shipping)),
      metaEntries: metaEntriesForDebug(wooCustomerMeta),
      raw: sanitizeDebugRecord({ meta_data: wooCustomer.meta_data, meta: asRecord(wooCustomer.meta), acf: asRecord(wooCustomer.acf) }),
    } : null,
    wooOrders: wooOrders.map((order) => {
      const meta = metaDataObject(order.meta_data);
      return {
        id: Number(order.id ?? 0),
        orderNumber: asString(order.number),
        status: asString(order.status),
        billingEmail: normalizeEmail(asRecord(order.billing).email),
        billingCompany: asString(asRecord(order.billing).company),
        metaEntries: metaEntriesForDebug(meta),
        raw: sanitizeDebugRecord({ meta_data: order.meta_data, billing: asRecord(order.billing), shipping: asRecord(order.shipping) }),
      };
    }),
    wooSubscriptions: wooSubscriptions.map((subscription) => {
      const meta = metaDataObject(subscription.meta_data);
      return {
        id: Number(subscription.id ?? 0),
        subscriptionNumber: asString(subscription.number),
        status: asString(subscription.status),
        billingEmail: normalizeEmail(asRecord(subscription.billing).email),
        metaEntries: metaEntriesForDebug(meta),
        raw: sanitizeDebugRecord({ meta_data: subscription.meta_data, billing: asRecord(subscription.billing) }),
      };
    }),
    warnings,
  };
}

export async function testProfileSources(signal?: AbortSignal) {
  const base = wpStoreUrl.replace(/\/+$/, "");
  if (!base) {
    return {
      wpJson: { status: 0, ok: false },
      wpUsers: { status: 0, ok: false },
      wooCustomersOne: { status: 0, ok: false },
      wooCustomersPage: { status: 0, ok: false },
    };
  }
  const headers: Record<string, string> = isWordPressProfileImportConfigured() ? { Authorization: authHeader(), Accept: "application/json" } : { Accept: "application/json" };
  const wooHeaders: Record<string, string> = isWooCommerceCustomerFallbackConfigured() ? { Authorization: wooAuthHeader(), Accept: "application/json" } : { Accept: "application/json" };
  const tests = [
    { name: "wpJson", url: `${base}/wp-json`, headers },
    { name: "wpUsers", url: `${base}/wp-json/wp/v2/users?per_page=1`, headers },
    { name: "wooCustomersOne", url: `${base}/wp-json/wc/v3/customers?per_page=1`, headers: wooHeaders },
    { name: "wooCustomersPage", url: `${base}/wp-json/wc/v3/customers?page=1&per_page=50`, headers: wooHeaders },
  ];
  const results: Record<string, { status: number; ok: boolean }> = {};
  for (const test of tests) {
    try {
      const response = await fetch(test.url, { headers: test.headers, cache: "no-store", signal });
      results[test.name] = { status: response.status, ok: response.ok };
    } catch {
      results[test.name] = { status: 0, ok: false };
    }
  }
  return results;
}
