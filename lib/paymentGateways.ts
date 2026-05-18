import "server-only";
import type { CustomerOrderHistoryItem, GatewayVerification } from "@/models/Customer";

type VerificationOptions = {
  verifyGateways?: boolean;
};

type NmiTransaction = {
  transactionId: string;
  status: string;
  amount: number;
  transactionDate: string;
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  company: string;
  address1: string;
  customerVaultId: string;
  paymentProfileId: string;
  last4: string;
  cardType: string;
};

type AuthorizeNetTransaction = {
  transactionId: string;
  status: string;
  amount: number;
  transactionDate: string;
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  company: string;
  address1: string;
  paymentProfileId: string;
  customerProfileId: string;
  last4: string;
  cardType: string;
};

type NmiQueryResult = {
  transactions: NmiTransaction[];
  error?: string;
};

type AuthorizeNetQueryResult = {
  data?: Record<string, unknown>;
  error?: string;
};

type AuthorizeNetCandidateResult = {
  transactions: AuthorizeNetTransaction[];
  candidatesCount: number;
  error?: string;
};

type MatchableTransaction = {
  amount: number;
  transactionDate: string;
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  company: string;
  address1: string;
};

type StripeTransaction = MatchableTransaction & {
  transactionId: string;
  paymentIntentId: string;
  chargeId: string;
  status: string;
  stripeCustomerId: string;
  paymentMethodId: string;
  last4: string;
  cardType: string;
};

type StripeQueryResult = {
  transaction?: StripeTransaction;
  transactions: StripeTransaction[];
  candidatesCount: number;
  error?: string;
};

const STRIPE_REQUEST_TIMEOUT_MS = 12000;
const STRIPE_MATCH_WINDOW_DAYS = 3;
const STRIPE_MAX_CANDIDATES = 100;
const NMI_REQUEST_TIMEOUT_MS = 12000;
const NMI_MATCH_WINDOW_DAYS = 3;
const AUTHORIZE_REQUEST_TIMEOUT_MS = 12000;
const AUTHORIZE_MATCH_WINDOW_DAYS = 3;
const AUTHORIZE_MAX_BATCHES = 10;
const AUTHORIZE_MAX_TRANSACTION_DETAILS = 25;

export function getGatewayConfigurationSummary() {
  return {
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    authorizeNet: Boolean(process.env.AUTHORIZE_NET_API_LOGIN_ID && process.env.AUTHORIZE_NET_TRANSACTION_KEY),
    nmi: Boolean(process.env.NMI_SECURITY_KEY),
    cliq: Boolean(process.env.CLIQ_WEBHOOK_SECRET || process.env.NMI_SECURITY_KEY),
  };
}

export function hasConfiguredGateway() {
  const summary = getGatewayConfigurationSummary();
  return summary.stripe || summary.authorizeNet || summary.nmi || summary.cliq;
}

function nmiConfigured() {
  return Boolean(process.env.NMI_SECURITY_KEY);
}

function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function authorizeNetConfigured() {
  return Boolean(process.env.AUTHORIZE_NET_API_LOGIN_ID && process.env.AUTHORIZE_NET_TRANSACTION_KEY);
}

function inferProvider(order: Pick<CustomerOrderHistoryItem, "paymentMethod" | "paymentMethodTitle">) {
  const method = (order.paymentMethod ?? "").toLowerCase();
  const title = (order.paymentMethodTitle ?? "").toLowerCase();
  const value = `${method} ${title}`;
  const stripeLike =
    value.includes("stripe") ||
    value.includes("payment_intent") ||
    value.includes("payment intent") ||
    value.includes("checkout_session") ||
    value.includes("checkout session");
  const nmiLike =
    method.includes("nmi") ||
    method.includes("cliq") ||
    method.includes("gateway") ||
    title.includes("quick pay") ||
    title.includes("gateway") ||
    value.includes("nmi") ||
    value.includes("cliq") ||
    value.includes("quick pay") ||
    value.includes("gateway");
  const authorizeLike =
    value.includes("authorize_net") ||
    value.includes("authorize.net") ||
    value.includes("authorize") ||
    value.includes("cim") ||
    value.includes("credit card payment");
  if (stripeLike) return "stripe";
  if (nmiLike) return "nmi";
  if (authorizeLike) return "authorize_net";
  if (value.includes("crypto")) return "crypto";
  if (
    method === "card" ||
    title === "card" ||
    value.includes(" card") ||
    value.includes("card ") ||
    value.includes("credit card") ||
    value.includes("checkout")
  ) return "stripe";
  return value.trim() ? "unknown_gateway" : "woocommerce";
}

function providerConfigured(provider: string) {
  if (provider === "nmi") return nmiConfigured();
  if (provider === "stripe") return stripeConfigured();
  if (provider === "authorize_net") return authorizeNetConfigured();
  if (provider === "cliq") return Boolean(process.env.CLIQ_WEBHOOK_SECRET || process.env.NMI_SECURITY_KEY);
  return hasConfiguredGateway();
}

function baseVerification(
  order: CustomerOrderHistoryItem,
  provider: string,
  overrides: Partial<GatewayVerification> = {}
): GatewayVerification {
  return {
    provider,
    matched: false,
    confidence: "not_found",
    matchedBy: "",
    transactionId: order.transactionId,
    transactionStatus: "not_verified",
    amount: order.total,
    transactionDate: order.paidDate || order.attemptedDate || order.dateCreated,
    customerVaultId: "",
    paymentProfileId: "",
    customerProfileId: "",
    paymentIntentId: "",
    chargeId: "",
    stripeCustomerId: "",
    paymentMethodId: "",
    last4: "",
    cardType: "",
    candidatesCount: 0,
    rawSummary: "",
    lastCheckedAt: new Date().toISOString(),
    configured: providerConfigured(provider),
    notes: "",
    ...overrides,
  };
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function xmlField(block: string, names: string[]) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match?.[1]) return decodeXml(match[1]).trim();
  }
  return "";
}

