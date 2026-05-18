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

function authorizeNetConfigured() {
  return Boolean(process.env.AUTHORIZE_NET_API_LOGIN_ID && process.env.AUTHORIZE_NET_TRANSACTION_KEY);
}

function inferProvider(order: Pick<CustomerOrderHistoryItem, "paymentMethod" | "paymentMethodTitle">) {
  const method = (order.paymentMethod ?? "").toLowerCase();
  const title = (order.paymentMethodTitle ?? "").toLowerCase();
  const value = `${method} ${title}`;
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
  if (value.includes("stripe")) return "stripe";
  if (nmiLike) return "nmi";
  if (
    value.includes("authorize_net") ||
    value.includes("authorize.net") ||
    value.includes("authorize") ||
    value.includes("cim") ||
    value.includes("credit card payment")
  ) return "authorize_net";
  if (value.includes("nmi") || value.includes("quick pay")) return "nmi";
  if (value.includes("cliq")) return "cliq";
  if (value.includes("crypto")) return "crypto";
  return value.trim() ? "unknown_gateway" : "woocommerce";
}

function providerConfigured(provider: string) {
  if (provider === "nmi") return nmiConfigured();
  if (provider === "stripe") return Boolean(process.env.STRIPE_SECRET_KEY);
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

  if (provider === "authorize_net" && options.verifyGateways) {
    return verifyAuthorizeNetOrder(order);
  }

  if (provider === "nmi" && options.verifyGateways) {
    return verifyNmiOrder(order);
  }

  return baseVerification(order, provider, {
    configured,
    transactionStatus: isCryptoHold ? "on_hold" : "not_verified",
    rawSummary: provider === "authorize_net" && configured
      ? "Authorize.net verification skipped. Run single customer sync with verifyGateways=true to check Authorize.net."
      : provider === "nmi" && configured
      ? "NMI verification skipped. Run single customer sync with verifyGateways=true to check NMI Query API."
      : configured
        ? "Gateway API verification is not implemented for this provider yet. Manual verification required."
        : "Gateway verification not configured.",
    notes: isCryptoHold
      ? "Crypto order on hold. No completed payment verified."
      : provider === "authorize_net" && configured
        ? "Authorize.net verification was not requested for this sync."
      : provider === "nmi" && configured
        ? "NMI verification was not requested for this sync."
        : configured
          ? "No completed payment found by safe placeholder verification."
          : "Gateway verification not configured.",
  });
}
