import { NextResponse } from "next/server";
import { fetchWooCustomerMatches } from "@/lib/wooCustomerMatching";
import { isWooCommerceConfigured } from "@/lib/woocommerce";

export const dynamic = "force-dynamic";

const sourceAuditMaxPages = () => {
  const value = Number(process.env.WC_SOURCE_AUDIT_MAX_PAGES ?? process.env.WC_SYNC_ONE_MAX_PAGES ?? process.env.WC_MAX_PAGES ?? 25);
  return Number.isFinite(value) && value > 0 ? value : 25;
};

export async function GET(request: Request) {
  if (!isWooCommerceConfigured()) {
    return NextResponse.json({ error: "WooCommerce is not configured." }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const email = (searchParams.get("email") ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "email query parameter is required" }, { status: 400 });

  const result = await fetchWooCustomerMatches({
    email,
    phone: searchParams.get("phone") ?? undefined,
    firstName: searchParams.get("firstName") ?? undefined,
    lastName: searchParams.get("lastName") ?? undefined,
    company: searchParams.get("company") ?? undefined,
    customerName: searchParams.get("customerName") ?? undefined,
  }, { deepWooSearch: true, maxPages: sourceAuditMaxPages() });

  return NextResponse.json({
    input: result.audit.input,
    normalizedInput: result.audit.normalizedInput,
    matches: result.audit.matches,
    dedupedOrdersCount: result.audit.dedupedOrdersCount,
    dedupedOrderNumbers: result.audit.dedupedOrderNumbers,
    statusCounts: result.audit.statusCounts,
    paymentMethodCounts: result.audit.paymentMethodCounts,
    totalPaid: result.audit.totalPaid,
    totalAttempted: result.audit.totalAttempted,
    warnings: result.audit.warnings,
    fetchedBySource: result.audit.fetchedBySource,
    pagesFetched: result.pagesFetched,
    failedRequests: result.failedRequests,
  });
}
