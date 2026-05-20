import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerBusinessProfile, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";

type LeanCustomer = CustomerDocument & { _id: unknown };

type IndustryMatch = {
  industry: string;
  classification: string;
  naicsCode: string;
  sicCode: string;
};

const industryRules: Array<{ pattern: RegExp; match: IndustryMatch }> = [
  { pattern: /truck|freight|transport|logistics|carrier|dispatch/i, match: { industry: "Transportation", classification: "General Freight Trucking", naicsCode: "484121", sicCode: "4213" } },
  { pattern: /landscap|lawn|tree|garden|hardscape/i, match: { industry: "Property Services", classification: "Landscaping Services", naicsCode: "561730", sicCode: "0782" } },
  { pattern: /construction|contractor|roof|plumb|electric|hvac/i, match: { industry: "Construction", classification: "Specialty Trade Contractors", naicsCode: "238990", sicCode: "1799" } },
  { pattern: /real estate|property|rental|broker/i, match: { industry: "Real Estate", classification: "Real Estate Services", naicsCode: "531210", sicCode: "6531" } },
  { pattern: /consult|marketing|agency|service|business/i, match: { industry: "Professional Services", classification: "Other Professional Services", naicsCode: "541990", sicCode: "7389" } },
  { pattern: /retail|store|shop|commerce|ecommerce/i, match: { industry: "Retail", classification: "Electronic Shopping and Mail-Order Houses", naicsCode: "454110", sicCode: "5961" } },
];

