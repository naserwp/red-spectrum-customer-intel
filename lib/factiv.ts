import type { CustomerDocument, CustomerFactiivProfile } from "@/models/Customer";
import { resolveFactiivScore } from "@/lib/factivScore";

const factiivApiBaseUrl = process.env.FACTIIV_API_BASE_URL?.trim() || "https://api.credit.factiiv.io";
const factiivApiToken = process.env.FACTIIV_API_TOKEN?.trim() || "";
const factiivFetchTimeoutMs = 15000;

type FactiivApiRecord = Record<string, unknown>;

type FactiivApiResponse = {
  payload?: FactiivApiRecord[];
  data?: FactiivApiRecord[];
  records?: FactiivApiRecord[];
  results?: FactiivApiRecord[];
  accounts?: FactiivApiRecord[];
};

export type FactiivSyncResult = {
  profile: CustomerFactiivProfile;
  warnings: string[];
};

export type FactiivSearchResult = {
  profileId: string;
  businessName: string;
  email: string;
  username: string;
  factiivScore: number;
  tradeQuantity: number;
  tradeAmountTotal: number;
  tradeBalanceTotal: number;
  rawSummary: string;
  matchConfidence: string;
  matchReason: string;
  selectedProfileData: CustomerFactiivProfile;
};

function asNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeText(value: unknown) {
  return asText(value).toLowerCase();
}

function normalizePhone(value: unknown) {
  return asText(value).replace(/\D/g, "");
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function getRecordValue(record: FactiivApiRecord, keys: string[]) {
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if (keys.includes(normalizedKey)) return value;
  }
  return "";
}

function getNestedRecordValue(record: FactiivApiRecord, keys: string[]) {
  const direct = getRecordValue(record, keys);
  if (asText(direct)) return direct;
  for (const value of Object.values(record)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = getRecordValue(value as FactiivApiRecord, keys);
    if (asText(nested) || typeof nested === "number") return nested;
  }
  return "";
}

function summarizeRecord(record: FactiivApiRecord) {
  const pairs = Object.entries(record)
    .filter(([, value]) => value !== null && value !== undefined && (typeof value === "object" ? true : String(value).trim() !== ""))
    .slice(0, 12)
    .map(([key, value]) => `${key}:${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  return pairs.join(" | ");
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function mapFactiivTrades(record: FactiivApiRecord) {
  return asArray((record as { trades?: unknown[] }).trades).map((trade) => {
    const row = trade as FactiivApiRecord;
    const amount = asNumber(getNestedRecordValue(row, ["amount", "highcreditlimit", "high_credit_limit"]));
    const balance = asNumber(getNestedRecordValue(row, ["balance", "currentbalance", "current_balance"]));
    return {
      tradeId: asText(getNestedRecordValue(row, ["id", "tradeid"])),
      tradeName: asText(getNestedRecordValue(row, ["name", "trade_name", "typedesc", "relationdescription"])) || "Trade",
      tradeType: asText(getNestedRecordValue(row, ["typedesc", "type", "trade_type"])),
      relation: asText(getNestedRecordValue(row, ["relationdescription", "relation"])),
      amount,
      balance,
      tradeStatus: asText(getNestedRecordValue(row, ["tradestatus", "status"])),
      adminStatus: asText(getNestedRecordValue(row, ["adminstatus", "admin_status"])),
      fromCompanyName: asText(getNestedRecordValue(row, ["fromcompanyname", "from_company_name"])),
      toCompanyName: asText(getNestedRecordValue(row, ["tocompanyname", "to_company_name"])),
      lastActivity: asText(getNestedRecordValue(row, ["lastactivity", "updatedat", "createdat"])),
      utilizationPercent: amount > 0 ? Math.round((balance / amount) * 10000) / 100 : 0,
    };
  });
}

function mapFactiivActivities(record: FactiivApiRecord) {
  const rows = asArray((record as { activities?: unknown[]; activityHistory?: unknown[] }).activities)
    .concat(asArray((record as { activityHistory?: unknown[] }).activityHistory));
  return rows.map((activity) => {
    const row = activity as FactiivApiRecord;
    const daysLate = asNumber(getNestedRecordValue(row, ["dayslate", "days_late"]));
    return {
      activityDate: asText(getNestedRecordValue(row, ["activitydate", "date", "createdat", "paymentdate"])),
      activityType: asText(getNestedRecordValue(row, ["activitytype", "type"])),
      paymentAmount: asNumber(getNestedRecordValue(row, ["paymentamount", "payment_amount"])),
      chargeAmount: asNumber(getNestedRecordValue(row, ["chargeamount", "charge_amount"])),
      interest: asNumber(getNestedRecordValue(row, ["interest", "interestamount", "interest_amount"])),
      daysLate,
      paymentStatus: daysLate > 0 ? "late" : "on_time",
    };
  });
}

function buildSearchQueries(customer: Partial<CustomerDocument>) {
  const email = customer.normalizedEmail || customer.email?.trim().toLowerCase() || "";
  const business = customer.businessProfile?.company?.trim() || "";
  const username = email.includes("@") ? email.split("@")[0] : "";
  return unique([email, business, username]);
}

async function fetchFactiivAccounts(query: string, limit = 20) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), factiivFetchTimeoutMs);
  try {
    const url = new URL("/api/v1/public/accounts", factiivApiBaseUrl);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(Math.min(20, Math.max(1, limit))));
    const headers: Record<string, string> = {};
    if (factiivApiToken) headers.Authorization = `Bearer ${factiivApiToken}`;
    const response = await fetch(url.toString(), { headers, signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Factiiv request failed: ${response.status}`);
    return await response.json() as FactiivApiResponse | FactiivApiRecord[];
  } finally {
    clearTimeout(timeout);
  }
}