function parseAmount(value: string) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeLast4(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

function parseNmiDate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const compact = trimmed.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?/);
  if (!compact) return trimmed;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = compact;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
}

function parseNmiTransactions(responseText: string) {
  const transactionMatches = Array.from(responseText.matchAll(/<transaction\b[^>]*>([\s\S]*?)<\/transaction>/gi));
  const blocks = transactionMatches.length > 0 ? transactionMatches.map((match) => match[1]) : responseText.includes("<transaction_id>") ? [responseText] : [];

  return blocks.map((block) => {
    const ccNumber = xmlField(block, ["cc_number", "card_number", "ccnumber"]);
    const customerVaultId = xmlField(block, ["customer_vault_id", "customer_vault_record_id", "customer_vault_customer_id"]);
    const paymentProfileId = xmlField(block, ["payment_profile_id", "customer_payment_profile_id", "customer_id"]);
    return {
      transactionId: xmlField(block, ["transaction_id", "transactionid", "transaction-id"]),
      status: xmlField(block, ["condition", "transaction_status", "response_text", "responsetext", "response"]),
      amount: parseAmount(xmlField(block, ["amount", "settlement_amount", "requested_amount", "total"])),
      transactionDate: parseNmiDate(xmlField(block, ["date", "transaction_date", "action_date", "date_created", "created"])),
      email: xmlField(block, ["email", "billing_email", "email_address"]).toLowerCase(),
      phone: xmlField(block, ["phone", "billing_phone", "phone_number"]),
      firstName: xmlField(block, ["first_name", "firstname", "billing_first_name"]),
      lastName: xmlField(block, ["last_name", "lastname", "billing_last_name"]),
      company: xmlField(block, ["company", "billing_company"]),
      address1: xmlField(block, ["address_1", "address1", "billing_address1", "address"]),
      customerVaultId,
      paymentProfileId: paymentProfileId || customerVaultId,
      last4: safeLast4(xmlField(block, ["last4", "cc_last4", "card_last4"]) || ccNumber),
      cardType: xmlField(block, ["cc_type", "card_type", "payment_type"]),
    } satisfies NmiTransaction;
  });
}

