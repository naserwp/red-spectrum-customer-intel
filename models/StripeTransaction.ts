import mongoose, { Schema } from "mongoose";

export interface StripeTransactionDocument {
  stripePaymentIntentId: string;
  chargeId: string;
  transactionId: string;
  stripeCustomerId: string;
  customerId: string;
  email: string;
  normalizedEmail: string;
  emailNormalized: string;
  phone: string;
  normalizedPhone: string;
  name: string;
  amount: number;
  amountRefunded: number;
  currency: string;
  status: string;
  stripeStatus: string;
  stripeCreatedAt: string;
  paidAt: string;
  cardLast4: string;
  cardBrand: string;
  description: string;
  invoiceNumber: string;
  metadata: Record<string, unknown>;
  rawSafeMeta: Array<{ key: string; value: string }>;
  matchedCustomerId: string;
  matchedBy: string;
  matchConfidence: "exact" | "high" | "medium" | "low" | "not_found";
  wooOrderNumberMatched: string;
  wooOrderIdMatched: number;
  source: "stripe";
  importedAt: string;
  updatedAt: Date;
}

const safeMetaSchema = new Schema(
  {
    key: { type: String, default: "" },
    value: { type: String, default: "" },
  },
  { _id: false }
);

const stripeTransactionSchema = new Schema<StripeTransactionDocument>(
  {
    stripePaymentIntentId: { type: String, default: "", index: true },
    chargeId: { type: String, required: true, unique: true, index: true },
    transactionId: { type: String, required: true, unique: true, index: true },
    stripeCustomerId: { type: String, default: "", index: true },
    customerId: { type: String, default: "" },
    email: { type: String, default: "" },
    normalizedEmail: { type: String, default: "", index: true },
    emailNormalized: { type: String, default: "", index: true },
    phone: { type: String, default: "" },
    normalizedPhone: { type: String, default: "", index: true },
    name: { type: String, default: "", index: true },
    amount: { type: Number, default: 0 },
    amountRefunded: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    status: { type: String, default: "", index: true },
    stripeStatus: { type: String, default: "", index: true },
    stripeCreatedAt: { type: String, default: "", index: true },
    paidAt: { type: String, default: "", index: true },
    cardLast4: { type: String, default: "", index: true },
    cardBrand: { type: String, default: "" },
    description: { type: String, default: "" },
    invoiceNumber: { type: String, default: "", index: true },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
    rawSafeMeta: { type: [safeMetaSchema], default: [] },
    matchedCustomerId: { type: String, default: "", index: true },
    matchedBy: { type: String, default: "" },
    matchConfidence: { type: String, enum: ["exact", "high", "medium", "low", "not_found"], default: "not_found" },
    wooOrderNumberMatched: { type: String, default: "" },
    wooOrderIdMatched: { type: Number, default: 0 },
    source: { type: String, enum: ["stripe"], default: "stripe" },
    importedAt: { type: String, default: "", index: true },
  },
  { timestamps: true }
);

stripeTransactionSchema.index({ normalizedEmail: 1, stripeCreatedAt: -1 });
stripeTransactionSchema.index({ invoiceNumber: 1, amount: 1, stripeCreatedAt: -1 });
stripeTransactionSchema.index({ chargeId: 1, stripePaymentIntentId: 1 });
stripeTransactionSchema.index({ createdAt: -1 });

export const StripeTransaction = mongoose.models.StripeTransaction || mongoose.model<StripeTransactionDocument>("StripeTransaction", stripeTransactionSchema);
