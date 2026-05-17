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
  recommendedAction: string;
};

type OpenAIResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
    }>;
  }>;
};

function getOpenAiApiKey() {
  return process.env.OPENAI_API_KEY?.trim() ?? "";
}

function isBuildPhase() {
  return process.env.NEXT_PHASE === "phase-production-build";
}

function buildRuleBasedSummary(customer: CustomerAiInput): CustomerAiSummary {
  const orderLabel = customer.orderCount === 1 ? "order" : "orders";
  const riskNote =
    customer.chargebacks > 0
      ? "Chargeback history makes this account high risk."
      : customer.refunds > 0
        ? "Refund history should be reviewed before outreach."
        : "Payment history is currently clean.";

  return {
    aiSummary: `${customer.name} is a ${customer.tier} customer with ${customer.orderCount} ${orderLabel}, $${customer.totalPaid.toFixed(2)} total paid, and a score of ${customer.score}. ${riskNote}`,
    recommendedAction:
      customer.score >= 80
        ? "Prioritize VIP retention and offer a high-value upgrade."
        : customer.score >= 50
          ? "Send a targeted retention offer based on recent purchase history."
          : "Review payment risk and use a conservative win-back offer.",
  };
}

function extractText(response: OpenAIResponse) {
  if (response.output_text) return response.output_text;

  return response.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter(Boolean)
    .join("\n");
}

function parseSummary(text: string | undefined) {
  if (!text) return null;

  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return null;

    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<CustomerAiSummary>;
    if (!parsed.aiSummary || !parsed.recommendedAction) return null;

    return {
      aiSummary: parsed.aiSummary,
      recommendedAction: parsed.recommendedAction,
    };
  } catch {
    return null;
  }
}

export async function generateCustomerAiSummary(customer: CustomerAiInput): Promise<CustomerAiSummary> {
  const fallback = buildRuleBasedSummary(customer);

  if (isBuildPhase()) {
    console.warn("[openai] Build phase detected. Skipping OpenAI call and using rule-based fallback.");
    return fallback;
  }

  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    console.warn("[openai] OPENAI_API_KEY is missing. Using rule-based customer summary fallback.");
    return fallback;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          {
            role: "system",
            content:
              "You write concise internal customer intelligence notes. Return only JSON with aiSummary and recommendedAction strings.",
          },
          {
            role: "user",
            content: JSON.stringify(customer),
          },
        ],
        max_output_tokens: 220,
      }),
    });

    if (!response.ok) {
      console.warn(`[openai] Summary request failed: ${response.status} ${response.statusText}. Using fallback.`);
      return fallback;
    }

    const data = (await response.json()) as OpenAIResponse;
    return parseSummary(extractText(data)) ?? fallback;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OpenAI request error.";
    console.warn(`[openai] Summary request failed. Using fallback. ${message}`);
    return fallback;
  }
}
