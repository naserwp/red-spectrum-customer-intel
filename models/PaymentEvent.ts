import mongoose, { Schema } from "mongoose";

export interface PaymentEventDocument {
  provider: "nmi" | "stripe" | "authorize" | "woocommerce";
  eventType: string;
  transactionId: string;
  customerEmail: string;
  customerPhone: string;
  amount: number;
  status: string;
  rawPayload: Record<string, unknown>;
  receivedAt: string;
  processed: boolean;
  processingError: string;
}

const paymentEventSchema = new Schema<PaymentEventDocument>({
  provider: { type: String, enum: ["nmi", "stripe", "authorize", "woocommerce"], required: true, index: true },
  eventType: { type: String, required: true, index: true },
  transactionId: { type: String, default: "", index: true },
  customerEmail: { type: String, default: "", index: true },
  customerPhone: { type: String, default: "", index: true },
  amount: { type: Number, default: 0 },
  status: { type: String, default: "unknown", index: true },
  rawPayload: { type: Schema.Types.Mixed, required: true },
  receivedAt: { type: String, required: true },
  processed: { type: Boolean, default: false },
  processingError: { type: String, default: "" },
}, { timestamps: true });

export const PaymentEvent = mongoose.models.PaymentEvent || mongoose.model<PaymentEventDocument>("PaymentEvent", paymentEventSchema);
