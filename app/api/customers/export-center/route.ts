import { NextResponse } from "next/server";
import { normalizeStateCode } from "@/lib/customerBusinessResolver";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

export const dynamic = "force-dynamic";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

type ExportCenterRow = {
  name: string;
  email: string;
  phone: string;
  businessName: string;
  ein: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  industry: string;
  naics: string;
  lifetimeValue: number;
  fundingScore: number | string;
  creditLimit: number | string;
  lastPaidDate: string;
};

const columns: Array<keyof ExportCenterRow> = [
  "name",
  "email",
  "phone",
  "businessName",
  "ein",
  "address",
  "city",
  "state",
  "zip",
  "industry",
  "naics",
  "lifetimeValue",
  "fundingScore",
  "creditLimit",
  "lastPaidDate",
];

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text && text !== "-" && text.toLowerCase() !== "missing" ? text : "";
}

function missing(value: unknown) {
  return clean(value) || "Missing";
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function dateOnly(value: unknown) {
  const raw = clean(value);
  if (!raw) return "Missing";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

function csvEscape(value: unknown) {
  const raw = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replaceAll("\"", "\"\"")}"` : raw;
}

function toCsv(rows: ExportCenterRow[]) {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")).join("\r\n");
  return `\uFEFF${header}\r\n${body}\r\n`;
}

function normalizedEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function recordValue(source: unknown, key: string) {
  return source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;
}

function nestedRecordValue(source: unknown, parent: string, key: string) {
  const parentValue = recordValue(source, parent);
  return parentValue && typeof parentValue === "object" ? (parentValue as Record<string, unknown>)[key] : undefined;
}

function hasFactiiv(customer?: LeanCustomer, ranking?: CustomerRankingDocument) {
  return Boolean(
    clean(ranking?.factiivProfileId) ||
    Number(ranking?.factiivScore ?? 0) > 0 ||
    clean(customer?.factiivProfile?.factiivProfileId) ||
    Number(customer?.factiivProfile?.factiivScore ?? 0) > 0 ||
    customer?.factiivProfile?.factiivMatched
  );
}

function addressFrom(customer?: LeanCustomer, ranking?: CustomerRankingDocument) {
  const businessProfile = customer?.businessProfile;
  return clean(ranking?.businessAddress) ||
    clean(recordValue(businessProfile, "billingAddress")) ||
    clean(nestedRecordValue(businessProfile, "address", "street")) ||
    clean(businessProfile?.address1) ||
    clean(recordValue(businessProfile, "street"));
}

function rowFrom(ranking: CustomerRankingDocument | undefined, customer: LeanCustomer | undefined): ExportCenterRow {
  const businessProfile = customer?.businessProfile;
  const creditProfile = customer?.creditProfile;
  const publicEnrichment = customer?.publicEnrichment;
  const state = normalizeStateCode(ranking?.stateCode || businessProfile?.stateCode || businessProfile?.state || recordValue(customer, "stateCode") || recordValue(customer, "state")) ||
    clean(ranking?.stateCode || businessProfile?.stateCode || businessProfile?.state);
  const fundingScore = Number(ranking?.fundingScore ?? businessProfile?.fundingScore ?? 0);
  const creditLimit = money(ranking?.factiivVerifiedCreditLimit || recordValue(businessProfile, "verifiedCreditLimit") || businessProfile?.creditLimit || recordValue(creditProfile, "creditLimit") || customer?.estimatedCreditLimit);

  return {
    name: missing(ranking?.name || customer?.name),
    email: missing(ranking?.email || customer?.email),
    phone: missing(ranking?.phone || customer?.phone || businessProfile?.phone),
    businessName: missing(ranking?.businessName || businessProfile?.businessName || businessProfile?.company),
    ein: missing(ranking?.ein || businessProfile?.ein || creditProfile?.ein),
    address: missing(addressFrom(customer, ranking)),
    city: missing(ranking?.city || businessProfile?.city || nestedRecordValue(businessProfile, "address", "city")),
    state: missing(state),
    zip: missing(ranking?.zip || businessProfile?.zip || recordValue(businessProfile, "postalCode") || nestedRecordValue(businessProfile, "address", "zip")),
    industry: missing(businessProfile?.industry || recordValue(publicEnrichment, "inferredIndustry")),
    naics: missing(businessProfile?.naicsCode || recordValue(publicEnrichment, "naicsCode")),
    lifetimeValue: money(ranking?.lifetimeSpent || customer?.lifetimeValue || customer?.paidTotal || customer?.totalPaid),
    fundingScore: fundingScore > 0 ? fundingScore : "Missing",
    creditLimit: creditLimit > 0 ? creditLimit : "Missing",
    lastPaidDate: dateOnly(ranking?.latestPaidDate || customer?.lastPaidDate),
  };
}

function parseLimit(value: string | null) {
  if (value === "all") return 0;
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed < 1) return 100;
  return Math.min(10000, Math.floor(parsed));
}

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") === "csv" ? "csv" : "json";
  const limit = parseLimit(searchParams.get("limit"));
  const filter = clean(searchParams.get("filter") || "all").toLowerCase();
  const state = normalizeStateCode(searchParams.get("state") || "");
  const factiiv = clean(searchParams.get("factiiv")).toLowerCase();

  const rankingQuery: Record<string, unknown> = {};
  if (state) rankingQuery.stateCode = state;
  if (filter === "high_value") rankingQuery.category = /high/i;
  if (filter === "funding_ready") rankingQuery.fundingScore = { $gt: 0 };
  if (factiiv === "with") rankingQuery.$or = [{ factiivProfileId: { $ne: "" } }, { factiivScore: { $gt: 0 } }];
  if (factiiv === "without") rankingQuery.$and = [{ $or: [{ factiivProfileId: "" }, { factiivProfileId: { $exists: false } }] }, { $or: [{ factiivScore: 0 }, { factiivScore: { $exists: false } }] }];

  const rankings = await CustomerRanking.find(rankingQuery)
    .sort({ lifetimeSpent: -1, latestPaidDate: -1 })
    .limit(limit || 10000)
    .lean<CustomerRankingDocument[]>();
  const customerIds = rankings.map((ranking) => ranking.customerId).filter(Boolean);
  const emails = Array.from(new Set(rankings.map((ranking) => normalizedEmail(ranking.email)).filter(Boolean)));
  const customers = await Customer.find({
    $or: [
      { _id: { $in: customerIds } },
      { normalizedEmail: { $in: emails } },
      { email: { $in: emails } },
    ],
  }, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    phone: 1,
    businessProfile: 1,
    creditProfile: 1,
    publicEnrichment: 1,
    factiivProfile: 1,
    lifetimeValue: 1,
    paidTotal: 1,
    totalPaid: 1,
    estimatedCreditLimit: 1,
    lastPaidDate: 1,
  }).lean<LeanCustomer[]>();

  const customerById = new Map(customers.map((customer) => [String(customer._id), customer]));
  const customerByEmail = new Map(customers.map((customer) => [normalizedEmail(customer.normalizedEmail || customer.email), customer]));
  let rows = rankings.map((ranking) => {
    const customer = customerById.get(ranking.customerId) || customerByEmail.get(normalizedEmail(ranking.email));
    return { ranking, customer, row: rowFrom(ranking, customer) };
  });

  if (factiiv === "with") rows = rows.filter(({ customer, ranking }) => hasFactiiv(customer, ranking));
  if (factiiv === "without") rows = rows.filter(({ customer, ranking }) => !hasFactiiv(customer, ranking));
  const exportRows = rows.map(({ row }) => row).slice(0, limit || rows.length);

  if (format === "csv") {
    return new NextResponse(toCsv(exportRows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="red-spectrum-export-${limit || "all"}.csv"`,
      },
    });
  }

  return NextResponse.json({
    success: true,
    total: exportRows.length,
    generatedAt: new Date().toISOString(),
    filters: { limit: limit || "all", filter, state: state || "all", factiiv: factiiv || "all" },
    columns,
    customers: exportRows,
  });
}
