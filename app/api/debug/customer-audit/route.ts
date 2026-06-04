import { NextResponse } from "next/server";
import { GET as getTop110Export } from "@/app/api/customers/export-top-110/route";
import { GET as getRevenueAudit } from "@/app/api/customers/revenue-audit/route";
import { enrichCustomerProfile } from "@/lib/customerEnrichment";
import { connectToDatabase } from "@/lib/mongodb";
import { fetchWooCustomerMatches } from "@/lib/wooCustomerMatching";
import { isWooCommerceConfigured } from "@/lib/woocommerce";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

type LeanCustomer = CustomerDocument & { _id: unknown; createdAt?: Date | string; updatedAt?: Date | string };

type ExportTop110Response = {
  customers?: Array<Record<string, unknown>>;
};

type RevenueAuditResponse = {
  rows?: Array<Record<string, unknown>>;
};

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/^mailto:/i, "");
}

function text(value: unknown) {
  const raw = String(value ?? "").trim();
  return raw === "Missing" ? "" : raw;
}

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
}

function sourceValue(value: unknown, source: string) {
  const clean = text(value);
  return clean ? { value: clean, source } : null;
}

function firstSource(candidates: Array<{ value: string; source: string } | null>) {
  return candidates.find(Boolean) ?? { value: "", source: "missing" };
}

function latestOrder(orders: WooCommerceOrderDocument[]) {
  return [...orders].sort((a, b) => new Date(b.dateCreated || 0).getTime() - new Date(a.dateCreated || 0).getTime())[0] ?? null;
}

function paidWooRevenue(orders: WooCommerceOrderDocument[]) {
  return money(orders.filter((order) => order.isPaid).reduce((sum, order) => sum + Number(order.paidAmount ?? order.total ?? 0), 0));
}

function addressFromOrder(order: WooCommerceOrderDocument | null) {
  if (!order?.billingAddress) return "";
  return [
    order.billingAddress.address1,
    order.billingAddress.address2,
    order.billingAddress.city,
    order.billingAddress.state,
    order.billingAddress.postcode,
  ].map(text).filter(Boolean).join(", ");
}

function addressFromCustomer(customer: LeanCustomer | null) {
  const profile = customer?.businessProfile;
  if (!profile) return "";
  return [profile.address1, profile.address2, profile.city, profile.stateCode || profile.state, profile.zip].map(text).filter(Boolean).join(", ");
}

function missingFields(sourceFields: Record<string, { value: string; source: string }>) {
  return Object.entries(sourceFields)
    .filter(([, field]) => !field.value)
    .map(([field]) => field);
}

async function exportRow(email: string) {
  const response = await getTop110Export(new Request("http://localhost/api/customers/export-top-110?format=json&limit=110&useAIIndustry=false&debugFactiiv=true"));
  const data = await response.json() as ExportTop110Response;
  return (data.customers ?? []).find((row) => normalizeEmail(row.email) === email) ?? null;
}

async function revenueAuditRow(email: string) {
  const response = await getRevenueAudit(new Request(`http://localhost/api/customers/revenue-audit?email=${encodeURIComponent(email)}&limit=25`));
  const data = await response.json() as RevenueAuditResponse;
  return (data.rows ?? []).find((row) => normalizeEmail(row.email) === email) ?? data.rows?.[0] ?? null;
}

