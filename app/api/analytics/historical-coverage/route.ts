import { NextResponse } from "next/server";
import { isSettledSuccessful } from "@/lib/authorizeNet";
import { isNmiSuccessful } from "@/lib/nmiQuickPay";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer } from "@/models/Customer";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";
import { WooCommerceSubscriptionRecord, type WooCommerceSubscriptionDocument } from "@/models/WooCommerceSubscription";

export const dynamic = "force-dynamic";

type Gateway = "woocommerce" | "authorizeNet" | "nmi" | "subscription" | "gatewayOnly";
type YearRow = Record<Gateway, number> & {
  year: number;
  transactionCount: number;
  wooTransactionCount: number;
  authorizeNetTransactionCount: number;
  nmiTransactionCount: number;
  gatewayOnlyTransactionCount: number;
  flags: string[];
};

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function yearOf(value?: string) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getFullYear() : 0;
}

function minDate(values: string[]) {
  return values.filter(Boolean).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] ?? "";
}

function maxDate(values: string[]) {
  return values.filter(Boolean).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? "";
}

function emptyYear(year: number): YearRow {
  return {
    year,
    woocommerce: 0,
    authorizeNet: 0,
    nmi: 0,
    subscription: 0,
    gatewayOnly: 0,
    transactionCount: 0,
    wooTransactionCount: 0,
    authorizeNetTransactionCount: 0,
    nmiTransactionCount: 0,
    gatewayOnlyTransactionCount: 0,
    flags: [],
  };
}

function add(rows: Map<number, YearRow>, year: number, gateway: Gateway, amount: number, count = 1) {
  if (!year || year < 2020) return;
  const row = rows.get(year) ?? emptyYear(year);
  row[gateway] += amount;
  row.transactionCount += count;
  if (gateway === "woocommerce") row.wooTransactionCount += count;
  if (gateway === "authorizeNet") row.authorizeNetTransactionCount += count;
  if (gateway === "nmi") row.nmiTransactionCount += count;
  if (gateway === "gatewayOnly") row.gatewayOnlyTransactionCount += count;
  rows.set(year, row);
}

function addGatewayOnly(rows: Map<number, YearRow>, year: number, amount: number) {
  if (!year || year < 2020) return;
  const row = rows.get(year) ?? emptyYear(year);
  row.gatewayOnly += amount;
  row.gatewayOnlyTransactionCount += 1;
  rows.set(year, row);
}

function flagSuspiciousDrops(rows: YearRow[]) {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const previousGatewayRevenue = previous.authorizeNet + previous.nmi;
    const currentGatewayRevenue = current.authorizeNet + current.nmi;
    if (previousGatewayRevenue > 1000 && currentGatewayRevenue < previousGatewayRevenue * 0.5) {
      current.flags.push(`Suspicious gateway revenue drop from ${previous.year}.`);
    }
  }
}

