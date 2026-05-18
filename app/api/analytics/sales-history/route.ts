import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { SalesHistory, type SalesHistoryDocument } from "@/models/SalesHistory";

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const years = Math.max(1, Math.min(10, Number(searchParams.get("years") ?? 5)));
  const history = await SalesHistory.findOne({ source: "woocommerce" }).lean<SalesHistoryDocument | null>();
  if (!history) {
    return NextResponse.json({
      source: "woocommerce",
      years,
      generatedAt: "",
      yearly: [],
      monthly: [],
      message: "No WooCommerce sales history has been generated yet. Run WooCommerce sync to build the 5-year sales status.",
    });
  }

  const minYear = new Date().getFullYear() - years + 1;
  return NextResponse.json({
    source: history.source,
    years,
    generatedAt: history.generatedAt,
    yearly: history.yearly.filter((row) => Number(row.period) >= minYear),
    monthly: history.monthly.filter((row) => Number(row.period.slice(0, 4)) >= minYear),
  });
}
