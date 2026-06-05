import mongoose, { Schema } from "mongoose";
import { calculateCustomerScore, scoreToStars } from "@/lib/customerScore";

export type SubscriptionStatus = "active" | "inactive" | "canceled" | "past_due" | "unknown";
export type RiskLevel = "low" | "medium" | "high";

export interface CustomerOrderLineItem {
  productId: number;
  variationId: number;
  name: string;
  sku: string;
  quantity: number;
  subtotal: number;
  total: number;
  price: number;
}

export interface CustomerOrderMetaSummary {
  key: string;
  value: string;
}

export interface CustomerBillingAddress {
  address1: string;
  address2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
}

export interface GatewayVerification {
  provider: string;
  matched: boolean;
  confidence: "exact" | "high" | "medium" | "low" | "not_found";
  matchedBy: string;
  transactionId: string;
  transactionStatus: string;
  amount: number;
  transactionDate: string;
  customerVaultId: string;
  paymentProfileId: string;
  customerProfileId: string;
  paymentIntentId: string;
  chargeId: string;
  stripeCustomerId: string;
  paymentMethodId: string;
  last4: string;
  cardType: string;
  candidatesCount: number;
  rawSummary: string;
  lastCheckedAt: string;
  configured: boolean;
  notes: string;
}

export interface CustomerOrderHistoryItem {
  orderId: string;
  orderNumber: string;
  customerId: number;
  status: string;
  dateCreated: string;
  dateModified: string;
  total: number;
  currency: string;
  paymentMethod: string;
  paymentMethodTitle: string;
  transactionId: string;
  paidDate: string;
  attemptedDate: string;
  isPaid: boolean;
  isAttempted: boolean;
  billingName: string;
  billingEmail: string;
  billingPhone: string;
  billingFirstName: string;
  billingLastName: string;
  billingCompany: string;
  billingAddress: CustomerBillingAddress;
  lineItems: CustomerOrderLineItem[];
  products: CustomerOrderLineItem[];
  refundsCount: number;
  refundsAmount: number;
  metaData: CustomerOrderMetaSummary[];
  customerNote: string;
  checkoutSource: string;
  source: string;
  matchedBy: string[];
  matchConfidence: string;
  gatewayVerification: GatewayVerification;
}

export interface CustomerProductJourneyItem {
  date: string;
  orderNumber: string;
  status: string;
  paymentMethod: string;
  productName: string;
  category: "base_product" | "boost" | "design_or_setup" | "other";
  productType: string;
  amount: number;
  type: "paid" | "attempted";
}

export interface CustomerGatewayPayment {
  date: string;
  provider: string;
  transactionId: string;
  invoiceNumber: string;
  status: string;
  amount: number;
  cardLast4: string;
  cardType: string;
  matchedBy: string;
  matchConfidence: string;
  source: string;
  customerProfileId: string;
  customerPaymentProfileId: string;
}

export interface CustomerBusinessProfile {
  firstName: string;
  lastName: string;
  businessName?: string;
  businessNameSource?: string;
  businessNameConfidence?: string;
  company: string;
  dba: string;
  email: string;
  phone: string;
  address1: string;
  address2: string;
  shippingAddress1: string;
  shippingAddress2: string;
  shippingCity: string;
  shippingState: string;
  shippingZip: string;
  shippingCountry: string;
  city: string;
  state: string;
  stateCode?: string;
  stateSource?: string;
  stateConfidence?: string;
  enrichmentSource?: string;
  zip: string;
  country: string;
  website: string;
  sourcePlatform: string;
  customerSince: string;
  lastActivity: string;
  ein: string;
  approvedCredits: number;
  availableCredit: number;
  outstandingBalance: number;
  creditStatus: string;
  creditMetaVerified: boolean;
  creditMetaSource: string;
  creditFallbackReason: string;
  potentialCreditLimit: number;
  creditLimit: number;
  creditLimitLastUpdated: string;
  lastBillDate: string;
  nextBillingDate: string;
  net30Status: string;
  accountStatus: string;
  businessType: string;
  industry: string;
  industryClassification: string;
  naicsCode: string;
  sicCode: string;
  fundingReadinessScore: number;
  fundingReadinessTier: string;
  fundingScore?: number;
  fundingCategory?: string;
  recommendedFundingProducts?: string[];
  fundingStrengths?: string[];
  fundingWeaknesses?: string[];
  nextBestAction?: string;
  fundingSummary?: string;
  businessVerificationScore?: number;
  industryRiskScore?: number;
  fundingScoreBreakdown?: Record<string, number>;
  source: string;
  importedAt: string;
}