async function queryNmi(params: Record<string, string>): Promise<NmiQueryResult> {
  const securityKey = process.env.NMI_SECURITY_KEY;
  if (!securityKey) return { transactions: [], error: "NMI security key is not configured." };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NMI_REQUEST_TIMEOUT_MS);
  const baseUrl = (process.env.NMI_BASE_URL || "https://secure.nmi.com").replace(/\/$/, "");
  const body = new URLSearchParams({ security_key: securityKey, ...params });

  try {
    const response = await fetch(`${baseUrl}/api/query.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) return { transactions: [], error: `NMI Query API returned HTTP ${response.status}.` };
    return { transactions: parseNmiTransactions(text) };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "NMI Query API request timed out."
      : error instanceof Error
        ? error.message
        : "NMI Query API request failed.";
    return { transactions: [], error: message };
  } finally {
    clearTimeout(timeout);
  }
}

function authorizeNetEndpoint() {
  const environment = (process.env.AUTHORIZE_NET_ENVIRONMENT || "production").toLowerCase();
  return environment.includes("sandbox") || environment.includes("test")
    ? "https://apitest.authorize.net/xml/v1/request.api"
    : "https://api.authorize.net/xml/v1/request.api";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? [record] : [];
}

function asString(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function firstString(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = asString(record[name]);
    if (value) return value;
  }
  return "";
}

function firstAmount(record: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = record[name];
    const parsed = typeof value === "number" ? value : parseAmount(asString(value));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function stripeAmount(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(asString(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 100 : 0;
}

function stripeDate(value: unknown) {
  const seconds = typeof value === "number" ? value : Number(asString(value));
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1000).toISOString();
}

function stripeId(value: unknown) {
  if (typeof value === "string") return value;
  return firstString(asRecord(value), ["id"]);
}

function splitName(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : "",
  };
}

function parseStripeCharge(value: unknown): StripeTransaction | null {
  const charge = asRecord(value);
  const chargeId = firstString(charge, ["id"]);
  if (!chargeId) return null;

  const billing = asRecord(charge.billing_details);
  const billingAddress = asRecord(billing.address);
  const customer = asRecord(charge.customer);
  const metadata = asRecord(charge.metadata);
  const paymentMethodDetails = asRecord(charge.payment_method_details);
  const card = asRecord(paymentMethodDetails.card);
  const name = firstString(billing, ["name"]) || firstString(customer, ["name"]);
  const { firstName, lastName } = splitName(name);

  return {
    transactionId: chargeId,
    paymentIntentId: stripeId(charge.payment_intent),
    chargeId,
    status: firstString(charge, ["status", "failure_message"]) || firstString(asRecord(charge.outcome), ["seller_message", "type"]),
    amount: stripeAmount(charge.amount),
    transactionDate: stripeDate(charge.created),
    email: (firstString(billing, ["email"]) || firstString(charge, ["receipt_email"]) || firstString(customer, ["email"])).toLowerCase(),
    phone: firstString(billing, ["phone"]) || firstString(customer, ["phone"]),
    firstName,
    lastName,
    company: firstString(metadata, ["company", "billing_company"]),
    address1: firstString(billingAddress, ["line1"]),
    stripeCustomerId: stripeId(charge.customer),
    paymentMethodId: firstString(charge, ["payment_method"]),
    last4: safeLast4(firstString(card, ["last4"])),
    cardType: firstString(card, ["brand", "network"]),
  };
}

function parseStripePaymentIntent(value: unknown): StripeTransaction | null {
  const intent = asRecord(value);
  const paymentIntentId = firstString(intent, ["id"]);
  if (!paymentIntentId) return null;

  const latestCharge = parseStripeCharge(intent.latest_charge);
  const customer = asRecord(intent.customer);
  const paymentMethod = asRecord(intent.payment_method);
  const card = asRecord(paymentMethod.card);
  const name = firstString(customer, ["name"]);
  const { firstName, lastName } = splitName(name);
  const amount = stripeAmount(intent.amount_received) || stripeAmount(intent.amount);

  return {
    transactionId: paymentIntentId,
    paymentIntentId,
    chargeId: latestCharge?.chargeId ?? "",
    status: firstString(intent, ["status"]) || latestCharge?.status || "found",
    amount,
    transactionDate: stripeDate(intent.created) || latestCharge?.transactionDate || "",
    email: latestCharge?.email || firstString(intent, ["receipt_email"]).toLowerCase() || firstString(customer, ["email"]).toLowerCase(),
    phone: latestCharge?.phone || firstString(customer, ["phone"]),
    firstName: latestCharge?.firstName || firstName,
    lastName: latestCharge?.lastName || lastName,
    company: latestCharge?.company || firstString(asRecord(intent.metadata), ["company", "billing_company"]),
    address1: latestCharge?.address1 || firstString(asRecord(customer.address), ["line1"]),
    stripeCustomerId: stripeId(intent.customer),
    paymentMethodId: stripeId(intent.payment_method),
    last4: latestCharge?.last4 || safeLast4(firstString(card, ["last4"])),
    cardType: latestCharge?.cardType || firstString(card, ["brand", "network"]),
  };
}

function parseStripeCheckoutSession(value: unknown): StripeTransaction | null {
  const session = asRecord(value);
  const sessionId = firstString(session, ["id"]);
  if (!sessionId) return null;

  const intent = parseStripePaymentIntent(session.payment_intent);
  const customer = asRecord(session.customer);
  const customerDetails = asRecord(session.customer_details);
  const customerAddress = asRecord(customerDetails.address);
  const name = firstString(customerDetails, ["name"]) || firstString(customer, ["name"]);
  const { firstName, lastName } = splitName(name);

  return {
    transactionId: sessionId,
    paymentIntentId: intent?.paymentIntentId || stripeId(session.payment_intent),
    chargeId: intent?.chargeId ?? "",
    status: firstString(session, ["payment_status", "status"]) || intent?.status || "found",
    amount: stripeAmount(session.amount_total) || intent?.amount || 0,
    transactionDate: stripeDate(session.created) || intent?.transactionDate || "",
    email: intent?.email || firstString(customerDetails, ["email"]).toLowerCase() || firstString(customer, ["email"]).toLowerCase(),
    phone: intent?.phone || firstString(customerDetails, ["phone"]) || firstString(customer, ["phone"]),
    firstName: intent?.firstName || firstName,
    lastName: intent?.lastName || lastName,
    company: intent?.company || firstString(asRecord(session.metadata), ["company", "billing_company"]),
    address1: intent?.address1 || firstString(customerAddress, ["line1"]),
    stripeCustomerId: stripeId(session.customer) || intent?.stripeCustomerId || "",
    paymentMethodId: intent?.paymentMethodId ?? "",
    last4: intent?.last4 ?? "",
    cardType: intent?.cardType ?? "",
  };
}

async function queryStripe(path: string, params?: URLSearchParams): Promise<{ data?: unknown; error?: string }> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return { error: "Stripe secret key is not configured." };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STRIPE_REQUEST_TIMEOUT_MS);
  const url = new URL(`https://api.stripe.com/v1/${path.replace(/^\//, "")}`);
  params?.forEach((value, key) => url.searchParams.append(key, value));

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: controller.signal,
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = firstString(asRecord(asRecord(data).error), ["message"]) || `Stripe API returned HTTP ${response.status}.`;
      return { data, error: message };
    }
    return { data };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "Stripe API request timed out."
      : error instanceof Error
        ? error.message
        : "Stripe API request failed.";
    return { error: message };
  } finally {
    clearTimeout(timeout);
  }
}

function stripeExpandParams(expands: string[]) {
  const params = new URLSearchParams();
  for (const expand of expands) params.append("expand[]", expand);
  return params;
}

async function getStripePaymentIntent(paymentIntentId: string) {
  const params = stripeExpandParams(["customer", "payment_method", "latest_charge", "latest_charge.customer"]);
  const result = await queryStripe(`payment_intents/${encodeURIComponent(paymentIntentId)}`, params);
  return { transaction: parseStripePaymentIntent(result.data), error: result.error };
}

async function getStripeCharge(chargeId: string) {
  const params = stripeExpandParams(["customer"]);
  const result = await queryStripe(`charges/${encodeURIComponent(chargeId)}`, params);
  return { transaction: parseStripeCharge(result.data), error: result.error };
}

async function getStripeCheckoutSession(sessionId: string) {
  const params = stripeExpandParams(["customer", "payment_intent", "payment_intent.customer", "payment_intent.latest_charge"]);
  const result = await queryStripe(`checkout/sessions/${encodeURIComponent(sessionId)}`, params);
  return { transaction: parseStripeCheckoutSession(result.data), error: result.error };
}

