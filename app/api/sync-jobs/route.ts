import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    jobs: [
      { id: "sync-woocommerce", source: "woocommerce", mode: "read-only", status: "available" },
      { id: "sync-authorize-net", source: "authorize_net", mode: "read-only", status: "planned" },
      { id: "sync-nmi", source: "nmi", mode: "read-only", status: "planned" },
      { id: "sync-stripe", source: "stripe", mode: "read-only", status: "planned" },
      { id: "sync-manual", source: "manual", mode: "read-only", status: "planned" },
    ],
  });
}
