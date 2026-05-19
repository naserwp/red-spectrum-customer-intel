import type { AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";

const apiLoginId = process.env.AUTHORIZE_NET_API_LOGIN_ID ?? "";
const transactionKey = process.env.AUTHORIZE_NET_TRANSACTION_KEY ?? "";
const environment = (process.env.AUTHORIZE_NET_ENVIRONMENT ?? "production").toLowerCase();
const endpoint = environment.includes("sandbox") || environment.includes("test")
  ? "https://apitest.authorize.net/xml/v1/request.api"
  : "https://api.authorize.net/xml/v1/request.api";

type AuthNetObject = Record<string, unknown>;

function merchantAuthentication() {
  return { name: apiLoginId, transactionKey };
}

export function isAuthorizeNetConfigured() {
  return Boolean(apiLoginId && transactionKey);
}

function asRecord(value: unknown): AuthNetObject {
  return value && typeof value === "object" ? value as AuthNetObject : {};
}

function asArray(value: unknown): AuthNetObject[] {
  if (Array.isArray(value)) return value.map(asRecord);
  if (value && typeof value === "object") return [asRecord(value)];
  return [];
}

function asString(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function asNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedEmail(value: unknown) {
  return asString(value).trim().toLowerCase();
}

function normalizedPhone(value: unknown) {
  return asString(value).replace(/\D/g, "");
}

function normalizedName(...values: unknown[]) {
  return values.map(asString).join(" ").replace(/\s+/g, " ").trim();
}

function last4(cardNumber: string) {
  const digits = cardNumber.replace(/\D/g, "");
  return digits.slice(-4);
}

async function authorizeNetRequest<T>(payload: AuthNetObject, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const data = await response.json() as T;
    const root = asRecord(data);
    const first = asRecord(Object.values(root)[0]);
    const messages = asRecord(first.messages);
    const resultCode = asString(messages.resultCode);
    if (resultCode && resultCode !== "Ok") {
      const message = asRecord(asArray(messages.message)[0]);
      throw new Error(`${asString(message.code) || "AuthorizeNetError"} ${asString(message.text) || "Authorize.net request failed."}`.trim());
    }
    return data;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export async function fetchSettledBatchIds(from: string, to: string, signal?: AbortSignal) {
  const data = await authorizeNetRequest<{ getSettledBatchListResponse?: { batchList?: { batch?: unknown } } }>({
    getSettledBatchListRequest: {
      merchantAuthentication: merchantAuthentication(),
      includeStatistics: true,
      firstSettlementDate: `${from}T00:00:00Z`,
      lastSettlementDate: `${to}T23:59:59Z`,
    },
  }, signal);
  return asArray(data.getSettledBatchListResponse?.batchList?.batch).map((batch) => ({
    batchId: asString(batch.batchId),
    settledAt: asString(batch.settlementTimeUTC || batch.settlementTimeLocal),
  })).filter((batch) => batch.batchId);
}

export async function fetchTransactionIdsForBatch(batchId: string, signal?: AbortSignal) {
  const data = await authorizeNetRequest<{ getTransactionListResponse?: { transactions?: { transaction?: unknown } } }>({
    getTransactionListRequest: {
      merchantAuthentication: merchantAuthentication(),
      batchId,
    },
  }, signal);
  return asArray(data.getTransactionListResponse?.transactions?.transaction).map((transaction) => asString(transaction.transId)).filter(Boolean);
}

export async function fetchUnsettledTransactionIds(signal?: AbortSignal) {
  const data = await authorizeNetRequest<{ getUnsettledTransactionListResponse?: { transactions?: { transaction?: unknown } } }>({
    getUnsettledTransactionListRequest: {
      merchantAuthentication: merchantAuthentication(),
    },
  }, signal);
  return asArray(data.getUnsettledTransactionListResponse?.transactions?.transaction).map((transaction) => asString(transaction.transId)).filter(Boolean);
}

export async function fetchTransactionDetails(transactionId: string, signal?: AbortSignal) {
  const data = await authorizeNetRequest<{ getTransactionDetailsResponse?: { transaction?: unknown } }>({
    getTransactionDetailsRequest: {
      merchantAuthentication: merchantAuthentication(),
      transId: transactionId,
    },
  }, signal);
  return asRecord(data.getTransactionDetailsResponse?.transaction);
}

export function normalizeAuthorizeNetTransaction(transaction: AuthNetObject, importedAt = new Date().toISOString()): Partial<AuthorizeNetTransactionDocument> {
  const order = asRecord(transaction.order);
  const customer = asRecord(transaction.customer);
  const billTo = asRecord(transaction.billTo);
  const payment = asRecord(transaction.payment);
  const creditCard = asRecord(payment.creditCard);
  const profile = asRecord(transaction.profile);
  const customerProfile = asRecord(customer.profile);
  const paymentProfile = asRecord(profile.paymentProfile || transaction.paymentProfile || customer.paymentProfile);
  const firstName = asString(billTo.firstName);
  const lastName = asString(billTo.lastName);
  const email = normalizedEmail(customer.email || billTo.email || transaction.email || transaction.customerEmail);
  const cardNumber = asString(creditCard.cardNumber || payment.cardNumber || transaction.accountNumber);
  const submittedAt = asString(transaction.submitTimeUTC || transaction.submitTimeLocal);
  const profileId = asString(profile.customerProfileId || customerProfile.customerProfileId || transaction.customerProfileId || customer.id);
  const paymentProfileId = asString(profile.customerPaymentProfileId || paymentProfile.customerPaymentProfileId || transaction.customerPaymentProfileId);
  return {
    transactionId: asString(transaction.transId),
    transactionStatus: asString(transaction.transactionStatus),
    responseCode: asString(transaction.responseCode),
    authCode: asString(transaction.authCode),
    invoiceNumber: asString(order.invoiceNumber),
    description: asString(order.description),
    amount: asNumber(transaction.settleAmount || transaction.authAmount),
    currency: asString(transaction.currencyCode || "USD"),
    submittedAt,
    settledAt: asString(transaction.settleTimeUTC || transaction.settleTimeLocal || (asString(transaction.transactionStatus).toLowerCase().includes("settled") ? submittedAt : "")),
    customerEmail: email,
    normalizedEmail: email,
    emailNormalized: email,
    customerName: normalizedName(firstName, lastName) || normalizedName(customer.firstName, customer.lastName) || asString(customer.id),
    billingFirstName: firstName,
    billingLastName: lastName,
    billingCompany: asString(billTo.company),
    billingPhone: normalizedPhone(billTo.phoneNumber || customer.phoneNumber || transaction.phoneNumber),
    cardType: asString(creditCard.cardType || payment.cardType || transaction.accountType),
    cardLast4: last4(cardNumber),
    paymentMethod: "card",
    customerProfileId: profileId,
    customerPaymentProfileId: paymentProfileId,
    rawSafeMeta: [
      { key: "accountType", value: asString(transaction.accountType).slice(0, 120) },
      { key: "marketType", value: asString(transaction.marketType).slice(0, 120) },
      { key: "product", value: asString(transaction.product).slice(0, 120) },
    ].filter((item) => item.value),
    importedAt,
  };
}

export function isSettledSuccessful(status: string) {
  const normalized = status.toLowerCase();
  return normalized.includes("settled") || normalized.includes("captured");
}

export function isDeclinedOrFailed(status: string) {
  const normalized = status.toLowerCase();
  return normalized.includes("declin") || normalized.includes("fail") || normalized.includes("void") || normalized.includes("error");
}