function stripeDateWindow(order: CustomerOrderHistoryItem) {
  const orderDate = new Date(order.paidDate || order.attemptedDate || order.dateCreated);
  const safeDate = Number.isNaN(orderDate.getTime()) ? new Date() : orderDate;
  const start = new Date(safeDate);
  start.setUTCDate(start.getUTCDate() - STRIPE_MATCH_WINDOW_DAYS);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(safeDate);
  end.setUTCDate(end.getUTCDate() + STRIPE_MATCH_WINDOW_DAYS);
  end.setUTCHours(23, 59, 59, 999);
  return {
    start,
    end,
    startUnix: Math.floor(start.getTime() / 1000),
    endUnix: Math.floor(end.getTime() / 1000),
  };
}

async function findStripeTransactionById(transactionId: string): Promise<StripeQueryResult> {
  const errors: string[] = [];
  const lookups = transactionId.startsWith("cs_")
    ? [() => getStripeCheckoutSession(transactionId), () => getStripePaymentIntent(transactionId), () => getStripeCharge(transactionId)]
    : [() => getStripePaymentIntent(transactionId), () => getStripeCharge(transactionId), () => getStripeCheckoutSession(transactionId)];

  for (const lookup of lookups) {
    const result = await lookup();
    if (result.transaction) return { transaction: result.transaction, transactions: [result.transaction], candidatesCount: 1 };
    if (result.error) errors.push(result.error);
  }

  return { transactions: [], candidatesCount: 0, error: errors.filter(Boolean).join("; ") };
}

async function collectStripeTransactionCandidates(order: CustomerOrderHistoryItem): Promise<StripeQueryResult> {
  const window = stripeDateWindow(order);
  const candidates = new Map<string, StripeTransaction>();
  const errors: string[] = [];
  const add = (transaction: StripeTransaction | null) => {
    if (!transaction) return;
    const key = transaction.chargeId || transaction.paymentIntentId || transaction.transactionId;
    if (key) candidates.set(key, transaction);
  };

  const chargeParams = stripeExpandParams(["data.customer"]);
  chargeParams.set("limit", String(STRIPE_MAX_CANDIDATES));
  chargeParams.set("created[gte]", String(window.startUnix));
  chargeParams.set("created[lte]", String(window.endUnix));
  const charges = await queryStripe("charges", chargeParams);
  if (charges.error) errors.push(`charges: ${charges.error}`);
  for (const charge of asArray(asRecord(charges.data).data)) add(parseStripeCharge(charge));

  const intentParams = stripeExpandParams(["data.customer", "data.payment_method", "data.latest_charge"]);
  intentParams.set("limit", String(STRIPE_MAX_CANDIDATES));
  intentParams.set("created[gte]", String(window.startUnix));
  intentParams.set("created[lte]", String(window.endUnix));
  const intents = await queryStripe("payment_intents", intentParams);
  if (intents.error) errors.push(`payment_intents: ${intents.error}`);
  for (const intent of asArray(asRecord(intents.data).data)) add(parseStripePaymentIntent(intent));

  return {
    transactions: Array.from(candidates.values()),
    candidatesCount: candidates.size,
    error: errors.length ? errors.join("; ") : undefined,
  };
}

function stripJsonBom(value: string) {
  return value.replace(/^\uFEFF/, "").trim();
}

async function queryAuthorizeNet(requestName: string, payload: Record<string, unknown>): Promise<AuthorizeNetQueryResult> {
  const apiLoginId = process.env.AUTHORIZE_NET_API_LOGIN_ID;
  const transactionKey = process.env.AUTHORIZE_NET_TRANSACTION_KEY;
  if (!apiLoginId || !transactionKey) return { error: "Authorize.net credentials are not configured." };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTHORIZE_REQUEST_TIMEOUT_MS);
  const requestBody = {
    [requestName]: {
      merchantAuthentication: {
        name: apiLoginId,
        transactionKey,
      },
      ...payload,
    },
  };

  try {
    const response = await fetch(authorizeNetEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = stripJsonBom(await response.text());
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const responseName = requestName.replace(/Request$/, "Response");
    const data = asRecord(parsed[responseName] ?? parsed);
    const messages = asRecord(data.messages);
    const messageList = asArray(messages.message);
    const messageText = messageList.map((message) => firstString(message, ["text", "description"])).filter(Boolean).join("; ");
    const resultCode = firstString(messages, ["resultCode"]);

    if (!response.ok) return { data, error: `Authorize.net API returned HTTP ${response.status}.` };
    if (resultCode.toLowerCase() === "error") return { data, error: messageText || "Authorize.net API returned an error." };
    return { data };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "Authorize.net API request timed out."
      : error instanceof Error
        ? error.message
        : "Authorize.net API request failed.";
    return { error: message };
  } finally {
    clearTimeout(timeout);
  }
}