function extractRecords(payload: FactiivApiResponse | FactiivApiRecord[]) {
  if (Array.isArray(payload)) return payload;
  return payload.payload ?? payload.data ?? payload.records ?? payload.results ?? payload.accounts ?? [];
}

function scoreMatch(customer: Partial<CustomerDocument>, record: FactiivApiRecord, query: string) {
  const normalizedEmail = normalizeText(customer.normalizedEmail || customer.email);
  const normalizedBusiness = normalizeText(customer.businessProfile?.company);
  const normalizedName = normalizeText(customer.name);
  const normalizedPhone = normalizePhone(customer.phone || customer.businessProfile?.phone);

  const recordEmail = normalizeText(getNestedRecordValue(record, ["email", "matchedemail", "user_email"]));
  const recordBusiness = normalizeText(getNestedRecordValue(record, ["businessname", "company", "matchedbusinessname", "business_name"]));
  const recordUsername = normalizeText(getNestedRecordValue(record, ["username", "matchedusername", "user_name", "ownername"]));
  const recordPhone = normalizePhone(getNestedRecordValue(record, ["phone", "user_phone", "telephone", "phonenumber"]));

  let score = 0;
  const reasons: string[] = [];
  if (normalizedEmail && recordEmail && normalizedEmail === recordEmail) {
    score += 70;
    reasons.push("email_exact");
  }
  if (normalizedBusiness && recordBusiness && normalizedBusiness === recordBusiness) {
    score += 55;
    reasons.push("business_exact");
  } else if (normalizedBusiness && recordBusiness && (recordBusiness.includes(normalizedBusiness) || normalizedBusiness.includes(recordBusiness))) {
    score += 35;
    reasons.push("business_partial");
  }
  if (normalizedName && recordUsername && normalizedName.includes(recordUsername)) {
    score += 20;
    reasons.push("username_name_overlap");
  }
  if (normalizedPhone && recordPhone && normalizedPhone.endsWith(recordPhone.slice(-7))) {
    score += 25;
    reasons.push("phone_tail_match");
  }
  if (query && (recordEmail.includes(query.toLowerCase()) || recordBusiness.includes(query.toLowerCase()) || recordUsername.includes(query.toLowerCase()))) {
    score += 10;
    reasons.push("query_overlap");
  }
  return { score, reasons };
}

