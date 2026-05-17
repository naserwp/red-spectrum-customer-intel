export type CustomerScoreInput = {
  totalPaid: number;
  subscriptionStatus: "active" | "inactive" | "canceled" | "past_due" | "unknown";
  lastOrderDate: string;
  refunds: number;
  chargebacks: number;
  failedPayments: number;
};

export function calculateCustomerScore(input: CustomerScoreInput): number {
  let score = 0;

  if (input.totalPaid >= 2500) score += 50;
  else if (input.totalPaid >= 999) score += 35;
  else if (input.totalPaid >= 200) score += 20;
  else score += 10;

  if (input.subscriptionStatus === "active") score += 25;

  const daysSinceLastOrder = Math.floor(
    (Date.now() - new Date(input.lastOrderDate).getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysSinceLastOrder <= 30) score += 15;
  else if (daysSinceLastOrder <= 90) score += 10;

  if (input.refunds > 0) score -= 20;
  if (input.chargebacks > 0) score -= 40;
  if (input.failedPayments > 0) score -= 10;

  return Math.max(0, Math.min(100, score));
}

export function scoreToStars(score: number): number {
  if (score >= 80) return 5;
  if (score >= 60) return 4;
  if (score >= 40) return 3;
  if (score >= 20) return 2;
  return 1;
}