function parseAuthorizeDate(value: string) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function parseAuthorizeTransaction(value: unknown): AuthorizeNetTransaction | null {
  const transaction = asRecord(value);
  if (Object.keys(transaction).length === 0) return null;

  const customer = asRecord(transaction.customer);
  const billTo = asRecord(transaction.billTo);
  const profile = asRecord(transaction.profile);
  const payment = asRecord(transaction.payment);
  const creditCard = asRecord(payment.creditCard);
  const transactionId = firstString(transaction, ["transId", "transactionId"]);
  if (!transactionId) return null;

  return {
    transactionId,
    status: firstString(transaction, ["transactionStatus", "responseReasonDescription", "responseCode"]),
    amount: firstAmount(transaction, ["authAmount", "settleAmount", "amount"]),
    transactionDate: parseAuthorizeDate(firstString(transaction, ["submitTimeUTC", "submitTimeLocal", "settleDateUTC"])),
    email: firstString(customer, ["email"]) || firstString(billTo, ["email"]),
    phone: firstString(billTo, ["phoneNumber", "phone"]),
    firstName: firstString(billTo, ["firstName"]),
    lastName: firstString(billTo, ["lastName"]),
    company: firstString(billTo, ["company"]),
    address1: firstString(billTo, ["address"]),
    paymentProfileId: firstString(profile, ["customerPaymentProfileId", "paymentProfileId"]),
    customerProfileId: firstString(profile, ["customerProfileId"]),
    last4: safeLast4(firstString(creditCard, ["cardNumber"]) || firstString(transaction, ["accountNumber"])),
    cardType: firstString(creditCard, ["cardType"]) || firstString(transaction, ["accountType"]),
  };
}

function parseAuthorizeTransactionSummary(value: unknown): AuthorizeNetTransaction | null {
  const summary = asRecord(value);
  const transactionId = firstString(summary, ["transId", "transactionId"]);
  if (!transactionId) return null;

  return {
    transactionId,
    status: firstString(summary, ["transactionStatus", "responseReasonDescription", "responseCode"]),
    amount: firstAmount(summary, ["settleAmount", "authAmount", "amount"]),
    transactionDate: parseAuthorizeDate(firstString(summary, ["submitTimeUTC", "submitTimeLocal"])),
    email: "",
    phone: "",
    firstName: "",
    lastName: "",
    company: "",
    address1: "",
    paymentProfileId: "",
    customerProfileId: "",
    last4: safeLast4(firstString(summary, ["accountNumber"])),
    cardType: firstString(summary, ["accountType"]),
  };
}

async function getAuthorizeTransactionDetails(transactionId: string) {
  const result = await queryAuthorizeNet("getTransactionDetailsRequest", { transId: transactionId });
  const transaction = parseAuthorizeTransaction(asRecord(result.data).transaction);
  return { transaction, error: result.error };
}

function authorizeDateWindow(order: CustomerOrderHistoryItem) {
  const orderDate = new Date(order.paidDate || order.attemptedDate || order.dateCreated);
  const safeDate = Number.isNaN(orderDate.getTime()) ? new Date() : orderDate;
  const start = new Date(safeDate);
  start.setUTCDate(start.getUTCDate() - AUTHORIZE_MATCH_WINDOW_DAYS);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(safeDate);
  end.setUTCDate(end.getUTCDate() + AUTHORIZE_MATCH_WINDOW_DAYS);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end, startQuery: start.toISOString(), endQuery: end.toISOString() };
}

function parseAuthorizeSummaries(data: Record<string, unknown>) {
  const transactions = asRecord(data.transactions);
  return asArray(transactions.transaction).map(parseAuthorizeTransactionSummary).filter((item): item is AuthorizeNetTransaction => Boolean(item));
}

function parseAuthorizeBatches(data: Record<string, unknown>) {
  const batchList = asRecord(data.batchList);
  return asArray(batchList.batch).map((batch) => firstString(batch, ["batchId"])).filter(Boolean);
}

async function collectAuthorizeTransactionCandidates(order: CustomerOrderHistoryItem): Promise<AuthorizeNetCandidateResult> {
  const window = authorizeDateWindow(order);
  const summaries = new Map<string, AuthorizeNetTransaction>();
  const errors: string[] = [];
  const addSummaries = (items: AuthorizeNetTransaction[]) => {
    for (const item of items) {
      if (item.transactionId) summaries.set(item.transactionId, item);
    }
  };

  const unsettled = await queryAuthorizeNet("getUnsettledTransactionListRequest", {
    sorting: { orderBy: "submitTimeUTC", orderDescending: true },
    paging: { limit: 100, offset: 1 },
  });
  if (unsettled.error) errors.push(`unsettled: ${unsettled.error}`);
  if (unsettled.data) addSummaries(parseAuthorizeSummaries(unsettled.data));

  const batches = await queryAuthorizeNet("getSettledBatchListRequest", {
    firstSettlementDate: window.startQuery,
    lastSettlementDate: window.endQuery,
  });
  if (batches.error) errors.push(`batches: ${batches.error}`);
  const batchIds = batches.data ? parseAuthorizeBatches(batches.data).slice(0, AUTHORIZE_MAX_BATCHES) : [];
  for (const batchId of batchIds) {
    const transactionList = await queryAuthorizeNet("getTransactionListRequest", {
      batchId,
      sorting: { orderBy: "submitTimeUTC", orderDescending: true },
      paging: { limit: 100, offset: 1 },
    });
    if (transactionList.error) errors.push(`batch ${batchId}: ${transactionList.error}`);
    if (transactionList.data) addSummaries(parseAuthorizeSummaries(transactionList.data));
  }

  const candidateSummaries = Array.from(summaries.values())
    .filter((transaction) => transactionInWindow(transaction.transactionDate, window.start, window.end))
    .filter((transaction) => transaction.amount <= 0 || amountMatches(transaction.amount, order.total))
    .slice(0, AUTHORIZE_MAX_TRANSACTION_DETAILS);
  const transactions: AuthorizeNetTransaction[] = [];
  for (const summary of candidateSummaries) {
    const details = await getAuthorizeTransactionDetails(summary.transactionId);
    if (details.transaction) transactions.push(details.transaction);
    else if (details.error) errors.push(`details ${summary.transactionId}: ${details.error}`);
  }

  return {
    transactions,
    candidatesCount: summaries.size,
    error: errors.length ? errors.join("; ") : undefined,
  };
}

function formatNmiDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function orderDateWindow(order: CustomerOrderHistoryItem) {
  const orderDate = new Date(order.paidDate || order.attemptedDate || order.dateCreated);
  const safeDate = Number.isNaN(orderDate.getTime()) ? new Date() : orderDate;
  const start = new Date(safeDate);
  start.setUTCDate(start.getUTCDate() - NMI_MATCH_WINDOW_DAYS);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(safeDate);
  end.setUTCDate(end.getUTCDate() + NMI_MATCH_WINDOW_DAYS);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end, startQuery: formatNmiDate(start), endQuery: formatNmiDate(end) };
}

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalized(value: string) {
  return value.trim().toLowerCase();
}

function amountMatches(a: number, b: number) {
  return a > 0 && b > 0 && Math.abs(a - b) < 0.01;
}

function transactionInWindow(transactionDate: string, start: Date, end: Date) {
  if (!transactionDate) return true;
  const parsed = new Date(transactionDate);
  if (Number.isNaN(parsed.getTime())) return true;
  return parsed.getTime() >= start.getTime() && parsed.getTime() <= end.getTime();
}

function candidateScore(transaction: MatchableTransaction, order: CustomerOrderHistoryItem, start: Date, end: Date) {
  if (!amountMatches(transaction.amount, order.total) || !transactionInWindow(transaction.transactionDate, start, end)) return null;

  const orderEmail = normalized(order.billingEmail);
  if (orderEmail && normalized(transaction.email) === orderEmail) {
    return { rank: 4, confidence: "high" as const, matchedBy: "email_amount_date_window" };
  }

  const orderPhone = normalizePhone(order.billingPhone);
  if (orderPhone && normalizePhone(transaction.phone) === orderPhone) {
    return { rank: 3, confidence: "medium" as const, matchedBy: "phone_amount_date_window" };
  }

  if (
    order.billingFirstName &&
    order.billingLastName &&
    normalized(transaction.firstName) === normalized(order.billingFirstName) &&
    normalized(transaction.lastName) === normalized(order.billingLastName)
  ) {
    return { rank: 2, confidence: "medium" as const, matchedBy: "name_amount_date_window" };
  }

  const companyMatches = order.billingCompany && normalized(transaction.company) === normalized(order.billingCompany);
  const addressMatches = order.billingAddress?.address1 && normalized(transaction.address1) === normalized(order.billingAddress.address1);
  if (companyMatches || addressMatches) {
    return { rank: 1, confidence: "low" as const, matchedBy: companyMatches ? "company_amount_date_window" : "address_amount_date_window" };
  }

  return null;
}

function verificationFromStripeTransaction(
  order: CustomerOrderHistoryItem,
  transaction: StripeTransaction,
  options: {
    confidence: GatewayVerification["confidence"];
    matchedBy: string;
    candidatesCount: number;
    rawSummary: string;
  }
) {
  return baseVerification(order, "stripe", {
    matched: true,
    confidence: options.confidence,
    matchedBy: options.matchedBy,
    transactionId: transaction.transactionId,
    paymentIntentId: transaction.paymentIntentId,
    chargeId: transaction.chargeId,
    transactionStatus: transaction.status || "found",
    amount: transaction.amount,
    transactionDate: transaction.transactionDate,
    stripeCustomerId: transaction.stripeCustomerId,
    paymentMethodId: transaction.paymentMethodId,
    last4: transaction.last4,
    cardType: transaction.cardType,
    candidatesCount: options.candidatesCount,
    rawSummary: options.rawSummary,
    configured: true,
    notes: "Stripe transaction matched by server API.",
  });
}

async function verifyStripeOrder(order: CustomerOrderHistoryItem): Promise<GatewayVerification> {
  if (!stripeConfigured()) {
    return baseVerification(order, "stripe", {
      configured: false,
      rawSummary: "Stripe verification was requested, but STRIPE_SECRET_KEY is not configured.",
      notes: "Stripe verification not configured.",
    });
  }

  if (order.transactionId) {
    const result = await findStripeTransactionById(order.transactionId);
    if (result.transaction) {
      return verificationFromStripeTransaction(order, result.transaction, {
        confidence: "exact",
        matchedBy: "transactionId/paymentIntent/chargeId",
        candidatesCount: result.candidatesCount,
        rawSummary: "Stripe API checked WooCommerce transaction id as payment intent, charge, or checkout session and found a match.",
      });
    }

    return baseVerification(order, "stripe", {
      candidatesCount: result.candidatesCount,
      rawSummary: result.error
        ? `Stripe transaction id lookup failed: ${result.error}`
        : "Stripe API checked WooCommerce transaction id as payment intent, charge, or checkout session and found no match.",
      transactionStatus: "not_found",
      configured: true,
      notes: "No Stripe transaction found for WooCommerce transaction id.",
    });
  }

  const window = stripeDateWindow(order);
  const result = await collectStripeTransactionCandidates(order);
  const orderTime = new Date(order.paidDate || order.attemptedDate || order.dateCreated).getTime();
  const dateDistance = (transaction: StripeTransaction) => {
    const transactionTime = new Date(transaction.transactionDate).getTime();
    if (!Number.isFinite(orderTime) || !Number.isFinite(transactionTime)) return Number.MAX_SAFE_INTEGER;
    return Math.abs(transactionTime - orderTime);
  };
  const scored = result.transactions
    .map((transaction) => ({ transaction, score: candidateScore(transaction, order, window.start, window.end) }))
    .filter((candidate): candidate is { transaction: StripeTransaction; score: NonNullable<ReturnType<typeof candidateScore>> } => Boolean(candidate.score))
    .sort((a, b) => b.score.rank - a.score.rank || dateDistance(a.transaction) - dateDistance(b.transaction));
  const best = scored[0];

  if (best) {
    return verificationFromStripeTransaction(order, best.transaction, {
      confidence: best.score.confidence,
      matchedBy: best.score.matchedBy,
      candidatesCount: result.candidatesCount,
      rawSummary: `Stripe API searched a +/- ${STRIPE_MATCH_WINDOW_DAYS} day date window; matched best transaction by ${best.score.matchedBy} among ${result.candidatesCount} candidate(s).`,
    });
  }

  return baseVerification(order, "stripe", {
    candidatesCount: result.candidatesCount,
    rawSummary: result.error
      ? `Stripe date-window lookup completed with errors: ${result.error}`
      : `Stripe API searched a +/- ${STRIPE_MATCH_WINDOW_DAYS} day date window using amount plus email, phone, name, company, and address. No match found among ${result.candidatesCount} candidate(s).`,
    transactionStatus: "not_found",
    configured: true,
    notes: "No Stripe transaction matched WooCommerce order details.",
  });
}