function mapFactiivRecord(record: FactiivApiRecord, query: string, matchReason: string, confidence: string): CustomerFactiivProfile {
  const resolvedScore = resolveFactiivScore(record);
  const score = asNumber(getNestedRecordValue(record, ["score"]));
  const businessScore = asNumber(getNestedRecordValue(record, ["businessscore", "business_score"]));
  const creditScore = asNumber(getNestedRecordValue(record, ["creditscore", "credit_score"]));
  return {
    profileId: asText(getNestedRecordValue(record, ["profileid", "id", "accountid", "publicaccountid"])),
    factiivProfileId: asText(getNestedRecordValue(record, ["id", "profileid", "accountid", "publicaccountid"])),
    score,
    businessScore,
    creditScore,
    report: getRecordValue(record, ["report"]) as Record<string, unknown>,
    analytics: getRecordValue(record, ["analytics"]) as Record<string, unknown>,
    funding: getRecordValue(record, ["funding"]) as Record<string, unknown>,
    factiivScore: asNumber(resolvedScore.scoreValue ?? getNestedRecordValue(record, ["factiivscore", "factivscore"])),
    reputationScore: asNumber(getNestedRecordValue(record, ["reputationscore"])),
    historyScore: asNumber(getNestedRecordValue(record, ["historyscore"])),
    utilizationScore: asNumber(getNestedRecordValue(record, ["utilizationscore"])),
    tradeQuantity: asNumber(getNestedRecordValue(record, ["tradequantity", "tradelines", "trade_lines"])),
    tradeAmountTotal: asNumber(getNestedRecordValue(record, ["tradeamounttotal", "tradetotal", "trade_amount_total"])),
    tradeBalanceTotal: asNumber(getNestedRecordValue(record, ["tradebalancetotal", "outstandingbalance", "trade_balance_total"])),
    activityQuantity: asNumber(getNestedRecordValue(record, ["activityquantity", "paymentactivitycount", "activity_count"])),
    activityPaymentAmountTotal: asNumber(getNestedRecordValue(record, ["activitypaymentamounttotal", "paymentamounttotal", "payment_activity_total"])),
    activityLastKnownBalanceTotal: asNumber(getNestedRecordValue(record, ["activitylastknownbalancetotal", "lastknownbalancetotal", "last_balance_total"])),
    matchedBusinessName: asText(getNestedRecordValue(record, ["matchedbusinessname", "businessname", "company", "business_name"])),
    matchedEmail: asText(getNestedRecordValue(record, ["matchedemail", "email", "user_email"])),
    matchedUsername: asText(getNestedRecordValue(record, ["matchedusername", "username", "user_name", "ownername"])),
    factiivMatched: true,
    factiivMatchConfidence: confidence,
    matchedBy: "auto",
    autoPersisted: false,
    autoPersistReason: "",
    factiivSearchQuery: query,
    factiivMatchReason: matchReason,
    lastFactiivSync: new Date().toISOString(),
    manualAttachedBy: "",
    manualAttachedAt: "",
    trades: mapFactiivTrades(record),
    activities: mapFactiivActivities(record),
    source: "factiv_public_accounts",
    rawSummary: summarizeRecord(record),
  };
}

export function shouldAutoPersistFactiiv(profile: CustomerFactiivProfile) {
  return profile.factiivMatchConfidence === "high" || profile.factiivMatchReason.split(",").includes("email_exact");
}

