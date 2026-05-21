import type { AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";

const apiLoginId = process.env.AUTHORIZE_NET_API_LOGIN_ID ?? "";
const transactionKey = process.env.AUTHORIZE_NET_TRANSACTION_KEY ?? "";
const environment = (process.env.AUTHORIZE_NET_ENVIRONMENT ?? "production").toLowerCase();
const endpoint = environment.includes("sandbox") || environment.includes("test")
  ? "https://apitest.authorize.net/xml/v1/request.api"
  : "https://api.authorize.net/xml/v1/request.api";

type AuthNetObject = Record<string, unknown>;

export type AuthorizeNetCustomerProfileSummary = {
  customerProfileId: string;
  merchantCustomerId: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  phone: string;
  cardLast4s: string[];
  customerPaymentProfileIds: string[];
};

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
  const data = await authorizeNetRequest<{ batchList?: unknown; getSettledBatchListResponse?: { batchList?: { batch?: unknown } | unknown } }>({
    getSettledBatchListRequest: {
      merchantAuthentication: merchantAuthentication(),
      includeStatistics: true,
      firstSettlementDate: `${from}T00:00:00Z`,
      lastSettlementDate: `${to}T23:59:59Z`,
    },
  }, signal);
  const batches = asArray(data.batchList).length
    ? asArray(data.batchList)
    : asArray(asRecord(data.getSettledBatchListResponse?.batchList).batch || data.getSettledBatchListResponse?.batchList);
  return batches.map((batch) => ({
    batchId: asString(batch.batchId),
    settledAt: asString(batch.settlementTimeUTC || batch.settlementTimeLocal),
  })).filter((batch) => batch.batchId);
}

export async function fetchTransactionIdsForBatch(batchId: string, signal?: AbortSignal) {
  const data = await authorizeNetRequest<{ transactions?: unknown; getTransactionListResponse?: { transactions?: { transaction?: unknown } | unknown } }>({
    getTransactionListRequest: {
      merchantAuthentication: merchantAuthentication(),
      batchId,
    },
  }, signal);
  const transactions = asArray(data.transactions).length
    ? asArray(data.transactions)
    : asArray(asRecord(data.getTransactionListResponse?.transactions).transaction || data.getTransactionListResponse?.transactions);
  return transactions.map((transaction) => asString(transaction.transId)).filter(Boolean);
}

export async function fetchBatchTransactionSummaries(batchId: string, signal?: AbortSignal) {
  const data = await authorizeNetRequest<{ transactions?: unknown; getTransactionListResponse?: { transactions?: { transaction?: unknown } | unknown } }>({
    getTransactionListRequest: {
      merchantAuthentication: merchantAuthentication(),
      batchId,
    },
  }, signal);
  const transactions = asArray(data.transactions).length
    ? asArray(data.transactions)
    : asArray(asRecord(data.getTransactionListResponse?.transactions).transaction || data.getTransactionListResponse?.transactions);
  return transactions.map((transaction) => ({
    transactionId: asString(transaction.transId),
    invoiceNumber: asString(transaction.invoiceNumber),
    firstName: asString(transaction.firstName),
    lastName: asString(transaction.lastName),
    transactionStatus: asString(transaction.transactionStatus),
    amount: asNumber(transaction.settleAmount || transaction.authAmount || transaction.amount),
    cardLast4: last4(asString(transaction.accountNumber)),
    customerProfileId: asString(asRecord(transaction.profile).customerProfileId),
  })).filter((transaction) => transaction.transactionId);
}

export async function fetchUnsettledTransactionIds(signal?: AbortSignal) {
  const data = await authorizeNetRequest<{ getUnsettledTransactionListResponse?: { transactions?: { transaction?: unknown } } }>({
    getUnsettledTransactionListRequest: {
      merchantAuthentication: merchantAuthentication(),
    },
  }, signal);
  return asArray(data.getUnsettledTransactionListResponse?.transactions?.transaction).map((transaction) => asString(transaction.transId)).filter(Boolean);
}

