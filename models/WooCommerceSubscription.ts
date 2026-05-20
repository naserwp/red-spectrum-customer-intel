import mongoose, { Schema } from "mongoose";

export interface WooCommerceSubscriptionDocument {
  wooSubscriptionId: number;
  subscriptionId: string;
  subscriptionNumber: string;
  status: string;
  customerId: number;
  customerName: string;
  customerEmail: string;
  normalizedEmail: string;
  customerPhone: string;
  productNames: string[];
  amount: number;
  recurringTotal: number;
  currency: string;
  billingInterval: string;
  billingPeriod: string;
  startDate: string;
  nextPaymentDate: string;
  lastPaymentDate: string;
  endDate: string;
  paymentMethod: string;
  paymentMethodTitle: string;
  relatedOrderIds: number[];
  importedAt: string;
  updatedAt: Date;
}

const wooCommerceSubscriptionSchema = new Schema<WooCommerceSubscriptionDocument>(
  {
    wooSubscriptionId: { type: Number, required: true, unique: true, index: true },
    subscriptionId: { type: String, default: "", index: true },
    subscriptionNumber: { type: String, default: "" },
    status: { type: String, default: "", index: true },
    customerId: { type: Number, default: 0, index: true },
    customerName: { type: String, default: "" },
    customerEmail: { type: String, default: "" },
    normalizedEmail: { type: String, default: "", index: true },
    customerPhone: { type: String, default: "" },
    productNames: { type: [String], default: [] },
    amount: { type: Number, default: 0 },
    recurringTotal: { type: Number, default: 0 },
    currency: { type: String, default: "" },
    billingInterval: { type: String, default: "" },
    billingPeriod: { type: String, default: "" },
    startDate: { type: String, default: "" },
    nextPaymentDate: { type: String, default: "", index: true },
    lastPaymentDate: { type: String, default: "" },
    endDate: { type: String, default: "" },
    paymentMethod: { type: String, default: "" },
    paymentMethodTitle: { type: String, default: "" },
    relatedOrderIds: { type: [Number], default: [] },
    importedAt: { type: String, default: "" },
  },
  { timestamps: true }
);

wooCommerceSubscriptionSchema.index({ status: 1, nextPaymentDate: 1 });

export const WooCommerceSubscriptionRecord = mongoose.models.WooCommerceSubscriptionRecord || mongoose.model<WooCommerceSubscriptionDocument>("WooCommerceSubscriptionRecord", wooCommerceSubscriptionSchema);