function verificationFromNmiTransaction(
  order: CustomerOrderHistoryItem,
  transaction: NmiTransaction,
  options: {
    confidence: GatewayVerification["confidence"];
    matchedBy: string;
    candidatesCount: number;
    rawSummary: string;
  }
) {
  return baseVerification(order, "nmi", {
    matched: true,
    confidence: options.confidence,
    matchedBy: options.matchedBy,
    transactionId: transaction.transactionId,
    transactionStatus: transaction.status || "found",
    amount: transaction.amount,
    transactionDate: transaction.transactionDate,
    customerVaultId: transaction.customerVaultId,
    paymentProfileId: transaction.paymentProfileId,
    last4: transaction.last4,
    cardType: transaction.cardType,
    candidatesCount: options.candidatesCount,
    rawSummary: options.rawSummary,
    configured: true,
    notes: "NMI transaction matched by Query API.",
  });
}

async function verifyNmiOrder(order: CustomerOrderHistoryItem): Promise<GatewayVerification> {
  if (!nmiConfigured()) {
    return baseVerification(order, "nmi", {
      configured: false,
      rawSummary: "NMI verification was requested, but NMI_SECURITY_KEY is not configured.",
      notes: "NMI verification not configured.",
    });
  }

  if (order.transactionId) {
    const result = await queryNmi({ transaction_id: order.transactionId });
    const exactMatch = result.transactions.find((transaction) => transaction.transactionId === order.transactionId);
    const match = exactMatch ?? (result.transactions.length === 1 ? result.transactions[0] : undefined);
    if (match) {
      return verificationFromNmiTransaction(order, match, {
        confidence: "exact",
        matchedBy: "transactionId",
        candidatesCount: result.transactions.length,
        rawSummary: `NMI Query API checked transaction_id and found ${result.transactions.length} candidate(s).`,
      });
    }

    return baseVerification(order, "nmi", {
      candidatesCount: result.transactions.length,
      rawSummary: result.error
        ? `NMI Query API transaction_id lookup failed: ${result.error}`
        : "NMI Query API checked transaction_id and found no matching transaction.",
      transactionStatus: "not_found",
      configured: true,
      notes: "No NMI transaction found for WooCommerce transaction id.",
    });
  }

  const window = orderDateWindow(order);
  const result = await queryNmi({ start_date: window.startQuery, end_date: window.endQuery });
  const orderTime = new Date(order.paidDate || order.attemptedDate || order.dateCreated).getTime();
  const dateDistance = (transaction: NmiTransaction) => {
    const transactionTime = new Date(transaction.transactionDate).getTime();
    if (!Number.isFinite(orderTime) || !Number.isFinite(transactionTime)) return Number.MAX_SAFE_INTEGER;
    return Math.abs(transactionTime - orderTime);
  };
  const scored = result.transactions
    .map((transaction) => ({ transaction, score: candidateScore(transaction, order, window.start, window.end) }))
    .filter((candidate): candidate is { transaction: NmiTransaction; score: NonNullable<ReturnType<typeof candidateScore>> } => Boolean(candidate.score))
    .sort((a, b) => b.score.rank - a.score.rank || dateDistance(a.transaction) - dateDistance(b.transaction));
  const best = scored[0];

  if (best) {
    return verificationFromNmiTransaction(order, best.transaction, {
      confidence: best.score.confidence,
      matchedBy: best.score.matchedBy,
      candidatesCount: result.transactions.length,
      rawSummary: `NMI Query API checked date window ${window.startQuery}-${window.endQuery}; matched best transaction by ${best.score.matchedBy} among ${result.transactions.length} candidate(s).`,
    });
  }

  return baseVerification(order, "nmi", {
    candidatesCount: result.transactions.length,
    rawSummary: result.error
      ? `NMI Query API date-window lookup failed: ${result.error}`
      : `NMI Query API checked date window ${window.startQuery}-${window.endQuery} using amount plus email, phone, name, company, and address. No match found among ${result.transactions.length} candidate(s).`,
    transactionStatus: "not_found",
    configured: true,
    notes: "No NMI transaction matched WooCommerce order details.",
  });
}

