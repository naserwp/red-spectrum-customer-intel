import { NextResponse } from "next/server";
import { fetchWordPressCreditRecords, ProfileTimeoutError, wordpressCreditHelperEndpointPath } from "@/lib/wordpressProfiles";
import { findCustomerForCreditRecord } from "@/lib/wordpressCreditSync";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = (searchParams.get("email") ?? "").trim().toLowerCase();
  try {
    const { posts, selectedRoute, routeProbes } = await fetchWordPressCreditRecords({ limit: 25, offset: 0 });
    const filtered = posts.filter((post) => !email || post.normalizedEmail === email);
    const rows = await Promise.all(filtered.map(async (post) => {
      const match = await findCustomerForCreditRecord(post);
      return {
        postId: post.postId,
        title: post.title,
        verified: post.verified,
        source: post.source,
        linkedUserId: post.linkedUserId,
        linkedCustomerId: post.linkedCustomerId,
        linkedOrderId: post.linkedOrderId,
        linkedSubscriptionId: post.linkedSubscriptionId,
        email: post.email,
        phone: post.phone,
        company: post.company,
        parsedApprovedCredits: post.approvedCredits,
        parsedAvailableCredits: post.availableCredit,
        parsedOutstanding: post.outstandingBalance,
        selectedSource: "wc_cs_credits",
        selectedMetaKeys: post.detectedKeys,
        rawMetaKeys: Object.keys(post.rawMeta),
        rawMeta: post.rawMeta,
        detectedKeys: post.detectedKeys,
        matchedCustomerId: match.customer ? String(match.customer._id) : "",
        matchConfidence: match.confidence,
        matchReasons: match.reasons,
      };
    }));
    return NextResponse.json({
      email,
      matchedCreditPosts: rows.length,
      posts: rows,
      selectedRoute,
      routeProbes,
    });
  } catch (error) {
    const message = error instanceof ProfileTimeoutError
      ? "WordPress credit debug request timed out."
      : error instanceof Error
        ? error.message
        : "WordPress credit debug failed.";
    return NextResponse.json({
      email,
      matchedCreditPosts: 0,
      posts: [],
      warnings: [message],
      requiredEndpoint: wordpressCreditHelperEndpointPath,
      helperFile: "/docs/wp-wc-cs-credits-helper-endpoint.php",
    }, { status: 500 });
  }
}
