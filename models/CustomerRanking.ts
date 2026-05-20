import mongoose, { Schema } from "mongoose";

export interface CustomerRankingDocument {
  customerId: string;
  name: string;
  email: string;
  phone: string;
  lifetimeSpent: number;
  periodSpent: number;
  monthlySpent: number;
  yearlySpent: number;
  paidMonths: number;
  firstPaidDate: string;
  latestPaidDate: string;
  activeSubscriptionCount: number;
  estimatedMRR: number;
  stayWithUsMonths: number;
  attemptedPipeline: number;
  category: string;
  generatedAt: string;
  updatedAt: Date;
  createdAt: Date;
}

const customerRankingSchema = new Schema<CustomerRankingDocument>(
  {
    customerId: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: "" },
    email: { type: String, default: "", index: true },
    phone: { type: String, default: "" },
    lifetimeSpent: { type: Number, default: 0, index: true },
    periodSpent: { type: Number, default: 0 },
    monthlySpent: { type: Number, default: 0, index: true },
    yearlySpent: { type: Number, default: 0, index: true },
    paidMonths: { type: Number, default: 0 },
    firstPaidDate: { type: String, default: "" },
    latestPaidDate: { type: String, default: "" },
    activeSubscriptionCount: { type: Number, default: 0 },
    estimatedMRR: { type: Number, default: 0 },
    stayWithUsMonths: { type: Number, default: 0 },
    attemptedPipeline: { type: Number, default: 0 },
    category: { type: String, default: "" },
    generatedAt: { type: String, default: "", index: true },
  },
  { timestamps: true }
);

customerRankingSchema.index({ lifetimeSpent: -1 });
customerRankingSchema.index({ monthlySpent: -1 });
customerRankingSchema.index({ yearlySpent: -1 });
customerRankingSchema.index({ updatedAt: -1 });
customerRankingSchema.index({ createdAt: -1 });

export const CustomerRanking = mongoose.models.CustomerRanking || mongoose.model<CustomerRankingDocument>("CustomerRanking", customerRankingSchema);
