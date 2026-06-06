import "server-only";
import type { CustomerScoreInput } from "@/lib/customerScore";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_INDUSTRY_TIMEOUT_MS = 20000;

export type CustomerAiInput = CustomerScoreInput & {
  name: string;
  email: string;
  orderCount: number;
  lastOrderAmount: number;
  activeSubscriptions: number;
  tier: string;
  score: number;
  stars: number;
};

export type CustomerAiSummary = {
  aiSummary: string;
  aiSummaryPreview: string;
  riskExplanation: string;
  recommendedAction: string;
};

export type BusinessIndustryInput = {
  id: string;
  businessName: string;
  website: string;
  city: string;
  state: string;
  businessProfile?: unknown;
  customerProfile?: unknown;
};

export type BusinessIndustryClassification = {
  businessIndustry: string;
  industryCode: string;
  industryCodeType: string;
  industryDescription: string;
  confidence: "high" | "medium" | "low";
};

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
};

const industryClassificationCache = new Map<string, BusinessIndustryClassification>();

function getOpenAiApiKey() {
  return process.env.OPENAI_API_KEY?.trim() ?? "";
}

function isBuildPhase() {
  return process.env.NEXT_PHASE === "phase-production-build";
}

function buildRuleBasedSummary(customer: CustomerAiInput): CustomerAiSummary {
  const riskExplanation =
    customer.chargebacks > 0
      ? "Chargeback history indicates elevated payment dispute risk."
      : customer.failedPayments > 1
        ? "Multiple failed payments indicate billing friction and churn risk."
        : customer.refunds > 0
          ? "Refund activity suggests possible product fit or satisfaction concerns."
          : "Payment and refund patterns are stable with low detected risk.";

  const aiSummary = `${customer.name} (${customer.tier}) has ${customer.orderCount} orders, total paid $${customer.totalPaid.toFixed(2)}, and a score of ${customer.score}. ${riskExplanation}`;

  return {
    aiSummary,
    aiSummaryPreview: aiSummary.slice(0, 110) + (aiSummary.length > 110 ? "…" : ""),
    riskExplanation,
    recommendedAction:
      customer.score >= 80
        ? "Prioritize VIP retention with proactive outreach and premium upsell."
        : customer.score >= 50
          ? "Run a targeted retention sequence tied to recent purchase behavior."
          : "Place on manual payment-risk review and use conservative win-back incentives.",
  };
}

function extractText(response: OpenAIResponse) {
  if (response.output_text) return response.output_text;
  return response.output?.flatMap((item) => item.content ?? []).map((c) => c.text).filter(Boolean).join("\n");
}

function parseSummary(text: string | undefined) {
  if (!text) return null;
  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return null;
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<CustomerAiSummary>;
    if (!parsed.aiSummary || !parsed.recommendedAction || !parsed.riskExplanation) return null;
    return {
      aiSummary: parsed.aiSummary,
      aiSummaryPreview: parsed.aiSummaryPreview ?? `${parsed.aiSummary.slice(0, 110)}${parsed.aiSummary.length > 110 ? "…" : ""}`,
      riskExplanation: parsed.riskExplanation,
      recommendedAction: parsed.recommendedAction,
    };
  } catch {
    return null;
  }
}

export async function generateCustomerAiSummary(customer: CustomerAiInput): Promise<CustomerAiSummary> {
  const fallback = buildRuleBasedSummary(customer);
  if (isBuildPhase()) {
    console.warn("[openai] Build phase detected. Using rule-based fallback.");
    return fallback;
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    console.warn("[openai] OPENAI_API_KEY is missing. Using rule-based fallback.");
    return fallback;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          { role: "system", content: "Return JSON only: aiSummary, aiSummaryPreview, riskExplanation, recommendedAction." },
          { role: "user", content: JSON.stringify(customer) },
        ],
        max_output_tokens: 280,
      }),
    });

    if (!response.ok) {
      console.warn(`[openai] OpenAI request failed (${response.status} ${response.statusText}). Using rule-based fallback.`);
      return fallback;
    }
    const data = (await response.json()) as OpenAIResponse;
    return parseSummary(extractText(data)) ?? fallback;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OpenAI request error.";
    console.warn(`[openai] OpenAI request threw error. Using rule-based fallback. ${message}`);
    return fallback;
  }
}

