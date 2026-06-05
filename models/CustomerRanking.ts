import mongoose, { Schema } from "mongoose";

export interface CustomerRankingDocument {
  customerId: string;
  name: string;
  email: string;
  phone: string;
  businessName: string;
  businessNameSource: string;
  businessNameConfidence: string;
  businessAddress?: string;
  address1?: string;
  address2?: string;
  city?: string;
  stateCode: string;
  stateName: string;
  stateSource: string;
  stateConfidence: string;
  zip?: string;
  country?: string;
  ein?: string;
  contactFieldSources?: Record<string, string>;
  enrichmentSource: string;
  lifetimeSpent: number;
  periodSpent: number;
  monthlySpent: number;
  yearlySpent: number;
  paidMonths: number;
  firstPaidDate: string;
  latestPaidDate: string;
  activeSubscriptionCount: number;
  estimatedMRR: number;
  subscriptionNextPaymentDate?: string;
  subscriptionLastPaymentDate?: string;
  scheduleNeedsReview?: boolean;
  stayWithUsMonths: number;
  attemptedPipeline: number;
  category: string;
  fundingScore?: number;
  fundingCategory?: string;
  recommendedFundingProducts?: string[];
  fundingStrengths?: string[];
  fundingWeaknesses?: string[];
  nextBestAction?: string;
  fundingScoreBreakdown?: Record<string, number>;
  factiivProfileId?: string;
  factiivScore?: number;
  factiivReputationScore?: number;
  factiivHistoryScore?: number;
  factiivUtilizationScore?: number;
  factiivTradeLines?: number;
  factiivTotalTradeAmount?: number;
  factiivOutstandingBalance?: number;
  factiivVerifiedCreditLimit?: number;
  factiivMatchedBusiness?: string;
  factiivMatchedEmail?: string;
  factiivLastSync?: string;
  lastVerifiedAt?: string;
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
    businessName: { type: String, default: "" },
    businessNameSource: { type: String, default: "" },
    businessNameConfidence: { type: String, default: "" },
    businessAddress: { type: String, default: "" },
    address1: { type: String, default: "" },
    address2: { type: String, default: "" },
    city: { type: String, default: "" },
    stateCode: { type: String, default: "", index: true },
    stateName: { type: String, default: "" },
    stateSource: { type: String, default: "" },
    stateConfidence: { type: String, default: "" },
    zip: { type: String, default: "" },
    country: { type: String, default: "" },
    ein: { type: String, default: "" },
    contactFieldSources: { type: Schema.Types.Mixed, default: () => ({}) },
    enrichmentSource: { type: String, default: "" },
    lifetimeSpent: { type: Number, default: 0, index: true },
    periodSpent: { type: Number, default: 0 },
    monthlySpent: { type: Number, default: 0, index: true },
    yearlySpent: { type: Number, default: 0, index: true },
    paidMonths: { type: Number, default: 0 },
    firstPaidDate: { type: String, default: "" },
    latestPaidDate: { type: String, default: "" },
    activeSubscriptionCount: { type: Number, default: 0 },
    estimatedMRR: { type: Number, default: 0 },
    subscriptionNextPaymentDate: { type: String, default: "", index: true },
    subscriptionLastPaymentDate: { type: String, default: "" },
    scheduleNeedsReview: { type: Boolean, default: false, index: true },
    stayWithUsMonths: { type: Number, default: 0 },
    attemptedPipeline: { type: Number, default: 0 },
    category: { type: String, default: "" },
    fundingScore: { type: Number, default: 0 },
    fundingCategory: { type: String, default: "" },
    recommendedFundingProducts: { type: [String], default: [] },
    fundingStrengths: { type: [String], default: [] },
    fundingWeaknesses: { type: [String], default: [] },
    nextBestAction: { type: String, default: "" },
    fundingScoreBreakdown: { type: Schema.Types.Mixed, default: () => ({}) },
    factiivProfileId: { type: String, default: "" },
    factiivScore: { type: Number, default: 0 },
    factiivReputationScore: { type: Number, default: 0 },
    factiivHistoryScore: { type: Number, default: 0 },
    factiivUtilizationScore: { type: Number, default: 0 },
    factiivTradeLines: { type: Number, default: 0 },
    factiivTotalTradeAmount: { type: Number, default: 0 },
    factiivOutstandingBalance: { type: Number, default: 0 },
    factiivVerifiedCreditLimit: { type: Number, default: 0 },
    factiivMatchedBusiness: { type: String, default: "" },
    factiivMatchedEmail: { type: String, default: "" },
    factiivLastSync: { type: String, default: "" },
    lastVerifiedAt: { type: String, default: "", index: true },
    generatedAt: { type: String, default: "", index: true },
  },
  { timestamps: true }
);

customerRankingSchema.index({ lifetimeSpent: -1 });
customerRankingSchema.index({ monthlySpent: -1 });
customerRankingSchema.index({ yearlySpent: -1 });
customerRankingSchema.index({ stateCode: 1, lifetimeSpent: -1 });
customerRankingSchema.index({ latestPaidDate: -1 });
customerRankingSchema.index({ updatedAt: -1 });
customerRankingSchema.index({ createdAt: -1 });

export const CustomerRanking = mongoose.models.CustomerRanking || mongoose.model<CustomerRankingDocument>("CustomerRanking", customerRankingSchema);
