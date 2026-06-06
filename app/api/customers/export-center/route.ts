import { NextResponse } from "next/server";
import { normalizeStateCode } from "@/lib/customerBusinessResolver";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { connectToDatabase } from "@/lib/mongodb";
import { generateBusinessIndustryClassifications, type BusinessIndustryClassification, type BusinessIndustryInput } from "@/lib/openai";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

export const dynamic = "force-dynamic";

type RichExportRow = Record<string, unknown> & {
  state?: string;
  fundingScore?: number | string;
  fundingCategory?: string;
  totalAmountPaid?: number;
  factiivProfileId?: string;
  factiivScore?: number | string;
  businessVerificationScore?: number | string;
  fundingReadinessStatus?: string;
  riskLevel?: string;
};
type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

const insightColumns = [
  "businessVerificationStatus",
  "businessVerificationScore",
  "businessDataCompletenessScore",
  "fundingReadinessStatus",
  "fundingNextRequiredSteps",
  "fundingStrengths",
  "fundingWeaknesses",
  "riskLevel",
  "reviewStatus",
  "googleReviewSummary",
  "onlineReviewStatus",
];

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text && text !== "-" && text.toLowerCase() !== "missing" ? text : "";
}

function parseLimit(value: string | null) {
  if (value === "all") return 0;
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed < 1) return 100;
  return Math.min(10000, Math.floor(parsed));
}

function parsePage(value: string | null) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.floor(parsed);
}

function csvEscape(value: unknown) {
  const raw = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll("\"", "\"\"")}"` : raw;
}

function toCsv(rows: RichExportRow[], columns: string[]) {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")).join("\r\n");
  return `\uFEFF${header}\r\n${body}\r\n`;
}

function hasFactiiv(row: RichExportRow) {
  return Boolean(clean(row.factiivProfileId) || Number(row.factiivScore ?? 0) > 0);
}

function isHighValue(row: RichExportRow) {
  return Number(row.totalAmountPaid ?? 0) >= 1000 || /high/i.test(clean(row.dataConfidenceStatus));
}

function isFundingReady(row: RichExportRow) {
  return Number(row.fundingScore ?? 0) > 0 || clean(row.fundingCategory) !== "";
}

function completenessScore(row: RichExportRow) {
  const fields = ["businessName", "phoneNumber", "businessAddress", "ein", "state", "city", "businessIndustry", "industryCode"];
  const present = fields.filter((field) => clean(row[field])).length;
  return Math.round((present / fields.length) * 100);
}

function withInsightFields(row: RichExportRow) {
  const businessScore = Number(row.businessVerificationScore ?? row.fundingScore ?? 0);
  return {
    ...row,
    businessVerificationStatus: businessScore > 0 ? "Available" : "Needs Review",
    businessVerificationScore: businessScore > 0 ? businessScore : "Missing",
    businessDataCompletenessScore: completenessScore(row),
    fundingReadinessStatus: clean(row.fundingCategory) || "Needs Review",
    fundingNextRequiredSteps: clean(row.recommendedFundingProducts) ? `Review products: ${row.recommendedFundingProducts}` : "Needs manual review",
    fundingStrengths: clean(row.fundingStrengths) || "Not available",
    fundingWeaknesses: clean(row.fundingWeaknesses) || "Not available",
    riskLevel: clean(row.riskLevel) || (clean(row.dataConfidenceStatus) === "Verified" ? "low" : "needs_review"),
    reviewStatus: clean(row.dataConfidenceStatus) || "Needs Review",
    googleReviewSummary: "Not available",
    onlineReviewStatus: "Not available",
  };
}

function missingIndustryCount(rows: RichExportRow[]) {
  return rows.filter((row) => !clean(row.businessIndustry) || !clean(row.industryCode)).length;
}

function rowText(row: RichExportRow, fields: string[]) {
  return fields.map((field) => clean(row[field]).toLowerCase()).join(" ");
}

