import { NextResponse } from "next/server";
import { fetchNmiTransactions, isNmiConfigured } from "@/lib/nmiQuickPay";
import { fetchSettledBatchIds, isAuthorizeNetConfigured } from "@/lib/authorizeNet";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";

export const dynamic = "force-dynamic";

type GatewayWindow = {
  start: string;
  end: string;
};

type AuthMerchantDetails = {
  merchantName: string;
  gatewayId: string;
  processorName: string;
  rawKeys: string[];
};

const authEnvironment = (process.env.AUTHORIZE_NET_ENVIRONMENT ?? "production").toLowerCase();
const authEndpoint = authEnvironment.includes("sandbox") || authEnvironment.includes("test")
  ? "https://apitest.authorize.net/xml/v1/request.api"
  : "https://api.authorize.net/xml/v1/request.api";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function maskValue(value: string) {
  if (!value) return "";
  if (value.length <= 4) return `${value[0] ?? ""}***`;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function dateOnly(value: Date | string) {
  const date = value instanceof Date ? value : new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isOnOrBefore(a: string, b: string) {
  return new Date(`${a}T00:00:00Z`).getTime() <= new Date(`${b}T00:00:00Z`).getTime();
}

function minDate(a: string, b: string) {
  return isOnOrBefore(a, b) ? a : b;
}

function windowsBetween(startDate: string, endDate: string, windowDays = 31) {
  const windows: GatewayWindow[] = [];
  for (let start = startDate; isOnOrBefore(start, endDate); start = addDays(start, windowDays)) {
    windows.push({ start, end: minDate(addDays(start, windowDays - 1), endDate) });
  }
  return windows;
}

function minIso(values: string[]) {
  return values.filter(Boolean).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] ?? "";
}

function maxIso(values: string[]) {
  return values.filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? "";
}

async function fetchAuthorizeNetMerchantDetails(): Promise<{ details: AuthMerchantDetails | null; warning: string }> {
  const apiLoginId = process.env.AUTHORIZE_NET_API_LOGIN_ID ?? "";
  const transactionKey = process.env.AUTHORIZE_NET_TRANSACTION_KEY ?? "";
  if (!apiLoginId || !transactionKey) return { details: null, warning: "Authorize.net API login ID or transaction key is missing." };
  try {
    const response = await fetch(authEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        getMerchantDetailsRequest: {
          merchantAuthentication: { name: apiLoginId, transactionKey },
        },
      }),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return { details: null, warning: `Authorize.net merchant details returned HTTP ${response.status}.` };
    const root = asRecord(data.getMerchantDetailsResponse ?? data);
    const messages = asRecord(root.messages);
    const resultCode = asString(messages.resultCode);
    if (resultCode && resultCode !== "Ok") {
      const message = Array.isArray(messages.message) ? asRecord(messages.message[0]) : asRecord(messages.message);
      return { details: null, warning: `${asString(message.code) || "AuthorizeNetError"} ${asString(message.text) || "Merchant details request failed."}`.trim() };
    }
    return {
      details: {
        merchantName: asString(root.merchantName),
        gatewayId: asString(root.gatewayId || root.merchantId || root.merchantCustomerId),
        processorName: asString(root.processorName),
        rawKeys: Object.keys(root).sort(),
      },
      warning: "",
    };
  } catch (error) {
    return { details: null, warning: error instanceof Error ? error.message : "Authorize.net merchant details request failed." };
  }
}

async function scanAuthorizeNetBatches(windows: GatewayWindow[]) {
  const dates: string[] = [];
  const notes: string[] = [];
  let batchCount = 0;
  let windowsWithBatchesBefore2023 = 0;
  let windowsChecked = 0;

  for (const window of windows) {
    windowsChecked += 1;
    try {
      const batches = await fetchSettledBatchIds(window.start, window.end);
      batchCount += batches.length;
      if (batches.length && window.start < "2023-01-01") windowsWithBatchesBefore2023 += 1;
      dates.push(...batches.map((batch) => batch.settledAt || window.start).filter(Boolean));
    } catch (error) {
      notes.push(`${window.start} to ${window.end}: ${error instanceof Error ? error.message : "Authorize.net batch probe failed."}`);
    }
  }

  return {
    oldestAvailableDate: minIso(dates),
    latestAvailableDate: maxIso(dates),
    batchCount,
    windowsChecked,
    batchesBefore2023: windowsWithBatchesBefore2023 > 0,
    notes,
  };
}

