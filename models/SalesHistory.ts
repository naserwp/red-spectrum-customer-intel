import mongoose, { Schema } from "mongoose";

export interface SalesPeriodMetricDocument {
  period: string;
  paidRevenue: number;
  attemptedPipeline: number;
  paidOrders: number;
  attemptedOrders: number;
  failedPayments: number;
  refunds: number;
  chargebacks: number;
  newPaidCustomers: number;
  newLeads: number;
  averageOrderValue: number;
}

export interface SalesHistoryDocument {
  source: string;
  years: number;
  generatedAt: string;
  yearly: SalesPeriodMetricDocument[];
  monthly: SalesPeriodMetricDocument[];
}

const salesPeriodMetricSchema = new Schema<SalesPeriodMetricDocument>(
  {
    period: { type: String, required: true },
    paidRevenue: { type: Number, default: 0 },
    attemptedPipeline: { type: Number, default: 0 },
    paidOrders: { type: Number, default: 0 },
    attemptedOrders: { type: Number, default: 0 },
    failedPayments: { type: Number, default: 0 },
    refunds: { type: Number, default: 0 },
    chargebacks: { type: Number, default: 0 },
    newPaidCustomers: { type: Number, default: 0 },
    newLeads: { type: Number, default: 0 },
    averageOrderValue: { type: Number, default: 0 },
  },
  { _id: false }
);

const salesHistorySchema = new Schema<SalesHistoryDocument>(
  {
    source: { type: String, required: true, unique: true },
    years: { type: Number, required: true, default: 5 },
    generatedAt: { type: String, required: true },
    yearly: { type: [salesPeriodMetricSchema], default: [] },
    monthly: { type: [salesPeriodMetricSchema], default: [] },
  },
  { timestamps: true }
);

export const SalesHistory = mongoose.models.SalesHistory || mongoose.model<SalesHistoryDocument>("SalesHistory", salesHistorySchema);