function storedIndustryClassification(customer?: LeanCustomer): BusinessIndustryClassification {
  const profile = (customer?.businessProfile ?? {}) as Record<string, unknown>;
  const publicProfile = (customer?.publicEnrichment ?? {}) as Record<string, unknown>;
  const industry = clean(profile.industry || publicProfile.inferredIndustry);
  const naics = clean(profile.naicsCode || publicProfile.naicsCode);
  const sic = clean(profile.sicCode || publicProfile.sicCode);
  return {
    businessIndustry: industry || "Missing",
    industryCode: naics || sic || "Missing",
    industryCodeType: naics ? "NAICS" : sic ? "SIC" : "NAICS",
    industryDescription: industry ? "Stored customer profile industry." : "Needs manual review",
    confidence: industry || naics || sic ? "medium" : "low",
  };
}

function industrySource(stored: BusinessIndustryClassification, resolved: BusinessIndustryClassification) {
  if (clean(stored.businessIndustry) || clean(stored.industryCode)) return "stored";
  if (clean(resolved.businessIndustry) || clean(resolved.industryCode)) return "ai";
  return "missing";
}

function sortRows(rows: RichExportRow[], sortBy: string, sortDir: string) {
  const dir = sortDir === "asc" ? 1 : -1;
  const key = sortBy || "totalAmountPaid";
  return [...rows].sort((a, b) => {
    const aValue = a[key];
    const bValue = b[key];
    const aNumber = Number(aValue);
    const bNumber = Number(bValue);
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return (aNumber - bNumber) * dir;
    return clean(aValue).localeCompare(clean(bValue)) * dir;
  });
}

