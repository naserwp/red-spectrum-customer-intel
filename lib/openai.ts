import "server-only";
import type { CustomerScoreInput } from "@/lib/customerScore";

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

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

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
};

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
  if (isBuildPhase()) return fallback;

  const apiKey = getOpenAiApiKey();
  if (!apiKey) return fallback;

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

    if (!response.ok) return fallback;
    const data = (await response.json()) as OpenAIResponse;
    return parseSummary(extractText(data)) ?? fallback;
  } catch {
    return fallback;
  }
}