function moneyNumber(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function classifyIndustry(customer: LeanCustomer): IndustryMatch {
  const profile = customer.businessProfile ?? {} as CustomerBusinessProfile;
  const text = [
    profile.industry,
    profile.industryClassification,
    profile.businessType,
    profile.company,
    customer.name,
    customer.email,
    ...(customer.paidProducts ?? []),
    ...(customer.baseProductsPurchased ?? []),
  ].join(" ");
  const explicit = {
    industry: profile.industry || profile.businessType || "",
    classification: profile.industryClassification || profile.businessType || "",
    naicsCode: profile.naicsCode || "",
    sicCode: profile.sicCode || "",
  };
  if (explicit.naicsCode || explicit.sicCode) {
    return {
      industry: explicit.industry || "Business",
      classification: explicit.classification || "Customer supplied profile",
      naicsCode: explicit.naicsCode,
      sicCode: explicit.sicCode,
    };
  }
  return industryRules.find((rule) => rule.pattern.test(text))?.match ?? {
    industry: explicit.industry || "Business Services",
    classification: explicit.classification || "General Business Services",
    naicsCode: "541990",
    sicCode: "7389",
  };
}

function profileCompleteness(profile: Partial<CustomerBusinessProfile>) {
  const fields = [profile.company, profile.phone, profile.address1, profile.city, profile.state, profile.zip, profile.ein, profile.creditLimit || profile.potentialCreditLimit, profile.net30Status || profile.accountStatus, profile.businessType];
  return Math.round((fields.filter(Boolean).length / fields.length) * 100);
}

function fundingScore(customer: LeanCustomer, ranking?: CustomerRankingDocument) {
  const lifetime = moneyNumber(ranking?.lifetimeSpent ?? customer.lifetimeValue ?? customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid);
  const paidMonths = moneyNumber(ranking?.paidMonths ?? customer.paidMonths ?? customer.paidOrderCount);
  const mrr = moneyNumber(ranking?.estimatedMRR ?? customer.recurringAmount);
  const profileScore = profileCompleteness(customer.businessProfile ?? {});
  let score = 0;
  score += Math.min(30, lifetime / 250);
  score += Math.min(18, paidMonths * 2);
  score += customer.activeSubscriptions > 0 || customer.isGatewayRecurring ? 12 : 0;
  score += Math.min(12, mrr / 100);
  score += Math.min(18, profileScore * 0.18);
  score += customer.riskLevel === "low" ? 10 : customer.riskLevel === "medium" ? 5 : 0;
  score -= moneyNumber(customer.failedPayments) > 2 ? 8 : 0;
  score -= moneyNumber(customer.chargebacks) > 0 ? 15 : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function fundingTier(score: number, lifetime: number) {
  if (score >= 85 && lifetime >= 10000) return "Funding VIP Elite";
  if (score >= 75 && lifetime >= 5000) return "Funding VIP";
  if (score >= 65) return "Funding Ready";
  if (score >= 50) return "Needs Enrichment";
  return "Not Ready";
}

function insights(customer: LeanCustomer, score: number, lifetime: number, profileScore: number, industry: IndustryMatch) {
  const strengths = [
    lifetime >= 5000 ? "Strong verified customer spend" : "",
    customer.activeSubscriptions > 0 || customer.isGatewayRecurring ? "Recurring revenue signal detected" : "",
    profileScore >= 70 ? "Business profile is substantially complete" : "",
  ].filter(Boolean);
  const risks = [
    customer.riskLevel === "high" ? "Payment risk is elevated" : "",
    profileScore < 60 ? "Business profile is missing key underwriting fields" : "",
    !customer.businessProfile?.ein ? "EIN is missing" : "",
    moneyNumber(customer.failedPayments) > 0 ? "Failed payment history should be reviewed" : "",
  ].filter(Boolean);
  return {
    fundingInsight: score >= 75
      ? `${customer.name} is a strong funding-readiness candidate in ${industry.classification}. Prioritize outreach for Net 30, credit line review, or financing prequalification.`
      : score >= 55
        ? `${customer.name} has useful revenue signals but needs profile cleanup before funding outreach.`
        : `${customer.name} is not funding-ready yet; complete business enrichment and monitor paid revenue history.`,
    riskInsight: risks.length ? risks.join(". ") : "No major payment or profile risk blockers detected from stored data.",
    strengths,
    risks,
    recommendedAction: score >= 75 ? "Contact for funding readiness review" : score >= 55 ? "Complete business profile and verify revenue history" : "Continue customer nurturing before funding outreach",
  };
}

export async function GET(request: Request) {
  const started = Date.now();
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const minSpent = Math.max(0, Number(searchParams.get("minSpent") ?? 0));
  const tier = searchParams.get("tier") ?? "";
  const readiness = searchParams.get("readiness") ?? "";
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 50)));
  const q = (searchParams.get("q") ?? "").trim().toLowerCase();

  const [customers, rankings] = await Promise.all([
    Customer.find(q ? { $or: [{ normalizedEmail: q }, { emailNormalized: q }, { name: { $regex: q, $options: "i" } }, { "businessProfile.company": { $regex: q, $options: "i" } }] } : {}, {
      name: 1, email: 1, normalizedEmail: 1, phone: 1, businessProfile: 1, estimatedCreditLimit: 1, actualCreditLimit: 1,
      lifetimeValue: 1, rankingPaidTotal: 1, paidTotal: 1, totalPaid: 1, attemptedTotal: 1, paidMonths: 1, paidOrderCount: 1,
      activeSubscriptions: 1, isGatewayRecurring: 1, recurringAmount: 1, recurringNextEstimatedPayment: 1, riskLevel: 1, failedPayments: 1,
      chargebacks: 1, tier: 1, score: 1, lastPaidDate: 1, firstPaidDate: 1, paidProducts: 1, baseProductsPurchased: 1,
    }).sort({ lifetimeValue: -1, rankingPaidTotal: -1, paidTotal: -1 }).limit(1000).lean<LeanCustomer[]>(),
    CustomerRanking.find({}).sort({ lifetimeSpent: -1 }).limit(1000).lean<CustomerRankingDocument[]>(),
  ]);
  const rankingByEmail = new Map(rankings.map((ranking) => [ranking.email.toLowerCase(), ranking]));
  const rows = customers.map((customer) => {
    const ranking = rankingByEmail.get(customer.email.toLowerCase());
    const lifetime = moneyNumber(ranking?.lifetimeSpent ?? customer.lifetimeValue ?? customer.rankingPaidTotal ?? customer.paidTotal ?? customer.totalPaid);
    const industry = classifyIndustry(customer);
    const completeness = profileCompleteness(customer.businessProfile ?? {});
    const score = fundingScore(customer, ranking);
    const readinessTier = fundingTier(score, lifetime);
    const insight = insights(customer, score, lifetime, completeness, industry);
    return {
      _id: String(customer._id),
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      company: customer.businessProfile?.company || "",
      industry: industry.industry,
      industryClassification: industry.classification,
      naicsCode: industry.naicsCode,
      sicCode: industry.sicCode,
      fundingReadinessScore: score,
      fundingReadinessTier: readinessTier,
      vipTier: lifetime >= 10000 ? "VIP Elite" : lifetime >= 5000 ? "VIP" : lifetime >= 2000 ? "High Value" : "Standard",
      lifetimeSpent: lifetime,
      estimatedMRR: moneyNumber(ranking?.estimatedMRR ?? customer.recurringAmount),
      paidMonths: moneyNumber(ranking?.paidMonths ?? customer.paidMonths ?? customer.paidOrderCount),
      activeRecurring: moneyNumber(customer.activeSubscriptions) + (customer.isGatewayRecurring ? 1 : 0),
      creditLimit: moneyNumber(customer.businessProfile?.creditLimit || customer.actualCreditLimit),
      potentialCreditLimit: moneyNumber(customer.businessProfile?.potentialCreditLimit || customer.estimatedCreditLimit),
      net30Status: customer.businessProfile?.net30Status || customer.businessProfile?.accountStatus || "",
      profileCompleteness: completeness,
      riskLevel: customer.riskLevel,
      lastPaidDate: ranking?.latestPaidDate || customer.lastPaidDate,
      firstPaidDate: ranking?.firstPaidDate || customer.firstPaidDate,
      ...insight,
    };
  }).filter((row) => row.lifetimeSpent >= minSpent)
    .filter((row) => !tier || row.vipTier === tier)
    .filter((row) => !readiness || row.fundingReadinessTier === readiness)
    .sort((a, b) => b.fundingReadinessScore - a.fundingReadinessScore || b.lifetimeSpent - a.lifetimeSpent);
  const start = (page - 1) * limit;
  const summary = {
    totalCandidates: rows.length,
    fundingReady: rows.filter((row) => row.fundingReadinessScore >= 65).length,
    vipReady: rows.filter((row) => row.fundingReadinessScore >= 75 && row.lifetimeSpent >= 5000).length,
    averageScore: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.fundingReadinessScore, 0) / rows.length) : 0,
    totalLifetimeValue: rows.reduce((sum, row) => sum + row.lifetimeSpent, 0),
  };
  return NextResponse.json({
    page,
    limit,
    total: rows.length,
    rows: rows.slice(start, start + limit),
    summary,
    totalMs: Date.now() - started,
  });
}