async function scanNmiTransactions(windows: GatewayWindow[]) {
  const dates: string[] = [];
  const notes: string[] = [];
  const ids = new Set<string>();
  let windowsChecked = 0;
  let transactionsBefore2025 = 0;

  for (const window of windows) {
    windowsChecked += 1;
    const result = await fetchNmiTransactions({ from: window.start, to: window.end });
    if (result.warning) notes.push(`${window.start} to ${window.end}: ${result.warning}`);
    for (const transaction of result.transactions) {
      const id = asString(transaction.transactionId);
      if (id) ids.add(id);
      const submittedAt = asString(transaction.settledAt || transaction.submittedAt);
      if (submittedAt) {
        dates.push(submittedAt);
        if (submittedAt < "2025-01-01") transactionsBefore2025 += 1;
      }
    }
  }

  return {
    oldestAvailableDate: minIso(dates),
    latestAvailableDate: maxIso(dates),
    transactionCount: ids.size,
    windowsChecked,
    transactionsBefore2025,
    notes,
  };
}

function statusForGateway(configured: boolean, oldestLiveDate: string, hadExpectedHistoricalRecords: boolean) {
  if (!configured) return "not_configured";
  if (!oldestLiveDate) return "configured_no_live_history_returned";
  if (hadExpectedHistoricalRecords) return "historical_access_confirmed";
  return "configured_partial_history_returned";
}