export async function GET(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const email = normalizeEmail(searchParams.get("email"));
  if (!email) return NextResponse.json({ error: "email query parameter is required." }, { status: 400 });
  const liveWooEnabled = searchParams.get("liveWoo") === "true";

  const [customers, ranking, wooOrders] = await Promise.all([
    Customer.find({ $or: [{ normalizedEmail: email }, { emailNormalized: email }, { email }] }).sort({ updatedAt: -1 }).lean<LeanCustomer[]>(),
    CustomerRanking.findOne({ email }).lean<CustomerRankingDocument | null>(),
    WooCommerceOrderRecord.find({ $or: [{ normalizedEmail: email }, { billingEmail: { $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } }] }).sort({ dateCreated: -1 }).lean<WooCommerceOrderDocument[]>(),
  ]);

  const customer = customers.sort((a, b) => {
    const orderDiff = Number((b.orders ?? []).length > 0) - Number((a.orders ?? []).length > 0);
    if (orderDiff !== 0) return orderDiff;
    return new Date(b.updatedAt || b.lastSyncedAt || 0).getTime() - new Date(a.updatedAt || a.lastSyncedAt || 0).getTime();
  })[0] ?? null;
  const customerId = customer?._id ? String(customer._id) : "";
  const latestWoo = latestOrder(wooOrders);
  const [exportCustomer, revenueRow] = await Promise.all([
    exportRow(email),
    revenueAuditRow(email),
  ]);

  const enrichment = customer ? enrichCustomerProfile(customer) : null;
  const wooRevenue = paidWooRevenue(wooOrders);
  const customerRevenue = money(customer?.lifetimeValue ?? customer?.rankingPaidTotal ?? customer?.paidTotal ?? customer?.totalPaid);
  const rankingRevenue = money(ranking?.lifetimeSpent);
  const exportRevenue = money(exportCustomer?.lifetimeValue ?? exportCustomer?.totalAmountPaid);
  const revenueAuditValue = money(revenueRow?.finalLifetimeValue);

  const sourceFields = {
    businessName: firstSource([
      sourceValue(exportCustomer?.businessName, "export"),
      sourceValue(enrichment?.businessName, `enrichment:${enrichment?.businessNameSource || ""}`),
      sourceValue(ranking?.businessName, "CustomerRanking.businessName"),
      sourceValue(customer?.businessProfile?.businessName, "Customer.businessProfile.businessName"),
      sourceValue(customer?.businessProfile?.company, "Customer.businessProfile.company"),
      sourceValue(latestWoo?.billingCompany, "latest WooCommerce order billingCompany"),
    ]),
    city: firstSource([
      sourceValue(exportCustomer?.city, "export"),
      sourceValue(customer?.businessProfile?.city, "Customer.businessProfile.city"),
      sourceValue(latestWoo?.billingAddress?.city, "latest WooCommerce order billingAddress.city"),
    ]),
    state: firstSource([
      sourceValue(exportCustomer?.state, "export"),
      sourceValue(enrichment?.stateCode, `enrichment:${enrichment?.stateSource || ""}`),
      sourceValue(ranking?.stateCode, "CustomerRanking.stateCode"),
      sourceValue(customer?.businessProfile?.stateCode || customer?.businessProfile?.state, "Customer.businessProfile state"),
      sourceValue(latestWoo?.billingAddress?.state, "latest WooCommerce order billingAddress.state"),
    ]),
    address: firstSource([
      sourceValue(exportCustomer?.businessAddress, "export"),
      sourceValue(addressFromCustomer(customer), "Customer.businessProfile address"),
      sourceValue(addressFromOrder(latestWoo), "latest WooCommerce order billingAddress"),
    ]),
    phone: firstSource([
      sourceValue(exportCustomer?.phoneNumber, "export"),
      sourceValue(customer?.phone, "Customer.phone"),
      sourceValue(customer?.businessProfile?.phone, "Customer.businessProfile.phone"),
      sourceValue(customer?.creditProfile?.phone, "Customer.creditProfile.phone"),
      sourceValue(latestWoo?.billingPhone, "latest WooCommerce order billingPhone"),
    ]),
    ein: firstSource([
      sourceValue(exportCustomer?.ein, "export"),
      sourceValue(customer?.businessProfile?.ein, "Customer.businessProfile.ein"),
      sourceValue(customer?.creditProfile?.ein, "Customer.creditProfile.ein"),
    ]),
    lifetimeValue: firstSource([
      sourceValue(exportCustomer?.lifetimeValue, "export.lifetimeValue"),
      sourceValue(ranking?.lifetimeSpent, "CustomerRanking.lifetimeSpent"),
      sourceValue(customer?.lifetimeValue, "Customer.lifetimeValue"),
      sourceValue(wooRevenue, "stored WooCommerce paid orders"),
    ]),
  };

  const missing = missingFields(sourceFields);
  const rootCauses: string[] = [];
  if (!customer) rootCauses.push("No Customer document exists for email.");
  if (!ranking) rootCauses.push("No CustomerRanking document exists for email.");
  if (customers.length > 1) rootCauses.push(`Duplicate Customer documents found for email (${customers.length}).`);
  if (wooRevenue > customerRevenue) rootCauses.push("Customer revenue is lower than stored WooCommerce paid order revenue; customer rebuild is stale or incomplete.");
  if (wooRevenue > rankingRevenue) rootCauses.push("CustomerRanking revenue is lower than stored WooCommerce paid order revenue; ranking cache is stale.");
  if (exportCustomer && wooRevenue > exportRevenue) rootCauses.push("Export revenue is lower than stored WooCommerce paid order revenue; export is using stale ranking/customer cache.");
  if (missing.includes("businessName") || missing.includes("city") || missing.includes("state") || missing.includes("address") || missing.includes("phone")) {
    rootCauses.push("Profile fields are missing from Customer/Ranking/export despite stored WooCommerce billing data.");
  }
  if (!rootCauses.length) rootCauses.push("No stored-data mismatch detected.");

  let wooCustomer = null;
  if (liveWooEnabled && isWooCommerceConfigured()) {
    try {
      const live = await fetchWooCustomerMatches({
        email,
        phone: sourceFields.phone.value,
        company: sourceFields.businessName.value,
        customerName: customer?.name,
      }, { deepWooSearch: true, maxPages: 10 });
      wooCustomer = {
        orderCount: live.audit.dedupedOrdersCount,
        revenueTotal: money(live.audit.totalPaid),
        statusCounts: live.audit.statusCounts,
        matchReasonCounts: live.audit.matchReasonCounts,
        fetchedBySource: live.audit.fetchedBySource,
        warnings: live.audit.warnings,
      };
      if (live.audit.totalPaid > wooRevenue) rootCauses.push("Live WooCommerce search found more paid revenue than stored WooCommerceOrder records; order sync/backfill is stale.");
    } catch (error) {
      wooCustomer = { error: error instanceof Error ? error.message : "WooCommerce live customer audit failed." };
    }
  } else {
    wooCustomer = {
      skipped: true,
      reason: liveWooEnabled ? "WooCommerce is not configured." : "Set liveWoo=true to run the slower live WooCommerce customer/profile search.",
    };
  }

  return NextResponse.json({
    customerFound: Boolean(customer),
    rankingFound: Boolean(ranking),
    duplicateCustomerCount: customers.length,
    customerId,
    email,
    customerName: customer?.name ?? "",
    wooOrders: wooOrders.length,
    wooPaidOrderCount: wooOrders.filter((order) => order.isPaid).length,
    wooRevenue,
    customerRevenue,
    rankingRevenue,
    exportRevenue,
    revenueAuditRevenue: revenueAuditValue,
    customerCollection: {
      orderCount: customer?.orderCount ?? 0,
      paidOrderCount: customer?.paidOrderCount ?? 0,
      lifetimeValue: money(customer?.lifetimeValue),
      rankingPaidTotal: money(customer?.rankingPaidTotal),
      paidTotal: money(customer?.paidTotal),
      totalPaid: money(customer?.totalPaid),
      lastSyncedAt: customer?.lastSyncedAt ?? "",
      updatedAt: customer?.updatedAt ?? "",
    },
    customerRanking: ranking ? {
      customerId: ranking.customerId,
      lifetimeSpent: money(ranking.lifetimeSpent),
      businessName: ranking.businessName,
      stateCode: ranking.stateCode,
      generatedAt: ranking.generatedAt,
      updatedAt: ranking.updatedAt,
    } : null,
    revenueAudit: revenueRow,
    exportTop110: exportCustomer,
    wooCommerceCustomer: wooCustomer,
    wooOrderSamples: wooOrders.slice(0, 5).map((order) => ({
      orderNumber: order.orderNumber,
      status: order.status,
      isPaid: order.isPaid,
      paidAmount: money(order.paidAmount ?? order.total),
      dateCreated: order.dateCreated,
      billingName: order.billingName,
      billingEmail: order.billingEmail || order.normalizedEmail,
      billingCompany: order.billingCompany,
      billingPhone: order.billingPhone,
      billingAddress: order.billingAddress,
    })),
    missingFields: missing,
    sourceFields,
    rebuildRecommended: rootCauses.some((cause) => /stale|missing from Customer|No Customer|No CustomerRanking|Duplicate/.test(cause)),
    rootCause: Array.from(new Set(rootCauses)).join(" "),
    totalMs: Date.now() - started,
  });
}
