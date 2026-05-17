import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";

export async function GET() {
  try {
    await connectToDatabase();
    const customers = await Customer.find({}).lean();

    const enriched = customers.map((customer) => {
      const scoreInput: CustomerScoreInput = {
        totalPaid: customer.totalPaid,
        subscriptionStatus: customer.subscriptionStatus,
        lastOrderDate: customer.lastOrderDate,
        refunds: customer.refunds,
        chargebacks: customer.chargebacks,
        failedPayments: customer.failedPayments,
      };
      const score = calculateCustomerScore(scoreInput);
      return { ...customer, score, stars: scoreToStars(score) };
    });

    return NextResponse.json({ customers: enriched });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch customers.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
