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
  lastOrderDate: customer.lastOrderDate,
  lastOrderAmount: customer.lastOrderAmount,
  subscriptionStatus: customer.subscriptionStatus,
  activeSubscriptions: customer.activeSubscriptions,
  failedPayments: customer.failedPayments,
  refunds: customer.refunds,
  chargebacks: customer.chargebacks,
  creditLimit: customer.creditLimit,
  tier: customer.tier,
  aiSummary: customer.aiSummary,
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
