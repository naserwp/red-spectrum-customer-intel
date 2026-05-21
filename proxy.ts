import { NextRequest, NextResponse } from "next/server";
import { adminSessionCookieName, verifyAdminSession } from "@/lib/adminAuth";

const protectedApiPaths = [
  "/api/woocommerce/backfill-orders",
  "/api/woocommerce/backfill-subscriptions",
  "/api/authorize-net/backfill-transactions",
  "/api/authorize-net/reconcile-customers",
  "/api/nmi/backfill-transactions",
  "/api/nmi/reconcile-customers",
  "/api/nmi/repair-customer",
  "/api/sync/run-step",
  "/api/customers/rebuild-from-orders",
  "/api/customers/sync-one",
  "/api/customers/compare-source",
];

function isProtectedPath(pathname: string) {
  return pathname === "/admin" || pathname.startsWith("/admin/") || protectedApiPaths.some((path) => pathname === path);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!isProtectedPath(pathname)) return NextResponse.next();

  const authenticated = await verifyAdminSession(request.cookies.get(adminSessionCookieName)?.value);
  if (authenticated) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Admin login required." }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/admin/:path*", "/api/woocommerce/backfill-orders", "/api/woocommerce/backfill-subscriptions", "/api/authorize-net/backfill-transactions", "/api/authorize-net/reconcile-customers", "/api/nmi/backfill-transactions", "/api/nmi/reconcile-customers", "/api/nmi/repair-customer", "/api/sync/run-step", "/api/customers/rebuild-from-orders", "/api/customers/sync-one", "/api/customers/compare-source"],
};
