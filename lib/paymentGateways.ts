import "server-only";
import type { CustomerOrderHistoryItem } from "@/models/Customer";

export type GatewayVerification = {
  provider: string;
  matched: boolean;
  confidence: "exact" | "high" | "medium" | "low" | "not_found";
  matchedBy: string;
  transactionId: string;
  transactionStatus: string;
  amount: number;
  transactionDate: string;
  paymentProfileId: string;
  rawSummary: string;
  lastCheckedAt: string;
  configured: boolean;
  notes: string;
};

export function getGatewayConfigurationSummary() {
  return {
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    authorizeNet: Boolean(process.env.AUTHORIZE_NET_API_LOGIN_ID && process.env.AUTHORIZE_NET_TRANSACTION_KEY),
    nmi: Boolean(process.env.NMI_SECURITY_KEY),
    cliq: Boolean(process.env.CLIQ_WEBHOOK_SECRET || process.env.NMI_SECURITY_KEY),
  };
}

export function hasConfiguredGateway() {
  const summary = getGatewayConfigurationSummary();
  return summary.stripe || summary.authorizeNet || summary.nmi || summary.cliq;
}

function inferProvider(order: Pick<CustomerOrderHistoryItem, "paymentMethod" | "paymentMethodTitle">) {
  const value = `${order.paymentMethod} ${order.paymentMethodTitle}`.toLowerCase();
  if (value.includes("stripe")) return "stripe";
  if (value.includes("authorize")) return "authorize_net";
  if (value.includes("nmi")) return "nmi";
  if (value.includes("cliq")) return "cliq";
  if (value.includes("crypto")) return "crypto";
  return value.trim() ? "unknown_gateway" : "woocommerce";
}

export async function verifyOrderPayment(order: CustomerOrderHistoryItem): Promise<GatewayVerification> {
  const provider = inferProvider(order);
  const configured = hasConfiguredGateway();
  const isCryptoHold = provider === "crypto" && order.status === "on-hold";

  return {
    provider,
    matched: false,
    confidence: "not_found",
    matchedBy: "",
    transactionId: order.transactionId,
    transactionStatus: isCryptoHold ? "on_hold" : "not_verified",
    amount: order.total,
    transactionDate: order.paidDate || order.attemptedDate || order.dateCreated,
    paymentProfileId: "",
    rawSummary: configured
      ? "Gateway API verification is not implemented for this provider yet. Manual verification required."
      : "Gateway verification not configured.",
    lastCheckedAt: new Date().toISOString(),
    configured,
    notes: isCryptoHold
      ? "Crypto order on hold. No completed payment verified."
      : configured
        ? "No completed payment found by safe placeholder verification."
        : "Gateway verification not configured.",
  };
}
