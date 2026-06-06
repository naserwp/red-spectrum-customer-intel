import { NextResponse } from "next/server";
import { buildFactiivCoverageCandidates } from "@/lib/factivCoverageAudit";

export const dynamic = "force-dynamic";

function safeLimit(value: string | null) {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed < 1) return 100;
  return Math.min(500, Math.floor(parsed));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = safeLimit(searchParams.get("limit"));
  const audit = await buildFactiivCoverageCandidates(limit);
  return NextResponse.json({
    totalReturned: audit.candidates.length,
    estimatedRecoverableProfiles: audit.estimatedRecoverableProfiles,
    highConfidenceCandidates: audit.highConfidenceCandidates,
    mediumConfidenceCandidates: audit.mediumConfidenceCandidates,
    lowConfidenceCandidates: audit.lowConfidenceCandidates,
    candidates: audit.candidates.map((candidate) => ({
      customer: candidate.customer,
      candidateBusiness: candidate.candidate.businessName,
      candidate: candidate.candidate,
      confidence: candidate.confidence,
      confidenceBand: candidate.confidenceBand,
      matchReasons: candidate.matchReasons,
    })),
  });
}
