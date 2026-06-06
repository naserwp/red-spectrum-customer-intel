import { NextResponse } from "next/server";
import { buildFactiivCoverageCandidates } from "@/lib/factivCoverageAudit";

export const dynamic = "force-dynamic";

export async function GET() {
  const audit = await buildFactiivCoverageCandidates(25);
  return NextResponse.json({
    totalCustomers: audit.totalCustomers,
    customersWithFactiiv: audit.customersWithFactiiv,
    customersWithoutFactiiv: audit.customersWithoutFactiiv,
    highConfidenceCandidates: audit.highConfidenceCandidates,
    mediumConfidenceCandidates: audit.mediumConfidenceCandidates,
    lowConfidenceCandidates: audit.lowConfidenceCandidates,
    estimatedRecoverableProfiles: audit.estimatedRecoverableProfiles,
    storedFactiivProfileCorpus: audit.storedFactiivProfileCorpus,
    sampleCandidates: audit.candidates.slice(0, 10),
  });
}
