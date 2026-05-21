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

export type WordPressProfileUser = {
  id: number;
  name: string;
  email: string;
  normalizedEmail: string;
  profile: CustomerBusinessProfile;
};

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

export function isWordPressProfileImportConfigured() {
  return Boolean(wpStoreUrl && wpUsername && wpPassword);
}

export function isWooCommerceCustomerFallbackConfigured() {
  return Boolean((wcStoreUrl || wpStoreUrl) && ((wcConsumerKey && wcConsumerSecret) || (wpUsername && wpPassword)));
}

export function normalizeWordPressProfileUser(user: WpRecord, importedAt = new Date().toISOString()): WordPressProfileUser {
  const meta = { ...asRecord(user.meta), ...asRecord(user.acf), ...asRecord(user.billing) };
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
      ein: metaValue(meta, ["ein"]),
      potentialCreditLimit: asNumber(metaValue(meta, ["potential_credit_limit"])),
      creditLimit: asNumber(metaValue(meta, ["credit_limit", "my_credit_limit"])),
      creditLimitLastUpdated: metaValue(meta, ["last_credit_limit_update"]),
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
      ein: metaValue(meta, ["ein"]),
      potentialCreditLimit: asNumber(metaValue(meta, ["potential_credit_limit"])),
      creditLimit: asNumber(metaValue(meta, ["credit_limit", "my_credit_limit"])),
      creditLimitLastUpdated: metaValue(meta, ["last_credit_limit_update"]),
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
