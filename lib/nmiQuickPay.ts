import type { NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import type { PaymentEventDocument } from "@/models/PaymentEvent";

const requestTimeoutMs = 12000;

function asString(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function asNumber(value: unknown) {
  const parsed = Number(asString(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeEmail(value: unknown) {
  return asString(value).toLowerCase();
}

export function normalizeNmiPhone(value: unknown) {
  return asString(value).replace(/\D/g, "");
}

function safeLast4(value: unknown) {
  return normalizeNmiPhone(value).slice(-4);
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

function parseNmiDate(value: unknown) {
  const raw = asString(value);
  if (!raw) return "";
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?/);
  if (!compact) return raw;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = compact;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function normalizeName(...values: unknown[]) {
  return values.map(asString).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

export function isNmiSuccessful(status: string) {
  const normalized = status.toLowerCase();
  if (isNmiRefundOrChargeback(status) || isNmiDeclined(status)) return false;
  return normalized.includes("success") || normalized.includes("settled") || normalized.includes("approved") || normalized === "complete";
}

export function isNmiDeclined(status: string) {
  const normalized = status.toLowerCase();
  return normalized.includes("declin") || normalized.includes("fail") || normalized.includes("void") || normalized.includes("error") || normalized.includes("denied");
}

export function isNmiRefundOrChargeback(status: string) {
  const normalized = status.toLowerCase();
  return normalized.includes("refund") || normalized.includes("chargeback") || normalized.includes("charge back") || normalized.includes("credit");
}

export function isNmiConfigured() {
  return Boolean(process.env.NMI_SECURITY_KEY);
}

function normalizeNmiQueryBlock(block: string, importedAt: string): Partial<NmiQuickPayTransactionDocument> {
  const ccNumber = xmlField(block, ["cc_number", "card_number", "ccnumber"]);
  const firstName = xmlField(block, ["first_name", "firstname", "billing_first_name"]);
  const lastName = xmlField(block, ["last_name", "lastname", "billing_last_name"]);
  const email = normalizeEmail(xmlField(block, ["email", "billing_email", "email_address"]));
  const phone = normalizeNmiPhone(xmlField(block, ["phone", "billing_phone", "phone_number"]));
  const submittedAt = parseNmiDate(xmlField(block, ["date", "transaction_date", "action_date", "date_created", "created"]));
  const status = xmlField(block, ["condition", "transaction_status", "response_text", "responsetext", "response"]);
  const vaultId = xmlField(block, ["customer_vault_id", "customer_vault_record_id", "customer_vault_customer_id"]);
  const paymentProfileId = xmlField(block, ["payment_profile_id", "customer_payment_profile_id", "customer_id"]) || vaultId;
  return {
    transactionId: xmlField(block, ["transaction_id", "transactionid", "transaction-id"]),
    transactionStatus: status,
    responseCode: xmlField(block, ["response_code", "response"]),
    invoiceNumber: xmlField(block, ["orderid", "order_id", "invoice_number", "invoice", "ponumber"]),
    description: xmlField(block, ["description", "product", "action_type", "type"]),
    amount: asNumber(xmlField(block, ["amount", "settlement_amount", "requested_amount", "total"])),
    currency: "USD",
    submittedAt,
    settledAt: isNmiSuccessful(status) ? submittedAt : "",
    customerEmail: email,
    normalizedEmail: email,
    emailNormalized: email,
    customerName: normalizeName(firstName, lastName),
    billingFirstName: firstName,
    billingLastName: lastName,
    billingCompany: xmlField(block, ["company", "billing_company"]),
    billingPhone: phone,
    normalizedPhone: phone,
    cardType: xmlField(block, ["cc_type", "card_type", "payment_type"]),
    cardLast4: safeLast4(xmlField(block, ["last4", "cc_last4", "card_last4"]) || ccNumber),
    paymentMethod: "card",
    customerVaultId: vaultId,
    customerPaymentProfileId: paymentProfileId,
    rawSafeMeta: [
      { key: "source", value: "nmi_query_api" },
      { key: "responseText", value: status.slice(0, 120) },
    ].filter((item) => item.value),
    importedAt,
  };
}

export function normalizeNmiQueryResponse(responseText: string, importedAt = new Date().toISOString()) {
  const matches = Array.from(responseText.matchAll(/<transaction\b[^>]*>([\s\S]*?)<\/transaction>/gi));
  const blocks = matches.length > 0 ? matches.map((match) => match[1]) : responseText.includes("<transaction_id>") ? [responseText] : [];
  return blocks.map((block) => normalizeNmiQueryBlock(block, importedAt)).filter((transaction) => transaction.transactionId);
}

export function normalizeNmiPaymentEvent(event: PaymentEventDocument, importedAt = new Date().toISOString()): Partial<NmiQuickPayTransactionDocument> {
  const raw = event.rawPayload ?? {};
  const firstName = asString(raw.first_name ?? raw.firstname ?? raw.billing_first_name);
  const lastName = asString(raw.last_name ?? raw.lastname ?? raw.billing_last_name);
  const email = normalizeEmail(event.customerEmail || raw.email || raw.customer_email || raw.billing_email);
  const phone = normalizeNmiPhone(event.customerPhone || raw.phone || raw.customer_phone || raw.billing_phone);
  const status = asString(raw.transaction_status || raw.status || raw.condition || event.status);
  const date = parseNmiDate(raw.transaction_date || raw.action_date || raw.date || event.receivedAt);
  return {
    transactionId: asString(event.transactionId || raw.transaction_id || raw.transactionid || raw.id),
    transactionStatus: status || event.eventType,
    responseCode: asString(raw.response_code || raw.response),
    invoiceNumber: asString(raw.orderid || raw.order_id || raw.invoice_number || raw.invoice || raw.ponumber),
    description: asString(raw.description || raw.product || raw.action_type || event.eventType),
    amount: Number(event.amount || asNumber(raw.amount || raw.transaction_amount || raw.total)),
    currency: "USD",
    submittedAt: date,
    settledAt: isNmiSuccessful(status || event.eventType) ? date : "",
    customerEmail: email,
    normalizedEmail: email,
    emailNormalized: email,
    customerName: normalizeName(raw.customer_name, firstName, lastName),
    billingFirstName: firstName,
    billingLastName: lastName,
    billingCompany: asString(raw.company || raw.billing_company || raw.business_name),
    billingPhone: phone,
    normalizedPhone: phone,
    cardType: asString(raw.cc_type || raw.card_type || raw.payment_type),
    cardLast4: safeLast4(raw.last4 || raw.cc_last4 || raw.card_last4 || raw.cc_number),
    paymentMethod: "card",
    customerVaultId: asString(raw.customer_vault_id || raw.customer_vault_record_id || raw.customer_vault_customer_id),
    customerPaymentProfileId: asString(raw.payment_profile_id || raw.customer_payment_profile_id || raw.customer_id),
    rawSafeMeta: [{ key: "source", value: "nmi_webhook" }, { key: "eventType", value: event.eventType }],
    importedAt,
  };
}

export async function fetchNmiTransactions({ from, to, signal }: { from: string; to: string; signal?: AbortSignal }) {
  const securityKey = process.env.NMI_SECURITY_KEY;
  if (!securityKey) return { transactions: [] as Partial<NmiQuickPayTransactionDocument>[], warning: "NMI security key is not configured." };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const baseUrl = (process.env.NMI_BASE_URL || "https://secure.nmi.com").replace(/\/$/, "");
    const body = new URLSearchParams({ security_key: securityKey, start_date: from, end_date: to });
    const response = await fetch(`${baseUrl}/api/query.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) return { transactions: [] as Partial<NmiQuickPayTransactionDocument>[], warning: `NMI Query API returned HTTP ${response.status}.` };
    return { transactions: normalizeNmiQueryResponse(text), warning: "" };
  } catch (error) {
    const warning = error instanceof Error && error.name === "AbortError"
      ? "NMI Query API request timed out."
      : error instanceof Error ? error.message : "NMI Query API request failed.";
    return { transactions: [] as Partial<NmiQuickPayTransactionDocument>[], warning };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
