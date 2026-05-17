import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";
import { calculateCustomerScore, scoreToStars, type CustomerScoreInput } from "@/lib/customerScore";
import { demoCustomers } from "@/lib/demoCustomers";

type LeanCustomer = CustomerScoreInput & Record<string, unknown>;

function enrichCustomers<T extends CustomerScoreInput>(customers: T[]) {
  return customers.map((customer) => {
    const score = calculateCustomerScore(customer);
    return { ...customer, score, stars: scoreToStars(score) };
  });
}

export async function GET() {
  const fallbackCustomers = () => NextResponse.json({ customers: enrichCustomers(demoCustomers) });
  const connection = await connectToDatabase();
  if (!connection) return fallbackCustomers();

  try {
    const customers = await Customer.find({}).sort({ paidTotal: -1, attemptedTotal: -1 }).lean<LeanCustomer[]>();
    return NextResponse.json({ customers: enrichCustomers(customers) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown customer query error.";
    console.warn(`[customers] MongoDB query failed. Serving demo customer data instead. ${message}`);
    return fallbackCustomers();
  }
}
