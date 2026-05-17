import mongoose, { Schema } from "mongoose";
import { calculateCustomerScore, scoreToStars } from "@/lib/customerScore";

export type SubscriptionStatus = "active" | "inactive" | "canceled" | "past_due" | "unknown";
export type RiskLevel = "low" | "medium" | "high";

export interface CustomerDocument {
  name: string;
  email: string;
  phone: string;
  totalPaid: number;
  paidTotal: number;
  attemptedTotal: number;
  orderCount: number;
  paidOrderCount: number;
  attemptedOrderCount: number;
  firstOrderDate: string;
  lastOrderDate: string;
  lastPaidDate: string;
  lastAttemptDate: string;
  lastOrderAmount: number;
  averageOrderValue: number;
  subscriptionStatus: SubscriptionStatus;
  activeSubscriptions: number;
  failedPayments: number;
  refunds: number;
  chargebacks: number;
  estimatedCreditLimit: number;
  actualCreditLimit: number | null;
  tier: string;
  leadStatus: string;
  paymentStatus: string;
  riskLevel: RiskLevel;
  tags: string[];
  notes: string;
  lastSyncedAt: string;
  aiSummary: string;
  aiSummaryPreview: string;
  riskExplanation: string;
  recommendedAction: string;
  score: number;
  stars: number;
}

const customerSchema = new Schema<CustomerDocument>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    totalPaid: { type: Number, required: true },
    paidTotal: { type: Number, required: true, default: 0 },
    attemptedTotal: { type: Number, required: true, default: 0 },
    orderCount: { type: Number, required: true },
    paidOrderCount: { type: Number, required: true, default: 0 },
    attemptedOrderCount: { type: Number, required: true, default: 0 },
    firstOrderDate: { type: String, default: new Date(0).toISOString() },
    lastOrderDate: { type: String, required: true },
    lastPaidDate: { type: String, default: "" },
    lastAttemptDate: { type: String, default: "" },
    lastOrderAmount: { type: Number, required: true },
    averageOrderValue: { type: Number, required: true },
    subscriptionStatus: { type: String, enum: ["active", "inactive", "canceled", "past_due", "unknown"], required: true },
    activeSubscriptions: { type: Number, required: true },
    failedPayments: { type: Number, required: true },
    refunds: { type: Number, required: true },
    chargebacks: { type: Number, required: true },
    estimatedCreditLimit: { type: Number, required: true },
    actualCreditLimit: { type: Number, default: null },
    tier: { type: String, required: true },
    leadStatus: { type: String, required: true, default: "cold_lead" },
    paymentStatus: { type: String, required: true, default: "unpaid" },
    riskLevel: { type: String, enum: ["low", "medium", "high"], required: true, default: "low" },
    tags: { type: [String], default: [] },
    notes: { type: String, default: "" },
    lastSyncedAt: { type: String, required: true },
    aiSummary: { type: String, required: true },
    aiSummaryPreview: { type: String, required: true },
    riskExplanation: { type: String, required: true },
    recommendedAction: { type: String, required: true },
    score: { type: Number, required: true, default: 0 },
    stars: { type: Number, required: true, default: 1 },
  },
  { timestamps: true }
);

customerSchema.pre("validate", function () {
  if (this.paidTotal === undefined || this.paidTotal === null) this.paidTotal = this.totalPaid ?? 0;
  if (this.totalPaid === undefined || this.totalPaid === null) this.totalPaid = this.paidTotal ?? 0;
  if (!this.score) this.score = calculateCustomerScore(this as unknown as CustomerDocument);
  if (!this.stars) this.stars = scoreToStars(this.score);
});

export const Customer = mongoose.models.Customer || mongoose.model<CustomerDocument>("Customer", customerSchema);