function verificationFromAuthorizeNetTransaction(
  order: CustomerOrderHistoryItem,
  transaction: AuthorizeNetTransaction,
  options: {
    confidence: GatewayVerification["confidence"];
    matchedBy: string;
    candidatesCount: number;
    rawSummary: string;
  }
) {
  return baseVerification(order, "authorize_net", {
    matched: true,
    confidence: options.confidence,
    matchedBy: options.matchedBy,
    transactionId: transaction.transactionId,
    transactionStatus: transaction.status || "found",
    amount: transaction.amount,
    transactionDate: transaction.transactionDate,
    paymentProfileId: transaction.paymentProfileId,
    customerProfileId: transaction.customerProfileId,
    last4: transaction.last4,
    cardType: transaction.cardType,
    candidatesCount: options.candidatesCount,
    rawSummary: options.rawSummary,
    configured: true,
    notes: "Authorize.net transaction matched by API verification.",
  });
}

async function verifyAuthorizeNetOrder(order: CustomerOrderHistoryItem): Promise<GatewayVerification> {
  if (!authorizeNetConfigured()) {
    return baseVerification(order, "authorize_net", {
      configured: false,
      rawSummary: "Authorize.net verification was requested, but credentials are not configured.",
      notes: "Authorize.net verification not configured.",
    });
  }

  if (order.transactionId) {
    const result = await getAuthorizeTransactionDetails(order.transactionId);
    if (result.transaction && result.transaction.transactionId === order.transactionId) {
      return verificationFromAuthorizeNetTransaction(order, result.transaction, {
        confidence: "exact",
        matchedBy: "transactionId",
        candidatesCount: 1,
        rawSummary: "Authorize.net getTransactionDetailsRequest found the WooCommerce transaction id.",
      });
    }

    return baseVerification(order, "authorize_net", {
      candidatesCount: result.transaction ? 1 : 0,
      rawSummary: result.error
        ? `Authorize.net transaction_id lookup failed: ${result.error}`
        : "Authorize.net checked transaction_id and found no matching transaction.",
      transactionStatus: "not_found",
      configured: true,
      notes: "No Authorize.net transaction found for WooCommerce transaction id.",
    });
  }

  const window = authorizeDateWindow(order);
  const result = await collectAuthorizeTransactionCandidates(order);
  const orderTime = new Date(order.paidDate || order.attemptedDate || order.dateCreated).getTime();
  const dateDistance = (transaction: AuthorizeNetTransaction) => {
    const transactionTime = new Date(transaction.transactionDate).getTime();
    if (!Number.isFinite(orderTime) || !Number.isFinite(transactionTime)) return Number.MAX_SAFE_INTEGER;
    return Math.abs(transactionTime - orderTime);
  };
  const scored = result.transactions
    .map((transaction) => ({ transaction, score: candidateScore(transaction, order, window.start, window.end) }))
    .filter((candidate): candidate is { transaction: AuthorizeNetTransaction; score: NonNullable<ReturnType<typeof candidateScore>> } => Boolean(candidate.score))
    .sort((a, b) => b.score.rank - a.score.rank || dateDistance(a.transaction) - dateDistance(b.transaction));
  const best = scored[0];

  if (best) {
    return verificationFromAuthorizeNetTransaction(order, best.transaction, {
      confidence: best.score.confidence,
      matchedBy: best.score.matchedBy,
      candidatesCount: result.candidatesCount,
      rawSummary: `Authorize.net checked ${window.startQuery}-${window.endQuery}; matched best transaction by ${best.score.matchedBy} among ${result.candidatesCount} candidate(s).`,
    });
  }

  return baseVerification(order, "authorize_net", {
    candidatesCount: result.candidatesCount,
    rawSummary: result.error
      ? `Authorize.net date-window lookup completed with errors: ${result.error}`
      : `Authorize.net checked ${window.startQuery}-${window.endQuery} using amount plus email, phone, name, company, and address. No match found among ${result.candidatesCount} candidate(s).`,
    transactionStatus: "not_found",
    configured: true,
    notes: "No Authorize.net transaction matched WooCommerce order details.",
  });
}

export async function verifyOrderPayment(order: CustomerOrderHistoryItem, options: VerificationOptions = {}): Promise<GatewayVerification> {
  const provider = inferProvider(order);
  const configured = providerConfigured(provider);
  const isCryptoHold = provider === "crypto" && order.status === "on-hold";

  if (provider === "stripe" && options.verifyGateways) {
    return verifyStripeOrder(order);
  }

  if (provider === "authorize_net" && options.verifyGateways) {
    return verifyAuthorizeNetOrder(order);
  }

  if (provider === "nmi" && options.verifyGateways) {
    return verifyNmiOrder(order);
  }

  return baseVerification(order, provider, {
    configured,
    transactionStatus: isCryptoHold ? "on_hold" : "not_verified",
    rawSummary: provider === "stripe" && configured
      ? "Stripe verification skipped. Run single customer sync with verifyGateways=true to check Stripe."
      : provider === "authorize_net" && configured
      ? "Authorize.net verification skipped. Run single customer sync with verifyGateways=true to check Authorize.net."
      : provider === "nmi" && configured
      ? "NMI verification skipped. Run single customer sync with verifyGateways=true to check NMI Query API."
      : configured
        ? "Gateway API verification is not implemented for this provider yet. Manual verification required."
        : "Gateway verification not configured.",
    notes: isCryptoHold
      ? "Crypto order on hold. No completed payment verified."
      : provider === "stripe" && configured
        ? "Stripe verification was not requested for this sync."
      : provider === "authorize_net" && configured
        ? "Authorize.net verification was not requested for this sync."
      : provider === "nmi" && configured
        ? "NMI verification was not requested for this sync."
        : configured
          ? "No completed payment found by safe placeholder verification."
          : "Gateway verification not configured.",
  });
}
