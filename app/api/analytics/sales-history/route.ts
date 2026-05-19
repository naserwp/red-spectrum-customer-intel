import { cachedJson } from "@/lib/apiCache";
import { connectToDatabase } from "@/lib/mongodb";
import { AuthorizeNetTransaction } from "@/models/AuthorizeNetTransaction";
import { SalesHistory, type SalesHistoryDocument } from "@/models/SalesHistory";
import type { SalesPeriodMetricDocument } from "@/models/SalesHistory";

function emptyMetric(period: string): SalesPeriodMetricDocument {
  return {
    period,
    paidRevenue: 0,
    attemptedPipeline: 0,
    paidOrders: 0,
    attemptedOrders: 0,
    failedPayments: 0,
    refunds: 0,
    chargebacks: 0,
    newPaidCustomers: 0,
    newLeads: 0,
    averageOrderValue: 0,
  };
}

function applyAuthorizeNetOnlyPaid(rows: SalesPeriodMetricDocument[], period: string, amount: number, paidOrders = 1) {
  let row = rows.find((item) => item.period === period);
  if (!row) {
    row = emptyMetric(period);
    rows.push(row);
  }
  row.paidRevenue += amount;
  row.paidOrders += paidOrders;
  row.averageOrderValue = row.paidOrders > 0 ? row.paidRevenue / row.paidOrders : 0;
}

type AuthorizeNetSalesMetric = {
  _id: string;
  paidRevenue: number;
  paidOrders: number;
};

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const years = Math.max(1, Math.min(10, Number(searchParams.get("years") ?? 5)));
  return cachedJson(`sales-history:${years}`, async () => {
  const minYear = new Date().getFullYear() - years + 1;
  const history = await SalesHistory.findOne({ source: "woocommerce" }).lean<SalesHistoryDocument | null>();
  const minDate = `${minYear}-01-01`;
  const [authorizeYearly, authorizeMonthly] = await Promise.all([
    AuthorizeNetTransaction.aggregate<AuthorizeNetSalesMetric>([
      { $addFields: { authDate: { $cond: [{ $ne: ["$settledAt", ""] }, "$settledAt", "$submittedAt"] } } },
      { $match: { transactionStatus: { $regex: "settled|captured", $options: "i" }, authDate: { $gte: minDate }, $or: [{ wooOrderNumberMatched: "" }, { wooOrderNumberMatched: { $exists: false } }], $and: [{ $or: [{ wooOrderIdMatched: 0 }, { wooOrderIdMatched: { $exists: false } }] }] } },
      { $group: { _id: { $substr: ["$authDate", 0, 4] }, paidRevenue: { $sum: "$amount" }, paidOrders: { $sum: 1 } } },
    ]),
    AuthorizeNetTransaction.aggregate<AuthorizeNetSalesMetric>([
      { $addFields: { authDate: { $cond: [{ $ne: ["$settledAt", ""] }, "$settledAt", "$submittedAt"] } } },
      { $match: { transactionStatus: { $regex: "settled|captured", $options: "i" }, authDate: { $gte: minDate }, $or: [{ wooOrderNumberMatched: "" }, { wooOrderNumberMatched: { $exists: false } }], $and: [{ $or: [{ wooOrderIdMatched: 0 }, { wooOrderIdMatched: { $exists: false } }] }] } },
      { $group: { _id: { $substr: ["$authDate", 0, 7] }, paidRevenue: { $sum: "$amount" }, paidOrders: { $sum: 1 } } },
    ]),
  ]);
  const yearly = history?.yearly.filter((row) => Number(row.period) >= minYear).map((row) => ({ ...row })) ?? [];
  const monthly = history?.monthly.filter((row) => Number(row.period.slice(0, 4)) >= minYear).map((row) => ({ ...row })) ?? [];
  for (const row of authorizeYearly) applyAuthorizeNetOnlyPaid(yearly, row._id, Number(row.paidRevenue ?? 0), Number(row.paidOrders ?? 0));
  for (const row of authorizeMonthly) applyAuthorizeNetOnlyPaid(monthly, row._id, Number(row.paidRevenue ?? 0), Number(row.paidOrders ?? 0));
  yearly.sort((a, b) => a.period.localeCompare(b.period));
  monthly.sort((a, b) => a.period.localeCompare(b.period));
  return {
    source: history?.source ?? "woocommerce",
    years,
    generatedAt: history?.generatedAt ?? "",
    yearly,
    monthly,
    message: history ? "" : "No WooCommerce sales history has been generated yet. Showing reconciled Authorize.net-only payments where available.",
  };
  });
}
