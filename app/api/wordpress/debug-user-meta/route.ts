import { NextResponse } from "next/server";
import { fetchCustomerCreditMetaDebug, ProfileTimeoutError } from "@/lib/wordpressProfiles";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email")?.trim() || "elite1transport316@gmail.com";
  const userId = searchParams.get("userId")?.trim() || "4902";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const result = await fetchCustomerCreditMetaDebug({ email, userId, signal: controller.signal });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof ProfileTimeoutError
      ? "WordPress credit meta debug request timed out."
      : error instanceof Error
        ? error.message
        : "WordPress credit meta debug failed.";
    return NextResponse.json({
      email,
      requestedUserId: userId,
      error: message,
      detectedCreditMetaKeys: [],
      selectedApprovedCreditKey: "",
      selectedAvailableCreditKey: "",
      selectedOutstandingKey: "",
      selectedEinKey: "",
      warnings: [message],
    }, { status: 500 });
  } finally {
    clearTimeout(timeout);
  }
}