async function paginatedJsonRows({
  limit,
  page,
  filter,
  state,
  factiiv,
  search,
  fundingCategory,
  paymentStatus,
  sortBy,
  sortDir,
  useAIIndustry,
  debug,
}: {
  limit: number;
  page: number;
  filter: string;
  state: string;
  factiiv: string;
  search: string;
  fundingCategory: string;
  paymentStatus: string;
  sortBy: string;
  sortDir: string;
  useAIIndustry: boolean;
  debug: boolean;
}) {
  await connectToDatabase();
  const rankingQuery: Record<string, unknown> = {};
  if (state) rankingQuery.stateCode = state;
  if (filter === "high_value") rankingQuery.lifetimeSpent = { $gte: 1000 };
  if (filter === "funding_ready") rankingQuery.fundingScore = { $gt: 0 };
  if (fundingCategory) rankingQuery.fundingCategory = { $regex: fundingCategory, $options: "i" };
  if (factiiv === "with") rankingQuery.$or = [{ factiivProfileId: { $ne: "" } }, { factiivScore: { $gt: 0 } }];
  if (factiiv === "without") rankingQuery.$and = [{ $or: [{ factiivProfileId: "" }, { factiivProfileId: { $exists: false } }] }, { $or: [{ factiivScore: 0 }, { factiivScore: { $exists: false } }] }];
  if (search) {
    const regex = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
    rankingQuery.$and = [...(Array.isArray(rankingQuery.$and) ? rankingQuery.$and : []), { $or: [{ name: regex }, { email: regex }, { businessName: regex }] }];
  }

  const sortField = sortBy === "customerName" ? "name" : sortBy === "email" ? "email" : sortBy === "lastPaidDate" ? "latestPaidDate" : sortBy === "fundingScore" ? "fundingScore" : "lifetimeSpent";
  const sort: Record<string, 1 | -1> = { [sortField]: sortDir === "asc" ? 1 : -1 };
  const skip = (page - 1) * limit;
  const rankings = await CustomerRanking.find(rankingQuery).sort(sort).skip(skip).limit(limit).lean<CustomerRankingDocument[]>();
  const totalMatching = await CustomerRanking.countDocuments(rankingQuery);
  const ids = rankings.map((ranking) => ranking.customerId).filter(Boolean);
  const emails = rankings.map((ranking) => clean(ranking.email).toLowerCase()).filter(Boolean);
  const customers = await Customer.find({ $or: [{ _id: { $in: ids } }, { normalizedEmail: { $in: emails } }, { email: { $in: emails } }] }, {
    email: 1, normalizedEmail: 1, phone: 1, businessProfile: 1, creditProfile: 1, factiivProfile: 1, publicEnrichment: 1,
    wooPaidTotal: 1, authorizeNetPaidTotal: 1, nmiQuickPayPaidTotal: 1, gatewayOnlyPaidTotal: 1,
  }).lean<LeanCustomer[]>();
  const byId = new Map(customers.map((customer) => [String(customer._id), customer]));
  const byEmail = new Map(customers.map((customer) => [clean(customer.normalizedEmail || customer.email).toLowerCase(), customer]));
  const rowContexts = rankings.map((ranking) => {
    const customer = byId.get(ranking.customerId) || byEmail.get(clean(ranking.email).toLowerCase());
    const profile = customer?.factiivProfile;
    const businessProfile = customer?.businessProfile;
    const storedIndustry = storedIndustryClassification(customer);
    const dataConfidenceStatus = Number(ranking.lifetimeSpent ?? 0) > 0 ? "Verified" : "Needs Review";
    const row: RichExportRow = {
      customerId: ranking.customerId,
      customerName: ranking.name,
      email: ranking.email,
      businessName: ranking.businessName || businessProfile?.businessName || businessProfile?.company || "Missing",
      phoneNumber: ranking.phone || customer?.phone || businessProfile?.phone || "Missing",
      businessAddress: ranking.businessAddress || businessProfile?.address1 || "Missing",
      ein: ranking.ein || businessProfile?.ein || customer?.creditProfile?.ein || "Missing",
      state: ranking.stateCode || businessProfile?.stateCode || businessProfile?.state || "Missing",
      city: ranking.city || businessProfile?.city || "Missing",
      businessIndustry: storedIndustry.businessIndustry,
      industryCode: storedIndustry.industryCode,
      industryCodeType: storedIndustry.industryCodeType,
      industryDescription: storedIndustry.industryDescription,
      factiivScore: Number(profile?.factiivScore || ranking.factiivScore || 0) > 0 ? Number(profile?.factiivScore || ranking.factiivScore) : "Missing",
      factiivMatchedBusiness: profile?.matchedBusinessName || ranking.factiivMatchedBusiness || "Missing",
      factiivTradeLines: Number(profile?.tradeQuantity || ranking.factiivTradeLines || 0) || "Missing",
      factiivTotalTradeAmount: Number(profile?.tradeAmountTotal || ranking.factiivTotalTradeAmount || 0) || "Missing",
      factiivVerifiedCreditLimit: Number(ranking.factiivVerifiedCreditLimit || businessProfile?.creditLimit || 0) || "Missing",
      totalAmountPaid: Number(ranking.lifetimeSpent ?? 0),
      lifetimeValue: Number(ranking.lifetimeSpent ?? 0),
      wooCommerceTotal: Number(customer?.wooPaidTotal ?? ranking.lifetimeSpent ?? 0),
      authorizeNetTotal: Number(customer?.authorizeNetPaidTotal ?? 0),
      stripeTotal: 0,
      nmiTotal: Number(customer?.nmiQuickPayPaidTotal ?? 0),
      successfulPaymentCount: "Missing",
      lastPaidDate: ranking.latestPaidDate || "Missing",
      fundingScore: Number(ranking.fundingScore ?? 0) || "Missing",
      fundingCategory: ranking.fundingCategory || "Missing",
      recommendedFundingProducts: Array.isArray(ranking.recommendedFundingProducts) ? ranking.recommendedFundingProducts.join("; ") : "Missing",
      dataConfidenceStatus,
    };
    if (debug) row.industryResolvedFrom = industrySource(storedIndustry, storedIndustry);
    return { row, customer, ranking, storedIndustry };
  });
  if (useAIIndustry) {
    const inputs: BusinessIndustryInput[] = rowContexts.map(({ customer, ranking, row }) => {
      const enrichment = enrichCustomerProfile(customer);
      return {
      id: clean(row.customerId) || clean(row.email),
      businessName: clean(enrichment.businessName) || clean(ranking.businessName) || clean(customer?.businessProfile?.businessName) || clean(customer?.businessProfile?.company),
      website: clean(customer?.businessProfile?.website || customer?.publicEnrichment?.publicBusinessWebsite || customer?.publicEnrichment?.websiteDomain),
      city: clean(customer?.businessProfile?.city) || "Missing",
      state: clean(enrichment.stateCode) || clean(ranking.stateCode),
      businessProfile: {
        businessName: customer?.businessProfile?.businessName,
        company: customer?.businessProfile?.company,
        businessType: customer?.businessProfile?.businessType,
        industry: customer?.businessProfile?.industry,
        industryClassification: customer?.businessProfile?.industryClassification,
        naicsCode: customer?.businessProfile?.naicsCode,
        sicCode: customer?.businessProfile?.sicCode,
        website: customer?.businessProfile?.website,
      },
      customerProfile: {
        inferredIndustry: customer?.publicEnrichment?.inferredIndustry,
        naicsCode: customer?.publicEnrichment?.naicsCode,
        sicCode: customer?.publicEnrichment?.sicCode,
        publicBusinessWebsite: customer?.publicEnrichment?.publicBusinessWebsite,
        websiteDomain: customer?.publicEnrichment?.websiteDomain,
        factiivMatchedBusinessName: customer?.factiivProfile?.matchedBusinessName,
      },
    };
    });
    const generated = await generateBusinessIndustryClassifications(inputs);
    for (const context of rowContexts) {
      const id = clean(context.row.customerId) || clean(context.row.email);
      const industry = generated[id] ?? context.storedIndustry;
      context.row.businessIndustry = industry.businessIndustry;
      context.row.industryCode = industry.industryCode;
      context.row.industryCodeType = industry.industryCodeType;
      context.row.industryDescription = industry.industryDescription;
      if (debug) context.row.industryResolvedFrom = industrySource(context.storedIndustry, industry);
    }
  }
  let rows = rowContexts.map((context) => context.row);
  if (paymentStatus) rows = rows.filter((row) => clean(row.dataConfidenceStatus).toLowerCase().includes(paymentStatus));
  return { rows, totalMatching };
}