export async function GET() {
  const started = Date.now();
  await connectToDatabase();

  const today = dateOnly(new Date());
  const diagnosticWindows = windowsBetween("2020-01-01", today, 31);
  const authConfigured = isAuthorizeNetConfigured();
  const nmiConfigured = isNmiConfigured();

  const [
    storedAuthTransactions,
    storedNmiTransactions,
    authMerchant,
    authLive,
    nmiLive,
  ] = await Promise.all([
    AuthorizeNetTransaction.find({}, { settledAt: 1, submittedAt: 1 }).lean<AuthorizeNetTransactionDocument[]>(),
    NmiQuickPayTransaction.find({}, { settledAt: 1, submittedAt: 1 }).lean<NmiQuickPayTransactionDocument[]>(),
    authConfigured ? fetchAuthorizeNetMerchantDetails() : Promise.resolve({ details: null, warning: "Authorize.net is not configured." }),
    authConfigured ? scanAuthorizeNetBatches(diagnosticWindows) : Promise.resolve({ oldestAvailableDate: "", latestAvailableDate: "", batchCount: 0, windowsChecked: 0, batchesBefore2023: false, notes: [] as string[] }),
    nmiConfigured ? scanNmiTransactions(diagnosticWindows) : Promise.resolve({ oldestAvailableDate: "", latestAvailableDate: "", transactionCount: 0, windowsChecked: 0, transactionsBefore2025: 0, notes: [] as string[] }),
  ]);

  const authStoredDates = storedAuthTransactions.map((transaction) => asString(transaction.settledAt || transaction.submittedAt)).filter(Boolean);
  const nmiStoredDates = storedNmiTransactions.map((transaction) => asString(transaction.settledAt || transaction.submittedAt)).filter(Boolean);
  const authStoredOldestDate = minIso(authStoredDates);
  const authStoredLatestDate = maxIso(authStoredDates);
  const nmiStoredOldestDate = minIso(nmiStoredDates);
  const nmiStoredLatestDate = maxIso(nmiStoredDates);

  const authorizeNetNotes = [
    `Environment: ${authEnvironment.includes("sandbox") || authEnvironment.includes("test") ? "sandbox" : "production"}.`,
    `API login ID configured: ${Boolean(process.env.AUTHORIZE_NET_API_LOGIN_ID)}${process.env.AUTHORIZE_NET_API_LOGIN_ID ? ` (${maskValue(process.env.AUTHORIZE_NET_API_LOGIN_ID)})` : ""}.`,
    `Merchant account ID/gateway ID from API: ${authMerchant.details?.gatewayId || "not exposed by merchant details response"}.`,
    authMerchant.details?.merchantName ? `Merchant name returned by API: ${authMerchant.details.merchantName}.` : "Merchant name was not returned by the API.",
    authMerchant.warning ? `Merchant details warning: ${authMerchant.warning}` : "Merchant details API responded successfully.",
    authLive.batchesBefore2023 ? "Batch list API returned at least one settled batch before 2023." : "Batch list API returned no settled batches before 2023 during diagnostics.",
    authLive.oldestAvailableDate ? `Oldest live settled batch date found: ${authLive.oldestAvailableDate}.` : "No live settled batch date was returned by the diagnostics scan.",
    authStoredOldestDate ? `Oldest stored Authorize.net transaction date: ${authStoredOldestDate}.` : "No stored Authorize.net transactions found.",
    "Authorize.net account migration and permission restrictions cannot be proven from stored transactions alone; absence of old batches from a valid production credential is consistent with no access to that historical merchant account, a processor/account migration, retention limits, or no settled batches in that account.",
    ...authLive.notes.slice(0, 10),
  ];

  const nmiNotes = [
    `NMI security key configured: ${nmiConfigured}.`,
    `NMI base URL: ${(process.env.NMI_BASE_URL || "https://secure.nmi.com").replace(/\/$/, "")}.`,
    nmiLive.oldestAvailableDate ? `Earliest transaction returned by Query API diagnostics: ${nmiLive.oldestAvailableDate}.` : "NMI Query API diagnostics returned no transactions.",
    nmiStoredOldestDate ? `Oldest stored NMI transaction date: ${nmiStoredOldestDate}.` : "No stored NMI transactions found.",
    nmiLive.transactionsBefore2025 > 0 ? "NMI Query API returned transactions before 2025." : "NMI Query API returned no transactions before 2025 during diagnostics.",
    "NMI account creation date and retention limits are not exposed by this Query API response; infer them from the earliest returned transaction and gateway admin records.",
    ...nmiLive.notes.slice(0, 10),
  ];

  return NextResponse.json({
    authorizeNet: {
      oldestAvailableDate: authLive.oldestAvailableDate || authStoredOldestDate,
      latestAvailableDate: authLive.latestAvailableDate || authStoredLatestDate,
      batchCount: authLive.batchCount,
      historicalAccessStatus: statusForGateway(authConfigured, authLive.oldestAvailableDate || authStoredOldestDate, authLive.batchesBefore2023),
      notes: authorizeNetNotes,
      diagnostics: {
        configured: authConfigured,
        environment: authEnvironment.includes("sandbox") || authEnvironment.includes("test") ? "sandbox" : "production",
        apiLoginIdMasked: maskValue(process.env.AUTHORIZE_NET_API_LOGIN_ID ?? ""),
        merchantAccountId: authMerchant.details?.gatewayId ?? "",
        merchantName: authMerchant.details?.merchantName ?? "",
        processorName: authMerchant.details?.processorName ?? "",
        merchantDetailsResponseKeys: authMerchant.details?.rawKeys ?? [],
        windowsChecked: authLive.windowsChecked,
        batchListReturnedBefore2023: authLive.batchesBefore2023,
        storedTransactionCount: storedAuthTransactions.length,
        storedOldestDate: authStoredOldestDate,
        storedLatestDate: authStoredLatestDate,
      },
    },
    nmi: {
      oldestAvailableDate: nmiLive.oldestAvailableDate || nmiStoredOldestDate,
      latestAvailableDate: nmiLive.latestAvailableDate || nmiStoredLatestDate,
      transactionCount: nmiLive.transactionCount,
      historicalAccessStatus: statusForGateway(nmiConfigured, nmiLive.oldestAvailableDate || nmiStoredOldestDate, nmiLive.transactionsBefore2025 > 0),
      notes: nmiNotes,
      diagnostics: {
        configured: nmiConfigured,
        baseUrl: (process.env.NMI_BASE_URL || "https://secure.nmi.com").replace(/\/$/, ""),
        windowsChecked: nmiLive.windowsChecked,
        queryReturnedBefore2025: nmiLive.transactionsBefore2025 > 0,
        storedTransactionCount: storedNmiTransactions.length,
        storedOldestDate: nmiStoredOldestDate,
        storedLatestDate: nmiStoredLatestDate,
      },
    },
    totalMs: Date.now() - started,
  });
}
