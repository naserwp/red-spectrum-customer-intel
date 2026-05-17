import type { CustomerScoreInput } from "@/lib/customerScore";

export type DemoCustomer = CustomerScoreInput & {
  _id: string;
  name: string;
  email: string;
  phone: string;
  orderCount: number;
  firstOrderDate: string;
  lastOrderAmount: number;
  averageOrderValue: number;
  activeSubscriptions: number;
  estimatedCreditLimit: number;
  actualCreditLimit: number | null;
  tier: string;
  riskLevel: "low" | "medium" | "high";
  tags: string[];
  notes: string;
  lastSyncedAt: string;
  aiSummary: string;
  aiSummaryPreview: string;
  riskExplanation: string;
  recommendedAction: string;
};

const today = new Date();
const daysAgo = (days: number) => new Date(today.getTime() - days * 86400000).toISOString();

export const demoCustomers: DemoCustomer[] = [
  { _id: "demo-ariana-blake", name: "Ariana Blake", email: "ariana@example.com", phone: "555-0101", totalPaid: 5600, orderCount: 16, firstOrderDate: daysAgo(380), lastOrderDate: daysAgo(5), lastOrderAmount: 520, averageOrderValue: 350, subscriptionStatus: "active", activeSubscriptions: 2, failedPayments: 0, refunds: 0, chargebacks: 0, estimatedCreditLimit: 10000, actualCreditLimit: null, tier: "Platinum", riskLevel: "low", tags: ["vip"], notes: "Prefers concierge support.", lastSyncedAt: daysAgo(1), aiSummary: "Elite customer with frequent purchases and recurring subscriptions.", aiSummaryPreview: "Elite customer with frequent purchases and recurring subscriptions.", riskExplanation: "Stable account with strong payment history.", recommendedAction: "Assign VIP concierge and offer annual contract upgrade." }
];
