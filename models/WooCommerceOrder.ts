import mongoose, { Schema } from "mongoose";
import type { CustomerBillingAddress, CustomerOrderLineItem, CustomerProductJourneyItem } from "@/models/Customer";

export interface WooCommerceOrderDocument {
  wooOrderId: number;
  orderNumber: string;
  status: string;
  dateCreated: string;
  dateModified: string;
  total: number;
  currency: string;
  paymentMethod: string;
  paymentMethodTitle: string;
  transactionId: string;
  customerId: number;
  billingFirstName: string;
  billingLastName: string;
  billingName: string;
  billingEmail: string;
  normalizedEmail: string;
  billingPhone: string;
  normalizedPhone: string;
  billingCompany: string;
  normalizedCompany: string;
  billingAddress: CustomerBillingAddress;
  lineItems: CustomerOrderLineItem[];
  products: CustomerOrderLineItem[];
  refundsCount: number;
  refundsAmount: number;
  customerNote: string;
  source: string;
  rawSafeMeta: Array<{ key: string; value: string }>;
  isPaid: boolean;
  isAttempted: boolean;
  paidAmount: number;
  attemptedAmount: number;
  productJourneyItems: CustomerProductJourneyItem[];
  importedAt: string;
  updatedAt: Date;
}

const lineItemSchema = new Schema<CustomerOrderLineItem>(
  {
    productId: { type: Number, default: 0 },
    variationId: { type: Number, default: 0 },
    name: { type: String, default: "" },
    sku: { type: String, default: "" },
    quantity: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    price: { type: Number, default: 0 },
  },
  { _id: false }
);

const billingAddressSchema = new Schema<CustomerBillingAddress>(
  {
    address1: { type: String, default: "" },
    address2: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    postcode: { type: String, default: "" },
    country: { type: String, default: "" },
  },
  { _id: false }
);

const productJourneyItemSchema = new Schema<CustomerProductJourneyItem>(
  {
    date: { type: String, default: "" },
    orderNumber: { type: String, default: "" },
    status: { type: String, default: "" },
    paymentMethod: { type: String, default: "" },
    productName: { type: String, default: "" },
    category: { type: String, enum: ["base_product", "boost", "design_or_setup", "other"], default: "other" },
    productType: { type: String, default: "Other" },
    amount: { type: Number, default: 0 },
    type: { type: String, enum: ["paid", "attempted"], default: "attempted" },
  },
  { _id: false }
);

const wooCommerceOrderSchema = new Schema<WooCommerceOrderDocument>(
  {
    wooOrderId: { type: Number, required: true, unique: true, index: true },
    orderNumber: { type: String, default: "" },
    status: { type: String, default: "", index: true },
    dateCreated: { type: String, default: "", index: true },
    dateModified: { type: String, default: "" },
    total: { type: Number, default: 0 },
    currency: { type: String, default: "" },
    paymentMethod: { type: String, default: "", index: true },
    paymentMethodTitle: { type: String, default: "" },
    transactionId: { type: String, default: "" },
    customerId: { type: Number, default: 0, index: true },
    billingFirstName: { type: String, default: "" },
    billingLastName: { type: String, default: "" },
    billingName: { type: String, default: "" },
    billingEmail: { type: String, default: "" },
    normalizedEmail: { type: String, default: "", index: true },
    billingPhone: { type: String, default: "" },
    normalizedPhone: { type: String, default: "", index: true },
    billingCompany: { type: String, default: "" },
    normalizedCompany: { type: String, default: "" },
    billingAddress: { type: billingAddressSchema, default: () => ({}) },
    lineItems: { type: [lineItemSchema], default: [] },
    products: { type: [lineItemSchema], default: [] },
    refundsCount: { type: Number, default: 0 },
    refundsAmount: { type: Number, default: 0 },
    customerNote: { type: String, default: "" },
    source: { type: String, default: "woocommerce" },
    rawSafeMeta: { type: [{ key: { type: String, default: "" }, value: { type: String, default: "" } }], default: [] },
    isPaid: { type: Boolean, default: false },
    isAttempted: { type: Boolean, default: false },
    paidAmount: { type: Number, default: 0 },
    attemptedAmount: { type: Number, default: 0 },
    productJourneyItems: { type: [productJourneyItemSchema], default: [] },
    importedAt: { type: String, default: "" },
  },
  { timestamps: true }
);

wooCommerceOrderSchema.index({ normalizedCompany: 1, billingName: 1 });

export const WooCommerceOrderRecord = mongoose.models.WooCommerceOrderRecord || mongoose.model<WooCommerceOrderDocument>("WooCommerceOrderRecord", wooCommerceOrderSchema);
