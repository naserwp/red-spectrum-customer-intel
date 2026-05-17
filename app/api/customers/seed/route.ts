import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";
import { demoCustomers } from "@/lib/demoCustomers";

const seedCustomers = demoCustomers.map((customer) => ({
  name: customer.name,
  email: customer.email,
  phone: customer.phone,
  totalPaid: customer.totalPaid,
  orderCount: customer.orderCount,
  firstOrderDate: customer.firstOrderDate,
  lastOrderDate: customer.lastOrderDate,
  lastOrderAmount: customer.lastOrderAmount,
  averageOrderValue: customer.averageOrderValue,
  subscriptionStatus: customer.subscriptionStatus,
  activeSubscriptions: customer.activeSubscriptions,
  failedPayments: customer.failedPayments,
  refunds: customer.refunds,
  chargebacks: customer.chargebacks,
  estimatedCreditLimit: customer.estimatedCreditLimit,
  actualCreditLimit: customer.actualCreditLimit,
  tier: customer.tier,
  riskLevel: customer.riskLevel,
  tags: customer.tags,
  notes: customer.notes,
  lastSyncedAt: customer.lastSyncedAt,
  aiSummary: customer.aiSummary,
  aiSummaryPreview: customer.aiSummaryPreview,
  riskExplanation: customer.riskExplanation,
  recommendedAction: customer.recommendedAction,
}));

export async function POST() {
  try {
    const connection = await connectToDatabase();
    if (!connection) {
      return NextResponse.json({
        message: "MongoDB is unavailable. Demo customers are already served by GET /api/customers.",
        count: demoCustomers.length,
      });
    }

    await Customer.deleteMany({});
    await Customer.insertMany(seedCustomers);

    return NextResponse.json({ message: "Demo customers seeded.", count: demoCustomers.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Seeding failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