export async function GET() {
  const started = Date.now();
  await connectToDatabase();
  const currentYear = new Date().getFullYear();
  const years = new Map<number, YearRow>();
  for (let year = 2020; year <= currentYear; year += 1) years.set(year, emptyYear(year));

  const [wooOrders, authorizeNetTransactions, nmiTransactions, subscriptions, customerTotals] = await Promise.all([
    WooCommerceOrderRecord.find({ isPaid: true }, { paidAmount: 1, total: 1, dateCreated: 1 }).lean<WooCommerceOrderDocument[]>(),
    AuthorizeNetTransaction.find({}, { amount: 1, transactionStatus: 1, submittedAt: 1, settledAt: 1, wooOrderNumberMatched: 1, wooOrderIdMatched: 1 }).lean<AuthorizeNetTransactionDocument[]>(),
    NmiQuickPayTransaction.find({}, { amount: 1, transactionStatus: 1, submittedAt: 1, settledAt: 1 }).lean<NmiQuickPayTransactionDocument[]>(),
    WooCommerceSubscriptionRecord.find({}, { recurringTotal: 1, amount: 1, startDate: 1, lastPaymentDate: 1 }).lean<WooCommerceSubscriptionDocument[]>(),
    Customer.aggregate<{ _id: null; lifetimeValue: number; gatewayOnlyPaidTotal: number; subscriptionPaidTotal: number }>([
      { $group: { _id: null, lifetimeValue: { $sum: { $ifNull: ["$lifetimeValue", { $ifNull: ["$rankingPaidTotal", { $ifNull: ["$paidTotal", "$totalPaid"] }] }] } }, gatewayOnlyPaidTotal: { $sum: { $ifNull: ["$gatewayOnlyPaidTotal", 0] } }, subscriptionPaidTotal: { $sum: { $ifNull: ["$subscriptionPaidTotal", 0] } } } },
    ]),
  ]);

  const gatewayOnlyAuthorizeNet = authorizeNetTransactions.filter((tx) => isSettledSuccessful(tx.transactionStatus) && !tx.wooOrderNumberMatched && !tx.wooOrderIdMatched);
  const gatewayOnlyNmi = nmiTransactions.filter((tx) => isNmiSuccessful(tx.transactionStatus) && !tx.wooOrderNumberMatched && !tx.wooOrderIdMatched);
  const gatewayOnlyRevenue = [...gatewayOnlyAuthorizeNet, ...gatewayOnlyNmi].reduce((sum, tx) => sum + money(tx.amount), 0);
  wooOrders.forEach((order) => add(years, yearOf(order.dateCreated), "woocommerce", money(order.paidAmount || order.total)));
  authorizeNetTransactions.filter((tx) => isSettledSuccessful(tx.transactionStatus)).forEach((tx) => add(years, yearOf(tx.settledAt || tx.submittedAt), "authorizeNet", money(tx.amount)));
  nmiTransactions.filter((tx) => isNmiSuccessful(tx.transactionStatus)).forEach((tx) => add(years, yearOf(tx.settledAt || tx.submittedAt), "nmi", money(tx.amount)));
  gatewayOnlyAuthorizeNet.forEach((tx) => addGatewayOnly(years, yearOf(tx.settledAt || tx.submittedAt), money(tx.amount)));
  gatewayOnlyNmi.forEach((tx) => addGatewayOnly(years, yearOf(tx.settledAt || tx.submittedAt), money(tx.amount)));
  subscriptions.forEach((sub) => add(years, yearOf(sub.lastPaymentDate || sub.startDate), "subscription", money(sub.recurringTotal || sub.amount), 0));

  const earliest = {
    woocommerce: minDate(wooOrders.map((row) => row.dateCreated)),
    authorizeNet: minDate(authorizeNetTransactions.map((row) => row.settledAt || row.submittedAt)),
    nmi: minDate(nmiTransactions.map((row) => row.settledAt || row.submittedAt)),
    subscription: minDate(subscriptions.map((row) => row.lastPaymentDate || row.startDate)),
  };
  const latest = {
    woocommerce: maxDate(wooOrders.map((row) => row.dateCreated)),
    authorizeNet: maxDate(authorizeNetTransactions.map((row) => row.settledAt || row.submittedAt)),
    nmi: maxDate(nmiTransactions.map((row) => row.settledAt || row.submittedAt)),
    subscription: maxDate(subscriptions.map((row) => row.lastPaymentDate || row.startDate)),
  };
  const yearRows = Array.from(years.values()).sort((a, b) => a.year - b.year);
  for (const row of yearRows) {
    if (row.woocommerce <= 0) row.flags.push("WooCommerce history missing or zero.");
    if (row.authorizeNet <= 0) row.flags.push("Authorize.net history missing or zero.");
    if (row.nmi <= 0) row.flags.push("NMI history missing or zero.");
    if (row.authorizeNet + row.nmi <= 0) row.flags.push("Empty gateway period.");
  }
  flagSuspiciousDrops(yearRows);
  const missingYearWarnings = yearRows.flatMap((row) => [
    row.woocommerce <= 0 ? `${row.year}: WooCommerce history missing or zero.` : "",
    row.authorizeNet <= 0 ? `${row.year}: Authorize.net history missing or zero.` : "",
    row.nmi <= 0 ? `${row.year}: NMI history missing or zero.` : "",
    row.authorizeNet + row.nmi <= 0 ? `${row.year}: Empty gateway period.` : "",
    ...row.flags.filter((flag) => /Suspicious/.test(flag)).map((flag) => `${row.year}: ${flag}`),
  ].filter(Boolean));
  return NextResponse.json({
    totals: {
      wooCommercePaidRevenue: yearRows.reduce((sum, row) => sum + row.woocommerce, 0),
      authorizeNetSettledRevenue: yearRows.reduce((sum, row) => sum + row.authorizeNet, 0),
      nmiSettledRevenue: yearRows.reduce((sum, row) => sum + row.nmi, 0),
      gatewayOnlyRevenue,
      transactionCount: yearRows.reduce((sum, row) => sum + row.transactionCount, 0),
      gatewayOnlyTransactionCount: yearRows.reduce((sum, row) => sum + row.gatewayOnlyTransactionCount, 0),
      subscriptionRecurringRevenue: yearRows.reduce((sum, row) => sum + row.subscription, 0),
      totalFinalLifetimeValueRevenue: money(customerTotals[0]?.lifetimeValue),
      storedGatewayOnlyRevenue: money(customerTotals[0]?.gatewayOnlyPaidTotal),
      storedSubscriptionRevenue: money(customerTotals[0]?.subscriptionPaidTotal),
    },
    earliestPaymentDate: earliest,
    latestPaymentDate: latest,
    byYear: yearRows,
    auditFlags: yearRows.flatMap((row) => row.flags.map((flag) => ({ year: row.year, flag }))),
    missingYearWarnings,
    warning: missingYearWarnings.length ? "Historical gateway data may be incomplete." : "",
    totalMs: Date.now() - started,
  });
}
