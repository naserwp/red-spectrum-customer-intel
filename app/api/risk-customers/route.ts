import { cachedJson } from "@/lib/apiCache";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";

export async function GET() {
  await connectToDatabase();
  return cachedJson("risk-customers", async () => {
  const rows = await Customer.find({ $or: [{ failedPayments: { $gt: 1 } }, { chargebacks: { $gt: 0 } }, { riskLevel: "high" }] }).sort({ failedPayments: -1, chargebacks: -1 }).limit(50).lean();
  return {
    rows,
    failedPaymentsTotal: rows.reduce((sum, row) => sum + Number(row.failedPayments ?? 0), 0),
    failedPaymentsLast30Days: rows.filter((row) => {
      const date = new Date(String(row.lastAttemptDate || row.lastOrderDate || ""));
      return Number.isFinite(date.getTime()) && Date.now() - date.getTime() <= 30 * 86400000;
    }).reduce((sum, row) => sum + Number(row.failedPayments ?? 0), 0),
  };
  });
}