export async function searchFactiivProfiles(query: string, customer?: Partial<CustomerDocument>): Promise<FactiivSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];
  const records = extractRecords(await fetchFactiivAccounts(trimmedQuery, 20));
  return records.map((record) => {
    const match = customer ? scoreMatch(customer, record, trimmedQuery) : { score: 0, reasons: [] as string[] };
    const confidence = match.score >= 90 ? "high" : match.score >= 55 ? "medium" : match.score > 0 ? "low" : "";
    const selectedProfileData = mapFactiivRecord(record, trimmedQuery, match.reasons.join(",") || "manual_search_result", confidence || "manual");
    return {
      profileId: selectedProfileData.factiivProfileId,
      businessName: selectedProfileData.matchedBusinessName,
      email: selectedProfileData.matchedEmail,
      username: selectedProfileData.matchedUsername,
      factiivScore: selectedProfileData.factiivScore,
      tradeQuantity: selectedProfileData.tradeQuantity,
      tradeAmountTotal: selectedProfileData.tradeAmountTotal,
      tradeBalanceTotal: selectedProfileData.tradeBalanceTotal,
      rawSummary: selectedProfileData.rawSummary,
      matchConfidence: confidence || "none",
      matchReason: selectedProfileData.factiivMatchReason || "manual_search_result",
      selectedProfileData,
    };
  }).sort((a, b) =>
    (b.matchConfidence === "high" ? 3 : b.matchConfidence === "medium" ? 2 : b.matchConfidence === "low" ? 1 : 0)
    - (a.matchConfidence === "high" ? 3 : a.matchConfidence === "medium" ? 2 : a.matchConfidence === "low" ? 1 : 0)
    || b.factiivScore - a.factiivScore
  );
}

export async function syncFactiivProfile(customer: Partial<CustomerDocument>): Promise<FactiivSyncResult> {
  const warnings: string[] = [];
  const queries = buildSearchQueries(customer);
  if (!queries.length) {
    return {
      profile: {
        profileId: "",
        factiivProfileId: "",
        factiivScore: 0,
        reputationScore: 0,
        historyScore: 0,
        utilizationScore: 0,
        tradeQuantity: 0,
        tradeAmountTotal: 0,
        tradeBalanceTotal: 0,
        activityQuantity: 0,
        activityPaymentAmountTotal: 0,
        activityLastKnownBalanceTotal: 0,
        matchedBusinessName: "",
        matchedEmail: "",
        matchedUsername: "",
        factiivMatched: false,
        factiivMatchConfidence: "",
        matchedBy: "",
        autoPersisted: false,
        autoPersistReason: "",
        factiivSearchQuery: "",
        factiivMatchReason: "no_search_query",
        lastFactiivSync: new Date().toISOString(),
        manualAttachedBy: "",
        manualAttachedAt: "",
        trades: [],
        activities: [],
        source: "factiv_public_accounts",
        rawSummary: "",
      },
      warnings: ["No Factiiv search query was available for this customer."],
    };
  }

  let bestProfile: CustomerFactiivProfile | null = null;
  let bestScore = -1;

  for (const query of queries) {
    try {
      const records = extractRecords(await fetchFactiivAccounts(query, 20));
      for (const record of records) {
        const match = scoreMatch(customer, record, query);
        if (match.score <= bestScore || match.score < 20) continue;
        const confidence = match.score >= 90 ? "high" : match.score >= 55 ? "medium" : "low";
        bestScore = match.score;
        bestProfile = mapFactiivRecord(record, query, match.reasons.join(","), confidence);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Factiiv lookup failed.");
    }
  }

  return {
    profile: bestProfile ?? {
      profileId: "",
      factiivProfileId: "",
      factiivScore: 0,
      reputationScore: 0,
      historyScore: 0,
      utilizationScore: 0,
      tradeQuantity: 0,
      tradeAmountTotal: 0,
      tradeBalanceTotal: 0,
      activityQuantity: 0,
      activityPaymentAmountTotal: 0,
      activityLastKnownBalanceTotal: 0,
      matchedBusinessName: "",
      matchedEmail: "",
      matchedUsername: "",
      factiivMatched: false,
      factiivMatchConfidence: "",
      matchedBy: "",
      autoPersisted: false,
      autoPersistReason: "",
      factiivSearchQuery: queries[0] || "",
      factiivMatchReason: bestScore < 20 ? "no_confident_match" : "no_match",
      lastFactiivSync: new Date().toISOString(),
      manualAttachedBy: "",
      manualAttachedAt: "",
      trades: [],
      activities: [],
      source: "factiv_public_accounts",
      rawSummary: "",
    },
    warnings,
  };
}
