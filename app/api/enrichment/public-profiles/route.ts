import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { buildPublicEnrichment } from "@/lib/publicEnrichment";
import { Customer, type CustomerDocument } from "@/models/Customer";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { limit?: number; offset?: number; dryRun?: boolean };
  const limit = Math.min(50, Math.max(1, Number(body.limit ?? 25)));
  const offset = Math.max(0, Number(body.offset ?? 0));
  const dryRun = Boolean(body.dryRun);

  const customers = await Customer.find({}, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    businessProfile: 1,
    publicEnrichment: 1,
    sourceCoverage: 1,
  }).sort({ "publicEnrichment.lastEnrichmentRun": 1, updatedAt: -1 }).skip(offset).limit(limit).lean<LeanCustomer[]>();

  let updated = 0;
  for (const customer of customers) {
    const enrichment = buildPublicEnrichment(customer);
    if (dryRun) continue;
    await Customer.updateOne(
      { _id: customer._id },
      {
        $set: {
          publicEnrichment: enrichment,
          "businessProfile.website": customer.businessProfile?.website || enrichment.publicBusinessWebsite || "",
          "businessProfile.naicsCode": customer.businessProfile?.naicsCode || enrichment.naicsCode || "",
          "businessProfile.sicCode": customer.businessProfile?.sicCode || enrichment.sicCode || "",
          "businessProfile.industry": customer.businessProfile?.industry || enrichment.inferredIndustry || "",
          "sourceCoverage.enrichmentSources": enrichment.enrichmentSources,
          "sourceCoverage.socialProfilesFound": enrichment.socialProfilesFound,
          "sourceCoverage.publicBusinessDataFound": enrichment.publicBusinessDataFound,
          "sourceCoverage.lastEnrichmentRun": enrichment.lastEnrichmentRun,
        },
      }
    ).exec();
    updated += 1;
  }

  return NextResponse.json({
    processed: customers.length,
    updated,
    hasMore: customers.length === limit,
    nextOffset: offset + customers.length,
    warnings: [],
    message: dryRun
      ? `Public enrichment preview complete for ${customers.length} customers.`
      : `Public enrichment updated ${updated} customers.`,
  });
}
