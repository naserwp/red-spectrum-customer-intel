import mongoose, { Schema } from "mongoose";
import { calculateCustomerScore, scoreToStars } from "@/lib/customerScore";

export type SubscriptionStatus = "active" | "inactive" | "canceled" | "past_due";

export interface CustomerDocument {
  name: string;
  email: string;
  phone: string;
  totalPaid: number;
  orderCount: number;
  lastOrderDate: string;
  lastOrderAmount: number;
  subscriptionStatus: SubscriptionStatus;
  activeSubscriptions: number;
  failedPayments: number;
  refunds: number;
  chargebacks: number;
  creditLimit: number;
  tier: string;
  aiSummary: string;
  recommendedAction: string;
}

const customerSchema = new Schema<CustomerDocument>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    totalPaid: { type: Number, required: true },
    orderCount: { type: Number, required: true },
    lastOrderDate: { type: String, required: true },
    lastOrderAmount: { type: Number, required: true },
    subscriptionStatus: {
      type: String,
      enum: ["active", "inactive", "canceled", "past_due"],
      required: true,
    },
    activeSubscriptions: { type: Number, required: true },
    failedPayments: { type: Number, required: true },
    refunds: { type: Number, required: true },
    chargebacks: { type: Number, required: true },
    creditLimit: { type: Number, required: true },
    tier: { type: String, required: true },
    aiSummary: { type: String, required: true },
    recommendedAction: { type: String, required: true },
  },
  { timestamps: true }
);

customerSchema.virtual("score").get(function () {
  return calculateCustomerScore(this as unknown as CustomerDocument);
});
customerSchema.virtual("stars").get(function () {
  return scoreToStars(calculateCustomerScore(this as unknown as CustomerDocument));
});

export const Customer = mongoose.models.Customer || mongoose.model<CustomerDocument>("Customer", customerSchema);