export interface CustomerCreditProfile {
  approvedCredits: number;
  availableCredit: number;
  outstandingBalance: number;
  creditStatus: string;
  lastBillDate: string;
  nextBillingDate: string;
  sourcePostId: string;
  sourcePostType: string;
  sourceOrderId: string;
  sourceSubscriptionId: string;
  linkedUserId: string;
  linkedCustomerId: string;
  email: string;
  phone: string;
  company: string;
  ein: string;
  source: "wc_cs_credits" | "";
  verified: boolean;
  importedAt: string;
}

export interface CustomerFactiivProfile {
  profileId?: string;
  factiivProfileId: string;
  score?: number;
  businessScore?: number;
  creditScore?: number;
  report?: Record<string, unknown>;
  analytics?: Record<string, unknown>;
  funding?: Record<string, unknown>;
  factiivScore: number;
  reputationScore: number;
  historyScore: number;
  utilizationScore: number;
  tradeQuantity: number;
  tradeAmountTotal: number;
  tradeBalanceTotal: number;
  activityQuantity: number;
  activityPaymentAmountTotal: number;
  activityLastKnownBalanceTotal: number;
  matchedBusinessName: string;
  matchedEmail: string;
  matchedUsername: string;
  factiivMatched: boolean;
  factiivMatchConfidence: string;
  matchedBy: string;
  autoPersisted: boolean;
  autoPersistReason: string;
  factiivSearchQuery: string;
  factiivMatchReason: string;
  lastFactiivSync: string;
  manualAttachedBy: string;
  manualAttachedAt: string;
  trades: Array<{
    tradeId: string;
    tradeName: string;
    tradeType: string;
    relation: string;
    amount: number;
    balance: number;
    tradeStatus: string;
    adminStatus: string;
    fromCompanyName: string;
    toCompanyName: string;
    lastActivity: string;
    utilizationPercent: number;
  }>;
  activities: Array<{
    activityDate: string;
    activityType: string;
    paymentAmount: number;
    chargeAmount: number;
    interest: number;
    daysLate: number;
    paymentStatus: string;
  }>;
  source: string;
  rawSummary: string;
}

export interface CustomerPublicEnrichment {
  websiteDomain: string;
  linkedInCompanyUrl: string;
  facebookPageUrl: string;
  instagramUrl: string;
  twitterUrl: string;
  publicBusinessWebsite: string;
  googleBusinessProfileUrl: string;
  secretaryOfStateUrl: string;
  inferredIndustry: string;
  naicsCode: string;
  sicCode: string;
  enrichmentSources: string[];
  socialProfilesFound: number;
  publicBusinessDataFound: boolean;
  confidence: string;
  enrichmentStatus: string;
  lastChecked: string;
  lastEnrichmentRun: string;
}

export interface CustomerDocument {
  name: string;
  email: string;
  normalizedEmail: string;
  emailNormalized: string;
  phone: string;
  phoneNormalized: string;
  totalPaid: number;
  paidTotal: number;
  lifetimeValue: number;
  rankingPaidTotal: number;
  wooPaidTotal: number;
  authorizeNetPaidTotal: number;
  gatewayOnlyPaidTotal: number;
  nmiQuickPayPaidTotal: number;
  stripePaidTotal: number;
  subscriptionPaidTotal: number;
  attemptedTotal: number;
  orderCount: number;
  paidOrderCount: number;
  gatewayPaidCount: number;
  attemptedOrderCount: number;
  paidMonths: number;
  firstPaidDate: string;
  subscriptionStartDate: string;
  stayWithUsMonths: number;
  firstOrderDate: string;
  latestOrderDate?: string;
  customerCreatedAt?: string;
  latestCustomerCreatedAt?: string;
  lastOrderDate: string;
  lastPaidDate: string;
  lastAttemptDate: string;
  lastOrderAmount: number;
  averageOrderValue: number;
  subscriptionStatus: SubscriptionStatus;
  activeSubscriptions: number;
  isGatewayRecurring: boolean;
  recurringSource: string;
  recurringAmount: number;
  recurringFrequencyEstimate: string;
  recurringLastPayment: string;
  recurringNextEstimatedPayment: string;
  recurringPaymentCount: number;
  failedPayments: number;
  refunds: number;
  chargebacks: number;
  estimatedCreditLimit: number;
  actualCreditLimit: number | null;
  tier: string;
  leadStatus: string;
  paymentStatus: string;
  riskLevel: RiskLevel;
  tags: string[];
  notes: string;
  lastSyncedAt: string;
  aiSummary: string;
  aiSummaryPreview: string;
  riskExplanation: string;
  recommendedAction: string;
  score: number;
  stars: number;
  orders: CustomerOrderHistoryItem[];
  lastProducts: string[];
  attemptedProducts: string[];
  paidProducts: string[];
  lastPaymentMethod: string;
  lastAttemptPaymentMethod: string;
  lastAttemptStatus: string;
  firstSignupOrderNumber: string;
  firstSignupDate: string;
  firstSignupAmount: number;
  firstSignupProduct: string;
  baseProductsPurchased: string[];
  boostProductsPurchased: string[];
  addOnProductsPurchased: string[];
  attemptedBaseProducts: string[];
  attemptedBoostProducts: string[];
  attemptedAddOnProducts: string[];
  lastPurchasedProduct: string;
  lastAttemptedProduct: string;
  productJourney: CustomerProductJourneyItem[];
  leadUrgency: string;
  recommendedContactMethod: string;
  nextAction: string;
  gatewayVerification: GatewayVerification;
  gatewayPayments: CustomerGatewayPayment[];
  sourceCoverage: CustomerSourceCoverage;
  businessProfile: CustomerBusinessProfile;
  creditProfile: CustomerCreditProfile;
  factiivProfile: CustomerFactiivProfile;
  publicEnrichment: CustomerPublicEnrichment;
  externalCustomerKey: string;
}

