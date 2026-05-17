import mongoose, { Schema } from "mongoose";

export type SubscriptionSource = "woocommerce" | "stripe" | "authorize_net" | "nmi" | "manual";
export type SubscriptionStatus = "active" | "inactive" | "pending" | "canceled" | "past_due" | "failed" | "unknown";

export interface SubscriptionDocument {
  subscriptionId: string;
  source: SubscriptionSource;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  wordpressUserId: string;
  wooCustomerId: string;
  stripeCustomerId: string;
  authorizeNetCustomerProfileId: string;
  nmiCustomerVaultId: string;
  gatewayCustomerId: string;
  gatewayProfileId: string;
  status: SubscriptionStatus;
  amount: number;
  billingInterval: string;
  nextBillingDate: string;
  lastBillingDate: string;
  failedPaymentCount: number;
  lastPaymentStatus: string;
  approvedCredits: number;
  availableCredits: number;
  totalOutstanding: number;
  monthlyRecurringRevenue: number;
  lastSyncedAt: string;
}

const subscriptionSchema = new Schema<SubscriptionDocument>(
  {
    subscriptionId: { type: String, required: true },
    source: { type: String, enum: ["woocommerce", "stripe", "authorize_net", "nmi", "manual"], required: true },
    customerEmail: { type: String, required: true, index: true },
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "", index: true },
    wordpressUserId: { type: String, default: "" },
    wooCustomerId: { type: String, default: "" },
    stripeCustomerId: { type: String, default: "" },
    authorizeNetCustomerProfileId: { type: String, default: "" },
    nmiCustomerVaultId: { type: String, default: "" },
    gatewayCustomerId: { type: String, default: "" },
    gatewayProfileId: { type: String, default: "" },
    status: { type: String, enum: ["active", "inactive", "pending", "canceled", "past_due", "failed", "unknown"], default: "unknown", index: true },
    amount: { type: Number, required: true, default: 0 },
    billingInterval: { type: String, default: "monthly" },
    nextBillingDate: { type: String, default: "" , index: true},
    lastBillingDate: { type: String, default: "" },
    failedPaymentCount: { type: Number, default: 0 },
    lastPaymentStatus: { type: String, default: "unknown" },
    approvedCredits: { type: Number, default: 0, index: true },
    availableCredits: { type: Number, default: 0, index: true },
    totalOutstanding: { type: Number, default: 0, index: true },
    monthlyRecurringRevenue: { type: Number, default: 0 },
    lastSyncedAt: { type: String, required: true },
  },
  { timestamps: true }
);

subscriptionSchema.index({ source: 1, subscriptionId: 1 }, { unique: true });
subscriptionSchema.index({ customerName: 1 });
subscriptionSchema.index({ source: 1, status: 1 });

export const Subscription = mongoose.models.Subscription || mongoose.model<SubscriptionDocument>("Subscription", subscriptionSchema);