export async function fetchTransactionIdsForCustomerProfile(customerProfileId: string, limit = 100, offset = 1, signal?: AbortSignal) {
  const data = await authorizeNetRequest<{ transactions?: unknown; getTransactionListForCustomerResponse?: { transactions?: { transaction?: unknown } } }>({
    getTransactionListForCustomerRequest: {
      merchantAuthentication: merchantAuthentication(),
      customerProfileId,
      sorting: {
        orderBy: "submitTimeUTC",
        orderDescending: true,
      },
      paging: {
        limit,
        offset,
      },
    },
  }, signal);
  const transactions = asArray(data.transactions).length
    ? asArray(data.transactions)
    : asArray(data.getTransactionListForCustomerResponse?.transactions?.transaction);
  return transactions.map((transaction) => asString(transaction.transId)).filter(Boolean);
}

export async function fetchTransactionDetails(transactionId: string, signal?: AbortSignal) {
  const data = await authorizeNetRequest<{ transaction?: unknown; getTransactionDetailsResponse?: { transaction?: unknown } }>({
    getTransactionDetailsRequest: {
      merchantAuthentication: merchantAuthentication(),
      transId: transactionId,
    },
  }, signal);
  return asRecord(data.transaction || data.getTransactionDetailsResponse?.transaction);
}

export async function fetchCustomerProfileIds(signal?: AbortSignal) {
  const data = await authorizeNetRequest<{ ids?: unknown; getCustomerProfileIdsResponse?: { ids?: { numericString?: unknown } } }>({
    getCustomerProfileIdsRequest: {
      merchantAuthentication: merchantAuthentication(),
    },
  }, signal);
  const ids = asArray(data.ids).length
    ? asArray(data.ids)
    : asArray(data.getCustomerProfileIdsResponse?.ids?.numericString);
  return ids.map((value) => asString(asRecord(value).numericString || value)).filter(Boolean);
}

export async function fetchCustomerProfile(customerProfileId: string, signal?: AbortSignal): Promise<AuthorizeNetCustomerProfileSummary> {
  const data = await authorizeNetRequest<{ profile?: unknown; getCustomerProfileResponse?: { profile?: unknown } }>({
    getCustomerProfileRequest: {
      merchantAuthentication: merchantAuthentication(),
      customerProfileId,
      unmaskExpirationDate: false,
      includeIssuerInfo: false,
    },
  }, signal);
  const profile = asRecord(data.profile || data.getCustomerProfileResponse?.profile);
  const paymentProfilesRoot = asRecord(profile.paymentProfiles);
  const paymentProfiles = asArray(
    paymentProfilesRoot.customerPaymentProfileMaskedType || paymentProfilesRoot.paymentProfile || profile.paymentProfiles
  );
  const primaryBillTo = asRecord(paymentProfiles[0]?.billTo);
  const cardLast4s = paymentProfiles.map((paymentProfile) => {
    const payment = asRecord(paymentProfile.payment);
    const creditCard = asRecord(payment.creditCard);
    return last4(asString(creditCard.cardNumber || paymentProfile.accountNumber));
  }).filter(Boolean);
  return {
    customerProfileId: asString(profile.customerProfileId || customerProfileId),
    merchantCustomerId: asString(profile.merchantCustomerId),
    email: normalizedEmail(profile.email),
    firstName: asString(primaryBillTo.firstName),
    lastName: asString(primaryBillTo.lastName),
    company: asString(primaryBillTo.company),
    phone: normalizedPhone(primaryBillTo.phoneNumber || primaryBillTo.phone),
    cardLast4s: Array.from(new Set(cardLast4s)),
    customerPaymentProfileIds: paymentProfiles.map((paymentProfile) => asString(paymentProfile.customerPaymentProfileId || paymentProfile.paymentProfileId)).filter(Boolean),
  };
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
  if (isRefundedOrChargeback(status) || isDeclinedOrFailed(status)) return false;
  if (normalized.includes("pending")) return false;
  return normalized.includes("settled");
}

export function isDeclinedOrFailed(status: string) {
  const normalized = status.toLowerCase();
  return normalized.includes("declin") || normalized.includes("fail") || normalized.includes("void") || normalized.includes("error");
}

export function isPendingSettlement(status: string) {
  const normalized = status.toLowerCase();
  return normalized.includes("pending") || normalized.includes("captured");
}

export function isRefundedOrChargeback(status: string) {
  const normalized = status.toLowerCase();
  return normalized.includes("refund") || normalized.includes("chargeback") || normalized.includes("charge back");
}