export interface CustomerSourceCoverage {
  deepWooSearch: boolean;
  ordersStored: number;
  ordersStoredCount: number;
  matchReasonCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  paymentMethodCounts: Record<string, number>;
  syncStatus: "success" | "success_with_warnings" | "success_no_orders" | "failed" | "partial_timeout" | "";
  lastDeepSyncAt: string;
  lastAttemptedDeepSyncAt: string;
  lastDeepSyncStatus: "success" | "success_with_warnings" | "success_no_orders" | "failed" | "partial_timeout" | "";
  lastSyncedAt: string;
  warningSummary: string;
  warnings: string[];
  aggregationKey: string;
  aggregationKeyType: "email" | "phone" | "customerId" | "company" | "";
  lastBackfillImportAt: string;
  lastCustomerRebuildAt: string;
  wooCommerceCustomerOrdersStored: number;
  wooCommerceOrderRecordsFound: number;
  authorizeNetTransactionsFound: number;
  nmiQuickPayTransactionsFound: number;
  stripeTransactionsFound: number;
  lastStripeSyncAt?: string;
  gatewayOnlyPaymentsAttached: number;
  reconciledRecords: number;
  missingUnattachedRecords: number;
  revenueCoveragePercent: number;
  wooProfileMatched?: boolean;
  wooOrdersUsedForEnrichment?: number;
  businessFieldsSource?: Record<string, string>;
  creditMetaSource?: string;
  approvedCreditsFound?: number;
  availableCreditsFound?: number;
  einSource?: string;
  creditMetaVerified?: boolean;
  creditFallbackReason?: string;
  selectedCreditKey?: string;
  selectedAvailableCreditKey?: string;
  selectedOutstandingKey?: string;
  selectedEinKey?: string;
  factiivSearchQuery?: string;
  factiivMatchReason?: string;
  lastFactiivSearchQueries?: string[];
  lastFactiivSearchResultsCount?: number;
  lastFactiivMatchReason?: string;
  manualAttachedBy?: string;
  manualAttachedAt?: string;
  enrichmentSources?: string[];
  socialProfilesFound?: number;
  publicBusinessDataFound?: boolean;
  lastEnrichmentRun?: string;
  lastCustomerVerificationAt?: string;
  customerVerificationSources?: Record<string, unknown>;
  customerVerificationChangedFields?: string[];
  lastWooLiveSyncAt?: string;
  liveWooSyncOrderIds?: number[];
}

