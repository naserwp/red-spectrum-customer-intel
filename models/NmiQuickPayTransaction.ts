import mongoose, { Schema } from "mongoose";

export interface NmiQuickPayTransactionDocument {
  transactionId: string;
  transactionStatus: string;
  responseCode: string;
  invoiceNumber: string;
  description: string;
  amount: number;
  currency: string;
  submittedAt: string;
  settledAt: string;
  customerEmail: string;
  normalizedEmail: string;
  emailNormalized: string;
  customerName: string;
  billingFirstName: string;
  billingLastName: string;
  billingCompany: string;
  billingPhone: string;
  normalizedPhone: string;
  cardType: string;
  cardLast4: string;
  paymentMethod: string;
  customerVaultId: string;
  customerPaymentProfileId: string;
  wooOrderNumberMatched: string;
  wooOrderIdMatched: number;
  matchedCustomerId: string;
  matchedBy: string;
  matchConfidence: "exact" | "high" | "medium" | "low" | "not_found";
  rawSafeMeta: Array<{ key: string; value: string }>;
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

const nmiQuickPayTransactionSchema = new Schema<NmiQuickPayTransactionDocument>(
  {
    transactionId: { type: String, required: true, unique: true, index: true },
    transactionStatus: { type: String, default: "", index: true },
    responseCode: { type: String, default: "" },
    invoiceNumber: { type: String, default: "", index: true },
    description: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    submittedAt: { type: String, default: "", index: true },
    settledAt: { type: String, default: "", index: true },
    customerEmail: { type: String, default: "" },
    normalizedEmail: { type: String, default: "", index: true },
    emailNormalized: { type: String, default: "", index: true },
    customerName: { type: String, default: "", index: true },
    billingFirstName: { type: String, default: "" },
    billingLastName: { type: String, default: "" },
    billingCompany: { type: String, default: "", index: true },
    billingPhone: { type: String, default: "" },
    normalizedPhone: { type: String, default: "", index: true },
    cardType: { type: String, default: "" },
    cardLast4: { type: String, default: "", index: true },
    paymentMethod: { type: String, default: "card" },
    customerVaultId: { type: String, default: "", index: true },
    customerPaymentProfileId: { type: String, default: "", index: true },
    wooOrderNumberMatched: { type: String, default: "" },
    wooOrderIdMatched: { type: Number, default: 0 },
    matchedCustomerId: { type: String, default: "" },
    matchedBy: { type: String, default: "" },
    matchConfidence: { type: String, enum: ["exact", "high", "medium", "low", "not_found"], default: "not_found" },
    rawSafeMeta: { type: [safeMetaSchema], default: [] },
    importedAt: { type: String, default: "" },
  },
  { timestamps: true }
);

nmiQuickPayTransactionSchema.index({ normalizedEmail: 1, submittedAt: -1 });
nmiQuickPayTransactionSchema.index({ invoiceNumber: 1, amount: 1, submittedAt: -1 });
nmiQuickPayTransactionSchema.index({ customerName: 1, submittedAt: -1 });
nmiQuickPayTransactionSchema.index({ createdAt: -1 });

export const NmiQuickPayTransaction = mongoose.models.NmiQuickPayTransaction || mongoose.model<NmiQuickPayTransactionDocument>("NmiQuickPayTransaction", nmiQuickPayTransactionSchema);
