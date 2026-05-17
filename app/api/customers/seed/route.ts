import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

const today = new Date();
const daysAgo = (days: number) => new Date(today.getTime() - days * 86400000).toISOString();

const demoCustomers = [
  { name: "Ariana Blake", email: "ariana@example.com", phone: "555-0101", totalPaid: 5600, orderCount: 16, lastOrderDate: daysAgo(5), lastOrderAmount: 520, subscriptionStatus: "active", activeSubscriptions: 2, failedPayments: 0, refunds: 0, chargebacks: 0, creditLimit: 10000, tier: "Platinum", aiSummary: "Elite customer with frequent purchases and recurring subscriptions.", recommendedAction: "Assign VIP concierge and offer annual contract upgrade." },
  { name: "Brandon Lee", email: "brandon@example.com", phone: "555-0102", totalPaid: 1800, orderCount: 9, lastOrderDate: daysAgo(32), lastOrderAmount: 240, subscriptionStatus: "active", activeSubscriptions: 1, failedPayments: 0, refunds: 0, chargebacks: 0, creditLimit: 6500, tier: "Gold", aiSummary: "Strong loyalty pattern and healthy average order value.", recommendedAction: "Promote bundled upsell and loyalty points bonus." },
  { name: "Cynthia Ruiz", email: "cynthia@example.com", phone: "555-0103", totalPaid: 620, orderCount: 5, lastOrderDate: daysAgo(74), lastOrderAmount: 120, subscriptionStatus: "inactive", activeSubscriptions: 0, failedPayments: 1, refunds: 0, chargebacks: 0, creditLimit: 2200, tier: "Silver", aiSummary: "Moderate customer with room to reactivate engagement.", recommendedAction: "Send targeted reactivation campaign with limited-time incentive." },
  { name: "Darren Cole", email: "darren@example.com", phone: "555-0104", totalPaid: 180, orderCount: 2, lastOrderDate: daysAgo(170), lastOrderAmount: 80, subscriptionStatus: "canceled", activeSubscriptions: 0, failedPayments: 1, refunds: 0, chargebacks: 0, creditLimit: 1200, tier: "Bronze", aiSummary: "Low activity and long gap since last order.", recommendedAction: "Schedule win-back sequence with entry-level plan offer." },
  { name: "Elena Morse", email: "elena@example.com", phone: "555-0105", totalPaid: 130, orderCount: 3, lastOrderDate: daysAgo(18), lastOrderAmount: 49, subscriptionStatus: "past_due", activeSubscriptions: 0, failedPayments: 2, refunds: 1, chargebacks: 1, creditLimit: 800, tier: "Risk", aiSummary: "High-risk account due to chargeback and payment instability.", recommendedAction: "Place account on manual review and require payment verification." },
];

export async function POST() {
  try {
    await connectToDatabase();
    await Customer.deleteMany({});
    await Customer.insertMany(demoCustomers);

    return NextResponse.json({ message: "Demo customers seeded.", count: demoCustomers.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Seeding failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
