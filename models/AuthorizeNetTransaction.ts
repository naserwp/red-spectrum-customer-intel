import mongoose, { Schema } from "mongoose";

export interface AuthorizeNetTransactionDocument {
  transactionId: string;
  transactionStatus: string;
  responseCode: string;
  authCode: string;
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
  cardType: string;
  cardLast4: string;
  paymentMethod: string;
  customerProfileId: string;
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

const authorizeNetTransactionSchema = new Schema<AuthorizeNetTransactionDocument>(
  {
    transactionId: { type: String, required: true, unique: true, index: true },
    transactionStatus: { type: String, default: "", index: true },
    responseCode: { type: String, default: "" },
    authCode: { type: String, default: "" },
    invoiceNumber: { type: String, default: "", index: true },
    description: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    submittedAt: { type: String, default: "", index: true },
    settledAt: { type: String, default: "", index: true },
    customerEmail: { type: String, default: "" },
    normalizedEmail: { type: String, default: "", index: true },
    emailNormalized: { type: String, default: "", index: true },
    customerName: { type: String, default: "" },
    billingFirstName: { type: String, default: "" },
    billingLastName: { type: String, default: "" },
    billingCompany: { type: String, default: "" },
    billingPhone: { type: String, default: "" },
    cardType: { type: String, default: "" },
    cardLast4: { type: String, default: "", index: true },
    paymentMethod: { type: String, default: "card" },
    customerProfileId: { type: String, default: "", index: true },
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

authorizeNetTransactionSchema.index({ normalizedEmail: 1, submittedAt: -1 });

export const AuthorizeNetTransaction = mongoose.models.AuthorizeNetTransaction || mongoose.model<AuthorizeNetTransactionDocument>("AuthorizeNetTransaction", authorizeNetTransactionSchema);
