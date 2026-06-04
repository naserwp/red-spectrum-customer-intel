import { NextResponse } from "next/server";
import { isSettledSuccessful } from "@/lib/authorizeNet";
import { isNmiSuccessful } from "@/lib/nmiQuickPay";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer } from "@/models/Customer";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

function yearOf(value?: string) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getFullYear() : 0;
}

function incrementYear(map: Map<number, number>, year: number) {
  if (year >= 2020) map.set(year, (map.get(year) ?? 0) + 1);
}

export async function GET() {
  const started = Date.now();
  await connectToDatabase();
  const years = Array.from({ length: new Date().getFullYear() - 2020 + 1 }, (_, index) => 2020 + index);
  const [
    totalCustomers,
    customersWithFundingScore,
    customersWithState,
    customersWithBusinessName,
    wooOrders,
    authorizeNetTransactions,
    nmiTransactions,
  ] = await Promise.all([
    Customer.estimatedDocumentCount(),
    Customer.countDocuments({ "businessProfile.fundingScore": { $gt: 0 } }),
    Customer.countDocuments({
      $or: [
        { "businessProfile.stateCode": { $exists: true, $nin: ["", "-"] } },
        { "businessProfile.state": { $exists: true, $nin: ["", "-"] } },
      ],
    }),
    Customer.countDocuments({
      $or: [
        { "businessProfile.businessName": { $exists: true, $nin: ["", "-"] } },
        { "businessProfile.company": { $exists: true, $nin: ["", "-"] } },
      ],
    }),
    WooCommerceOrderRecord.find({ isPaid: true }, { dateCreated: 1 }).lean<WooCommerceOrderDocument[]>(),
    AuthorizeNetTransaction.find({}, { transactionStatus: 1, submittedAt: 1, settledAt: 1 }).lean<AuthorizeNetTransactionDocument[]>(),
    NmiQuickPayTransaction.find({}, { transactionStatus: 1, submittedAt: 1, settledAt: 1 }).lean<NmiQuickPayTransactionDocument[]>(),
  ]);

  const wooYears = new Map<number, number>();
  const authorizeNetYears = new Map<number, number>();
  const nmiYears = new Map<number, number>();
  wooOrders.forEach((order) => incrementYear(wooYears, yearOf(order.dateCreated)));
  authorizeNetTransactions.filter((tx) => isSettledSuccessful(tx.transactionStatus)).forEach((tx) => incrementYear(authorizeNetYears, yearOf(tx.settledAt || tx.submittedAt)));
  nmiTransactions.filter((tx) => isNmiSuccessful(tx.transactionStatus)).forEach((tx) => incrementYear(nmiYears, yearOf(tx.settledAt || tx.submittedAt)));
  const historicalCoverage = years.map((year) => ({
    year,
    wooTransactions: wooYears.get(year) ?? 0,
    authorizeNetTransactions: authorizeNetYears.get(year) ?? 0,
    nmiTransactions: nmiYears.get(year) ?? 0,
    complete: Boolean((wooYears.get(year) ?? 0) > 0 && (authorizeNetYears.get(year) ?? 0) > 0 && (nmiYears.get(year) ?? 0) > 0),
  }));
  const completeYears = historicalCoverage.filter((row) => row.complete).length;

  return NextResponse.json({
    totalCustomers,
    customersWithFundingScore,
    customersWithoutFundingScore: totalCustomers - customersWithFundingScore,
    customersWithState,
    customersWithoutState: totalCustomers - customersWithState,
    customersWithBusinessName,
    customersWithoutBusinessName: totalCustomers - customersWithBusinessName,
    historicalCoverage,
    historicalCoverageCompleteness: {
      completeYears,
      totalYears: years.length,
      percent: years.length ? Math.round((completeYears / years.length) * 100) : 0,
    },
    totalMs: Date.now() - started,
  });
}
