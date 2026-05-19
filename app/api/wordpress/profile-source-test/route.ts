import { NextResponse } from "next/server";
import { testProfileSources } from "@/lib/wordpressProfiles";

export const dynamic = "force-dynamic";

export async function GET() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const results = await testProfileSources(controller.signal);
    return NextResponse.json({ results });
  } finally {
    clearTimeout(timeout);
  }
}