function fallbackIndustryClassification(input: BusinessIndustryInput): BusinessIndustryClassification {
  const profile = input.businessProfile && typeof input.businessProfile === "object" ? input.businessProfile as Record<string, unknown> : {};
  const publicProfile = input.customerProfile && typeof input.customerProfile === "object" ? input.customerProfile as Record<string, unknown> : {};
  const industry = String(profile.industry ?? publicProfile.inferredIndustry ?? "").trim();
  const code = String(profile.naicsCode ?? publicProfile.naicsCode ?? profile.sicCode ?? publicProfile.sicCode ?? "").trim();
  const codeType = String(profile.naicsCode ?? publicProfile.naicsCode ?? "").trim() ? "NAICS" : String(profile.sicCode ?? publicProfile.sicCode ?? "").trim() ? "SIC" : "NAICS";
  return {
    businessIndustry: industry || "Missing",
    industryCode: code || "Missing",
    industryCodeType: code ? codeType : "NAICS",
    industryDescription: industry ? "Stored customer profile industry." : "Needs manual review",
    confidence: industry || code ? "medium" : "low",
  };
}

function normalizeIndustryClassification(value: Partial<BusinessIndustryClassification> | null | undefined, fallback: BusinessIndustryClassification): BusinessIndustryClassification {
  const confidence = value?.confidence === "high" || value?.confidence === "medium" || value?.confidence === "low" ? value.confidence : fallback.confidence;
  const cleanCode = (code: unknown) => {
    const normalized = String(code ?? "").trim();
    return !normalized || ["NA", "N/A", "NONE", "UNKNOWN", "000000", "999999"].includes(normalized.toUpperCase()) ? "Missing" : normalized;
  };
  if (confidence === "low") {
    return {
      businessIndustry: String(value?.businessIndustry || fallback.businessIndustry || "Missing").trim() || "Missing",
      industryCode: cleanCode(value?.industryCode || fallback.industryCode),
      industryCodeType: "NAICS",
      industryDescription: "Needs manual review",
      confidence: "low",
    };
  }
  return {
    businessIndustry: String(value?.businessIndustry || fallback.businessIndustry || "Missing").trim() || "Missing",
    industryCode: cleanCode(value?.industryCode || fallback.industryCode),
    industryCodeType: String(value?.industryCodeType || fallback.industryCodeType || "NAICS").trim().toUpperCase() || "NAICS",
    industryDescription: String(value?.industryDescription || fallback.industryDescription || "Needs manual review").trim() || "Needs manual review",
    confidence,
  };
}

function parseIndustryBatch(text: string | undefined) {
  if (!text) return [];
  try {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1) return [];
    return JSON.parse(text.slice(start, end + 1)) as Array<Partial<BusinessIndustryClassification> & { id?: string }>;
  } catch {
    return [];
  }
}

function industryCacheKey(input: BusinessIndustryInput) {
  return JSON.stringify(input);
}

export async function generateBusinessIndustryClassifications(inputs: BusinessIndustryInput[]): Promise<Record<string, BusinessIndustryClassification>> {
  const fallbackEntries = inputs.map((input) => [input.id, fallbackIndustryClassification(input)] as const);
  const fallback = Object.fromEntries(fallbackEntries);
  if (!inputs.length || isBuildPhase()) return fallback;

  const rows = { ...fallback };
  const uncached = inputs.filter((input) => {
    const cached = industryClassificationCache.get(industryCacheKey(input));
    if (cached) rows[input.id] = cached;
    return !cached;
  });
  if (!uncached.length) return rows;

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    console.warn("[openai] OPENAI_API_KEY is missing. Using stored industry fallback.");
    return rows;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(OPENAI_INDUSTRY_TIMEOUT_MS),
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          {
            role: "system",
            content: "Return JSON array only. For each input id, classify the business with businessIndustry, industryCode, industryCodeType, industryDescription, confidence. Use NAICS unless SIC is clearly better. Do not invent identity, contact, address, EIN, payment, score, state, or city fields. If uncertain set confidence low, industryCodeType NAICS, and industryDescription Needs manual review.",
          },
          { role: "user", content: JSON.stringify(uncached) },
        ],
        max_output_tokens: Math.max(1200, Math.min(7000, uncached.length * 160)),
      }),
    });

    if (!response.ok) {
      console.warn(`[openai] OpenAI industry request failed (${response.status} ${response.statusText}). Using stored industry fallback.`);
      return rows;
    }
    const data = (await response.json()) as OpenAIResponse;
    const parsed = parseIndustryBatch(extractText(data));
    const inputById = new Map(uncached.map((input) => [input.id, input]));
    for (const item of parsed) {
      if (!item.id || !rows[item.id]) continue;
      rows[item.id] = normalizeIndustryClassification(item, rows[item.id]);
      const input = inputById.get(item.id);
      if (input) industryClassificationCache.set(industryCacheKey(input), rows[item.id]);
    }
    return rows;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OpenAI request error.";
    console.warn(`[openai] OpenAI industry request threw error. Using stored industry fallback. ${message}`);
    return rows;
  }
}