export async function GET(request: Request) {
  const started = Date.now();
  const { origin, searchParams } = new URL(request.url);
  const format = searchParams.get("format") === "csv" ? "csv" : "json";
  const limit = parseLimit(searchParams.get("limit"));
  const page = parsePage(searchParams.get("page"));
  const filter = clean(searchParams.get("filter") || "all").toLowerCase();
  const state = normalizeStateCode(searchParams.get("state") || "");
  const factiiv = clean(searchParams.get("factiiv")).toLowerCase();
  const search = clean(searchParams.get("search"));
  const fundingCategory = clean(searchParams.get("fundingCategory"));
  const paymentStatus = clean(searchParams.get("paymentStatus")).toLowerCase();
  const sortBy = clean(searchParams.get("sortBy") || "totalAmountPaid");
  const sortDir = clean(searchParams.get("sortDir") || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const useAIIndustry = searchParams.get("useAIIndustry") === "true";
  const includeInsights = searchParams.get("includeInsights") === "true";
  const includeFullFields = searchParams.get("includeFullFields") !== "false";
  const debugFactiiv = searchParams.get("debugFactiiv") === "true";
  const debug = searchParams.get("debug") === "true";
  const sourceLimit = limit ? Math.min(10000, limit * page) : 10000;

  if (format === "json" && limit) {
    const fast = await paginatedJsonRows({ limit, page, filter, state, factiiv, search, fundingCategory, paymentStatus, sortBy, sortDir, useAIIndustry, debug });
    const columns = fast.rows[0] ? Object.keys(fast.rows[0]) : [];
    return NextResponse.json({
      success: true,
      total: fast.rows.length,
      totalMatching: fast.totalMatching,
      page,
      limit,
      hasMore: page * limit < fast.totalMatching,
      generatedAt: new Date().toISOString(),
      source: "/api/customers/export-center",
      filters: { limit, page, filter, state: state || "all", factiiv: factiiv || "all", search, fundingCategory, paymentStatus, sortBy, sortDir, useAIIndustry, includeFullFields, includeInsights },
      columns,
      columnCount: columns.length,
      industryMissingCount: missingIndustryCount(fast.rows),
      customers: fast.rows,
      totalMs: Date.now() - started,
    });
  }

  const richUrl = new URL("/api/customers/export-top-110", origin);
  richUrl.searchParams.set("format", "json");
  richUrl.searchParams.set("limit", String(sourceLimit));
  richUrl.searchParams.set("useAIIndustry", useAIIndustry ? "true" : "false");
  richUrl.searchParams.set("state", state || "all");
  if (search) richUrl.searchParams.set("search", search);
  if (debugFactiiv) richUrl.searchParams.set("debugFactiiv", "true");

  const richResponse = await fetch(richUrl, { cache: "no-store" });
  const richData = await richResponse.json().catch(() => ({})) as { customers?: RichExportRow[] };
  let rows = Array.isArray(richData.customers) ? richData.customers : [];
  const missingAfterSource = missingIndustryCount(rows);

  if (search) {
    const needle = search.toLowerCase();
    rows = rows.filter((row) => rowText(row, ["customerName", "email", "businessName", "phoneNumber", "businessAddress", "ein", "city", "state"]).includes(needle));
  }
  if (filter === "high_value") rows = rows.filter(isHighValue);
  if (filter === "funding_ready") rows = rows.filter(isFundingReady);
  if (factiiv === "with") rows = rows.filter(hasFactiiv);
  if (factiiv === "without") rows = rows.filter((row) => !hasFactiiv(row));
  if (fundingCategory) rows = rows.filter((row) => clean(row.fundingCategory).toLowerCase().includes(fundingCategory.toLowerCase()));
  if (paymentStatus) rows = rows.filter((row) => clean(row.dataConfidenceStatus).toLowerCase().includes(paymentStatus));
  rows = sortRows(rows, sortBy, sortDir);
  const totalMatching = rows.length;
  const offset = limit ? (page - 1) * limit : 0;
  rows = rows.slice(offset, limit ? offset + limit : rows.length);
  if (includeInsights) rows = rows.map(withInsightFields);

  const columns = rows[0]
    ? Object.keys(rows[0]).filter((column) => includeFullFields || !String(column).startsWith("factiiv"))
    : [];
  const finalColumns = includeInsights ? Array.from(new Set([...columns, ...insightColumns])) : columns;

  if (format === "csv") {
    return new NextResponse(toCsv(rows, finalColumns), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="red-spectrum-export-${limit || "all"}.csv"`,
      },
    });
  }

  return NextResponse.json({
    success: true,
    total: rows.length,
    totalMatching,
    page,
    limit: limit || "all",
    hasMore: limit ? offset + rows.length < totalMatching || rows.length === limit : false,
    generatedAt: new Date().toISOString(),
    source: "/api/customers/export-top-110",
    filters: { limit: limit || "all", page, filter, state: state || "all", factiiv: factiiv || "all", search, fundingCategory, paymentStatus, sortBy, sortDir, useAIIndustry, includeFullFields, includeInsights },
    columns: finalColumns,
    columnCount: finalColumns.length,
    industryMissingCount: missingAfterSource,
    customers: rows,
    totalMs: Date.now() - started,
  });
}
