import { NextResponse } from "next/server";
import { ProfileTimeoutError, wordpressCreditHelperEndpointPath } from "@/lib/wordpressProfiles";
import { connectToDatabase } from "@/lib/mongodb";
import { importWordPressCreditBatch } from "@/lib/wordpressCreditSync";

export const dynamic = "force-dynamic";

function safeNumber(value: unknown, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; dryRun?: boolean };
  const limit = safeNumber(body.limit, 25, 25);
  const offset = safeNumber(body.offset, 0, 1000000);
  const dryRun = body.dryRun === true;
  await connectToDatabase();
  try {
    const result = await importWordPressCreditBatch({ limit, offset, dryRun, maxRuntimeMs: 8000 });
    return NextResponse.json({
      processed: result.processed,
      matchedCustomers: result.matchedCustomers,
      updatedProfiles: dryRun ? 0 : result.updatedProfiles,
      hasMore: result.hasMore,
      nextOffset: result.nextOffset,
      warnings: result.warnings,
      routeProbes: result.routeProbes ?? [],
      selectedRoute: result.selectedRoute ?? "",
    });
  } catch (error) {
    const message = error instanceof ProfileTimeoutError
      ? "Request timed out during batch fetch"
      : error instanceof Error
        ? error.message
        : "WordPress credit import failed.";
    return NextResponse.json({
      processed: 0,
      matchedCustomers: 0,
      updatedProfiles: 0,
      hasMore: false,
      nextOffset: offset,
      warnings: [message],
      requiredEndpoint: wordpressCreditHelperEndpointPath,
      helperFile: "/docs/wp-wc-cs-credits-helper-endpoint.php",
    }, { status: 500 });
  }
}