const customerOrderLineItemSchema = new Schema<CustomerOrderLineItem>(
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

const customerBillingAddressSchema = new Schema<CustomerBillingAddress>(
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

const customerOrderMetaSummarySchema = new Schema<CustomerOrderMetaSummary>(
  {
    key: { type: String, default: "" },
    value: { type: String, default: "" },
  },
  { _id: false }
);

const gatewayVerificationSchema = new Schema<GatewayVerification>(
  {
    provider: { type: String, default: "" },
    matched: { type: Boolean, default: false },
    confidence: { type: String, enum: ["exact", "high", "medium", "low", "not_found"], default: "not_found" },
    matchedBy: { type: String, default: "" },
    transactionId: { type: String, default: "" },
    transactionStatus: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    transactionDate: { type: String, default: "" },
    customerVaultId: { type: String, default: "" },
    paymentProfileId: { type: String, default: "" },
    customerProfileId: { type: String, default: "" },
    paymentIntentId: { type: String, default: "" },
    chargeId: { type: String, default: "" },
    stripeCustomerId: { type: String, default: "" },
    paymentMethodId: { type: String, default: "" },
    last4: { type: String, default: "" },
    cardType: { type: String, default: "" },
    candidatesCount: { type: Number, default: 0 },
    rawSummary: { type: String, default: "" },
    lastCheckedAt: { type: String, default: "" },
    configured: { type: Boolean, default: false },
    notes: { type: String, default: "" },
  },
  { _id: false }
);

const customerOrderHistorySchema = new Schema<CustomerOrderHistoryItem>(
  {
    orderId: { type: String, default: "" },
    orderNumber: { type: String, default: "" },
    customerId: { type: Number, default: 0 },
    status: { type: String, default: "" },
    dateCreated: { type: String, default: "" },
    dateModified: { type: String, default: "" },
    total: { type: Number, default: 0 },
    currency: { type: String, default: "" },
    paymentMethod: { type: String, default: "" },
    paymentMethodTitle: { type: String, default: "" },
    transactionId: { type: String, default: "" },
    paidDate: { type: String, default: "" },
    attemptedDate: { type: String, default: "" },
    isPaid: { type: Boolean, default: false },
    isAttempted: { type: Boolean, default: false },
    billingName: { type: String, default: "" },
    billingEmail: { type: String, default: "" },
    billingPhone: { type: String, default: "" },
    billingFirstName: { type: String, default: "" },
    billingLastName: { type: String, default: "" },
    billingCompany: { type: String, default: "" },
    billingAddress: { type: customerBillingAddressSchema, default: () => ({}) },
    lineItems: { type: [customerOrderLineItemSchema], default: [] },
    products: { type: [customerOrderLineItemSchema], default: [] },
    refundsCount: { type: Number, default: 0 },
    refundsAmount: { type: Number, default: 0 },
    metaData: { type: [customerOrderMetaSummarySchema], default: [] },
    customerNote: { type: String, default: "" },
    checkoutSource: { type: String, default: "woocommerce" },
    source: { type: String, default: "woocommerce" },
    matchedBy: { type: [String], default: [] },
    matchConfidence: { type: String, default: "" },
    gatewayVerification: { type: gatewayVerificationSchema, default: () => ({}) },
  },
  { _id: false }
);

const customerSourceCoverageSchema = new Schema<CustomerSourceCoverage>(
  {
    deepWooSearch: { type: Boolean, default: false },
    ordersStored: { type: Number, default: 0 },
    ordersStoredCount: { type: Number, default: 0 },
    matchReasonCounts: { type: Schema.Types.Mixed, default: () => ({}) },
    statusCounts: { type: Schema.Types.Mixed, default: () => ({}) },
    paymentMethodCounts: { type: Schema.Types.Mixed, default: () => ({}) },
    syncStatus: { type: String, enum: ["success", "success_with_warnings", "success_no_orders", "failed", "partial_timeout", ""], default: "" },
    lastDeepSyncAt: { type: String, default: "" },
    lastAttemptedDeepSyncAt: { type: String, default: "" },
    lastDeepSyncStatus: { type: String, enum: ["success", "success_with_warnings", "success_no_orders", "failed", "partial_timeout", ""], default: "" },
    lastSyncedAt: { type: String, default: "" },
    warningSummary: { type: String, default: "" },
    warnings: { type: [String], default: [] },
    aggregationKey: { type: String, default: "" },
    aggregationKeyType: { type: String, enum: ["email", "phone", "customerId", "company", ""], default: "" },
    lastBackfillImportAt: { type: String, default: "" },
    lastCustomerRebuildAt: { type: String, default: "" },
    wooCommerceCustomerOrdersStored: { type: Number, default: 0 },
    wooCommerceOrderRecordsFound: { type: Number, default: 0 },
    authorizeNetTransactionsFound: { type: Number, default: 0 },
    nmiQuickPayTransactionsFound: { type: Number, default: 0 },
    stripeTransactionsFound: { type: Number, default: 0 },
    lastStripeSyncAt: { type: String, default: "" },
    gatewayOnlyPaymentsAttached: { type: Number, default: 0 },
    reconciledRecords: { type: Number, default: 0 },
    missingUnattachedRecords: { type: Number, default: 0 },
    revenueCoveragePercent: { type: Number, default: 0 },
    wooProfileMatched: { type: Boolean, default: false },
    wooOrdersUsedForEnrichment: { type: Number, default: 0 },
    businessFieldsSource: { type: Schema.Types.Mixed, default: () => ({}) },
    creditMetaSource: { type: String, default: "" },
    approvedCreditsFound: { type: Number, default: 0 },
    availableCreditsFound: { type: Number, default: 0 },
    einSource: { type: String, default: "" },
    creditMetaVerified: { type: Boolean, default: false },
    creditFallbackReason: { type: String, default: "" },
    selectedCreditKey: { type: String, default: "" },
    selectedAvailableCreditKey: { type: String, default: "" },
    selectedOutstandingKey: { type: String, default: "" },
    selectedEinKey: { type: String, default: "" },
    factiivSearchQuery: { type: String, default: "" },
    factiivMatchReason: { type: String, default: "" },
    lastFactiivSearchQueries: { type: [String], default: [] },
    lastFactiivSearchResultsCount: { type: Number, default: 0 },
    lastFactiivMatchReason: { type: String, default: "" },
    manualAttachedBy: { type: String, default: "" },
    manualAttachedAt: { type: String, default: "" },
    enrichmentSources: { type: [String], default: [] },
    socialProfilesFound: { type: Number, default: 0 },
    publicBusinessDataFound: { type: Boolean, default: false },
    lastEnrichmentRun: { type: String, default: "" },
    lastCustomerVerificationAt: { type: String, default: "" },
    customerVerificationSources: { type: Schema.Types.Mixed, default: () => ({}) },
    customerVerificationChangedFields: { type: [String], default: [] },
    lastWooLiveSyncAt: { type: String, default: "" },
    liveWooSyncOrderIds: { type: [Number], default: [] },
  },
  { _id: false }
);

const customerProductJourneySchema = new Schema<CustomerProductJourneyItem>(
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

const customerGatewayPaymentSchema = new Schema<CustomerGatewayPayment>(
  {
    date: { type: String, default: "" },
    provider: { type: String, default: "" },
    transactionId: { type: String, default: "" },
    invoiceNumber: { type: String, default: "" },
    status: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    cardLast4: { type: String, default: "" },
    cardType: { type: String, default: "" },
    matchedBy: { type: String, default: "" },
    matchConfidence: { type: String, default: "" },
    source: { type: String, default: "" },
    customerProfileId: { type: String, default: "" },
    customerPaymentProfileId: { type: String, default: "" },
  },
  { _id: false }
);

const customerBusinessProfileSchema = new Schema<CustomerBusinessProfile>(
  {
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    businessName: { type: String, default: "" },
    businessNameSource: { type: String, default: "" },
    businessNameConfidence: { type: String, default: "" },
    company: { type: String, default: "" },
    dba: { type: String, default: "" },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    address1: { type: String, default: "" },
    address2: { type: String, default: "" },
    shippingAddress1: { type: String, default: "" },
    shippingAddress2: { type: String, default: "" },
    shippingCity: { type: String, default: "" },
    shippingState: { type: String, default: "" },
    shippingZip: { type: String, default: "" },
    shippingCountry: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    stateCode: { type: String, default: "" },
    stateSource: { type: String, default: "" },
    stateConfidence: { type: String, default: "" },
    enrichmentSource: { type: String, default: "" },
    zip: { type: String, default: "" },
    country: { type: String, default: "" },
    website: { type: String, default: "" },
    sourcePlatform: { type: String, default: "" },
    customerSince: { type: String, default: "" },
    lastActivity: { type: String, default: "" },
    ein: { type: String, default: "" },
    approvedCredits: { type: Number, default: 0 },
    availableCredit: { type: Number, default: 0 },
    outstandingBalance: { type: Number, default: 0 },
    creditStatus: { type: String, default: "" },
    creditMetaVerified: { type: Boolean, default: false },
    creditMetaSource: { type: String, default: "" },
    creditFallbackReason: { type: String, default: "" },
    potentialCreditLimit: { type: Number, default: 0 },
    creditLimit: { type: Number, default: 0 },
    creditLimitLastUpdated: { type: String, default: "" },
    lastBillDate: { type: String, default: "" },
    nextBillingDate: { type: String, default: "" },
    net30Status: { type: String, default: "" },
    accountStatus: { type: String, default: "" },
    businessType: { type: String, default: "" },
    industry: { type: String, default: "" },
    industryClassification: { type: String, default: "" },
    naicsCode: { type: String, default: "" },
    sicCode: { type: String, default: "" },
    fundingReadinessScore: { type: Number, default: 0 },
    fundingReadinessTier: { type: String, default: "" },
    fundingScore: { type: Number, default: 0 },
    fundingCategory: { type: String, default: "" },
    recommendedFundingProducts: { type: [String], default: [] },
    fundingStrengths: { type: [String], default: [] },
    fundingWeaknesses: { type: [String], default: [] },
    nextBestAction: { type: String, default: "" },
    fundingSummary: { type: String, default: "" },
    businessVerificationScore: { type: Number, default: 0 },
    industryRiskScore: { type: Number, default: 0 },
    fundingScoreBreakdown: { type: Schema.Types.Mixed, default: () => ({}) },
    source: { type: String, default: "" },
    importedAt: { type: String, default: "" },
  },
  { _id: false }
);

const customerCreditProfileSchema = new Schema<CustomerCreditProfile>(
  {
    approvedCredits: { type: Number, default: 0 },
    availableCredit: { type: Number, default: 0 },
    outstandingBalance: { type: Number, default: 0 },
    creditStatus: { type: String, default: "" },
    lastBillDate: { type: String, default: "" },
    nextBillingDate: { type: String, default: "" },
    sourcePostId: { type: String, default: "" },
    sourcePostType: { type: String, default: "" },
    sourceOrderId: { type: String, default: "" },
    sourceSubscriptionId: { type: String, default: "" },
    linkedUserId: { type: String, default: "" },
    linkedCustomerId: { type: String, default: "" },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    company: { type: String, default: "" },
    ein: { type: String, default: "" },
    source: { type: String, enum: ["wc_cs_credits", ""], default: "" },
    verified: { type: Boolean, default: false },
    importedAt: { type: String, default: "" },
  },
  { _id: false }
);

const customerFactiivProfileSchema = new Schema<CustomerFactiivProfile>(
  {
    profileId: { type: String, default: "" },
    factiivProfileId: { type: String, default: "" },
    score: { type: Number, default: 0 },
    businessScore: { type: Number, default: 0 },
    creditScore: { type: Number, default: 0 },
    report: { type: Schema.Types.Mixed, default: () => ({}) },
    analytics: { type: Schema.Types.Mixed, default: () => ({}) },
    funding: { type: Schema.Types.Mixed, default: () => ({}) },
    factiivScore: { type: Number, default: 0 },
    reputationScore: { type: Number, default: 0 },
    historyScore: { type: Number, default: 0 },
    utilizationScore: { type: Number, default: 0 },
    tradeQuantity: { type: Number, default: 0 },
    tradeAmountTotal: { type: Number, default: 0 },
    tradeBalanceTotal: { type: Number, default: 0 },
    activityQuantity: { type: Number, default: 0 },
    activityPaymentAmountTotal: { type: Number, default: 0 },
    activityLastKnownBalanceTotal: { type: Number, default: 0 },
    matchedBusinessName: { type: String, default: "" },
    matchedEmail: { type: String, default: "" },
    matchedUsername: { type: String, default: "" },
    factiivMatched: { type: Boolean, default: false },
    factiivMatchConfidence: { type: String, default: "" },
    matchedBy: { type: String, default: "" },
    autoPersisted: { type: Boolean, default: false },
    autoPersistReason: { type: String, default: "" },
    factiivSearchQuery: { type: String, default: "" },
    factiivMatchReason: { type: String, default: "" },
    lastFactiivSync: { type: String, default: "" },
    manualAttachedBy: { type: String, default: "" },
    manualAttachedAt: { type: String, default: "" },
    trades: {
      type: [{
        tradeId: { type: String, default: "" },
        tradeName: { type: String, default: "" },
        tradeType: { type: String, default: "" },
        relation: { type: String, default: "" },
        amount: { type: Number, default: 0 },
        balance: { type: Number, default: 0 },
        tradeStatus: { type: String, default: "" },
        adminStatus: { type: String, default: "" },
        fromCompanyName: { type: String, default: "" },
        toCompanyName: { type: String, default: "" },
        lastActivity: { type: String, default: "" },
        utilizationPercent: { type: Number, default: 0 },
      }],
      default: [],
    },
    activities: {
      type: [{
        activityDate: { type: String, default: "" },
        activityType: { type: String, default: "" },
        paymentAmount: { type: Number, default: 0 },
        chargeAmount: { type: Number, default: 0 },
        interest: { type: Number, default: 0 },
        daysLate: { type: Number, default: 0 },
        paymentStatus: { type: String, default: "" },
      }],
      default: [],
    },
    source: { type: String, default: "" },
    rawSummary: { type: String, default: "" },
  },
  { _id: false }
);

const customerPublicEnrichmentSchema = new Schema<CustomerPublicEnrichment>(
  {
    websiteDomain: { type: String, default: "" },
    linkedInCompanyUrl: { type: String, default: "" },
    facebookPageUrl: { type: String, default: "" },
    instagramUrl: { type: String, default: "" },
    twitterUrl: { type: String, default: "" },
    publicBusinessWebsite: { type: String, default: "" },
    googleBusinessProfileUrl: { type: String, default: "" },
    secretaryOfStateUrl: { type: String, default: "" },
    inferredIndustry: { type: String, default: "" },
    naicsCode: { type: String, default: "" },
    sicCode: { type: String, default: "" },
    enrichmentSources: { type: [String], default: [] },
    socialProfilesFound: { type: Number, default: 0 },
    publicBusinessDataFound: { type: Boolean, default: false },
    confidence: { type: String, default: "" },
    enrichmentStatus: { type: String, default: "" },
    lastChecked: { type: String, default: "" },
    lastEnrichmentRun: { type: String, default: "" },
  },
  { _id: false }
);

const customerSchema = new Schema<CustomerDocument>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    normalizedEmail: { type: String, default: "" },
    emailNormalized: { type: String, default: "" },
    phone: { type: String, required: true },
    phoneNormalized: { type: String, default: "" },
    totalPaid: { type: Number, required: true },
    paidTotal: { type: Number, required: true, default: 0 },
    lifetimeValue: { type: Number, default: 0, index: true },
    rankingPaidTotal: { type: Number, default: 0, index: true },
    wooPaidTotal: { type: Number, default: 0 },
    authorizeNetPaidTotal: { type: Number, default: 0 },
    gatewayOnlyPaidTotal: { type: Number, default: 0 },
    nmiQuickPayPaidTotal: { type: Number, default: 0 },
    stripePaidTotal: { type: Number, default: 0 },
    subscriptionPaidTotal: { type: Number, default: 0 },
    attemptedTotal: { type: Number, required: true, default: 0 },
    orderCount: { type: Number, required: true },
    paidOrderCount: { type: Number, required: true, default: 0 },
    gatewayPaidCount: { type: Number, default: 0 },
    attemptedOrderCount: { type: Number, required: true, default: 0 },
    paidMonths: { type: Number, default: 0 },
    firstPaidDate: { type: String, default: "" },
    subscriptionStartDate: { type: String, default: "" },
    stayWithUsMonths: { type: Number, default: 0 },
    firstOrderDate: { type: String, default: new Date(0).toISOString() },
    latestOrderDate: { type: String, default: "", index: true },
    customerCreatedAt: { type: String, default: "", index: true },
    latestCustomerCreatedAt: { type: String, default: "", index: true },
    lastOrderDate: { type: String, required: true },
    lastPaidDate: { type: String, default: "" },
    lastAttemptDate: { type: String, default: "" },
    lastOrderAmount: { type: Number, required: true },
    averageOrderValue: { type: Number, required: true },
    subscriptionStatus: { type: String, enum: ["active", "inactive", "canceled", "past_due", "unknown"], required: true },
    activeSubscriptions: { type: Number, required: true },
    isGatewayRecurring: { type: Boolean, default: false, index: true },
    recurringSource: { type: String, default: "" },
    recurringAmount: { type: Number, default: 0 },
    recurringFrequencyEstimate: { type: String, default: "" },
    recurringLastPayment: { type: String, default: "" },
    recurringNextEstimatedPayment: { type: String, default: "", index: true },
    recurringPaymentCount: { type: Number, default: 0 },
    failedPayments: { type: Number, required: true },
    refunds: { type: Number, required: true },
    chargebacks: { type: Number, required: true },
    estimatedCreditLimit: { type: Number, required: true },
    actualCreditLimit: { type: Number, default: null },
    tier: { type: String, required: true },
    leadStatus: { type: String, required: true, default: "cold_lead" },
    paymentStatus: { type: String, required: true, default: "unpaid" },
    riskLevel: { type: String, enum: ["low", "medium", "high"], required: true, default: "low" },
    tags: { type: [String], default: [] },
    notes: { type: String, default: "" },
    lastSyncedAt: { type: String, required: true },
    aiSummary: { type: String, required: true },
    aiSummaryPreview: { type: String, required: true },
    riskExplanation: { type: String, required: true },
    recommendedAction: { type: String, required: true },
    score: { type: Number, required: true, default: 0 },
    stars: { type: Number, required: true, default: 1 },
    orders: { type: [customerOrderHistorySchema], default: [] },
    lastProducts: { type: [String], default: [] },
    attemptedProducts: { type: [String], default: [] },
    paidProducts: { type: [String], default: [] },
    lastPaymentMethod: { type: String, default: "" },
    lastAttemptPaymentMethod: { type: String, default: "" },
    lastAttemptStatus: { type: String, default: "" },
    firstSignupOrderNumber: { type: String, default: "" },
    firstSignupDate: { type: String, default: "" },
    firstSignupAmount: { type: Number, default: 0 },
    firstSignupProduct: { type: String, default: "" },
    baseProductsPurchased: { type: [String], default: [] },
    boostProductsPurchased: { type: [String], default: [] },
    addOnProductsPurchased: { type: [String], default: [] },
    attemptedBaseProducts: { type: [String], default: [] },
    attemptedBoostProducts: { type: [String], default: [] },
    attemptedAddOnProducts: { type: [String], default: [] },
    lastPurchasedProduct: { type: String, default: "" },
    lastAttemptedProduct: { type: String, default: "" },
    productJourney: { type: [customerProductJourneySchema], default: [] },
    leadUrgency: { type: String, default: "medium" },
    recommendedContactMethod: { type: String, default: "email" },
    nextAction: { type: String, default: "Manual review" },
    gatewayVerification: { type: gatewayVerificationSchema, default: () => ({}) },
    gatewayPayments: { type: [customerGatewayPaymentSchema], default: [] },
    sourceCoverage: { type: customerSourceCoverageSchema, default: () => ({}) },
    businessProfile: { type: customerBusinessProfileSchema, default: () => ({}) },
    creditProfile: { type: customerCreditProfileSchema, default: () => ({}) },
    factiivProfile: { type: customerFactiivProfileSchema, default: () => ({}) },
    publicEnrichment: { type: customerPublicEnrichmentSchema, default: () => ({}) },
    externalCustomerKey: { type: String, default: "", index: true },
  },
  { timestamps: true }
);

customerSchema.pre("validate", function () {
  this.normalizedEmail = this.email?.trim().toLowerCase() ?? "";
  this.emailNormalized = this.normalizedEmail;
  this.phoneNormalized = this.phone?.replace(/\D/g, "") ?? "";
  if (this.paidTotal === undefined || this.paidTotal === null) this.paidTotal = this.totalPaid ?? 0;
  if (this.totalPaid === undefined || this.totalPaid === null) this.totalPaid = this.paidTotal ?? 0;
  const paidValue = Math.max(this.lifetimeValue ?? 0, this.rankingPaidTotal ?? 0, this.paidTotal ?? 0, this.totalPaid ?? 0);
  this.lifetimeValue = paidValue;
  this.rankingPaidTotal = paidValue;
  if (!this.firstPaidDate) this.firstPaidDate = this.lastPaidDate || this.firstOrderDate || "";
  if (!this.latestOrderDate) this.latestOrderDate = this.lastOrderDate || this.firstOrderDate || "";
  if (!this.customerCreatedAt) this.customerCreatedAt = this.firstOrderDate || "";
  if (!this.latestCustomerCreatedAt) this.latestCustomerCreatedAt = this.customerCreatedAt || "";
  if (!this.paidMonths) this.paidMonths = this.paidOrderCount ?? 0;
  if (!this.score) this.score = calculateCustomerScore(this as unknown as CustomerDocument);
  if (!this.stars) this.stars = scoreToStars(this.score);
});

customerSchema.index({ normalizedEmail: 1 });
customerSchema.index({ emailNormalized: 1 });
customerSchema.index({ phoneNormalized: 1 });
customerSchema.index({ name: 1 });
customerSchema.index({ rankingPaidTotal: -1 });
customerSchema.index({ lifetimeValue: -1 });
customerSchema.index({ lifetimeValue: -1, rankingPaidTotal: -1 });
customerSchema.index({ lastPaidDate: -1 });
customerSchema.index({ lastOrderDate: -1 });
customerSchema.index({ latestOrderDate: -1 });
customerSchema.index({ latestCustomerCreatedAt: -1 });
customerSchema.index({ "businessProfile.stateCode": 1 });
customerSchema.index({ "businessProfile.state": 1 });
customerSchema.index({ isGatewayRecurring: 1, recurringNextEstimatedPayment: 1 });
customerSchema.index({ createdAt: -1 });
customerSchema.index({ "orders.transactionId": 1 });
customerSchema.index({ "orders.orderNumber": 1 });
customerSchema.index({ "orders.billingName": 1 });
customerSchema.index({ "orders.gatewayVerification.customerProfileId": 1 });
customerSchema.index({ "gatewayPayments.transactionId": 1 });
customerSchema.index({ "gatewayPayments.invoiceNumber": 1 });
customerSchema.index({ "gatewayPayments.customerProfileId": 1 });
customerSchema.index({ "creditProfile.sourcePostId": 1 });
customerSchema.index({ "creditProfile.email": 1 });
customerSchema.index({ "creditProfile.phone": 1 });
customerSchema.index({ "creditProfile.linkedUserId": 1 });
customerSchema.index({ "creditProfile.linkedCustomerId": 1 });
customerSchema.index({ "factiivProfile.factiivMatched": 1, "factiivProfile.factiivScore": -1 });
customerSchema.index({ "factiivProfile.lastFactiivSync": -1 });
customerSchema.index({ "publicEnrichment.lastEnrichmentRun": -1 });

export const Customer = mongoose.models.Customer || mongoose.model<CustomerDocument>("Customer", customerSchema);
