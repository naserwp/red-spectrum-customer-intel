import { NextResponse } from "next/server";
import { normalizeEmail } from "@/lib/wooOrderImport";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer } from "@/models/Customer";
import { WooCommerceOrderRecord } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

type CompareCustomer = {
  orders?: Array<{ orderNumber?: string }>;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = normalizeEmail(searchParams.get("email") ?? "");
  if (!email) return NextResponse.json({ error: "email query parameter is required" }, { status: 400 });

  const connection = await connectToDatabase();
  if (!connection) return NextResponse.json({ error: "MongoDB is unavailable." }, { status: 503 });

  const [customer, wooOrders] = await Promise.all([
    Customer.findOne({ $or: [{ normalizedEmail: email }, { email }] }, { orders: 1 }).lean<CompareCustomer | null>().exec(),
    WooCommerceOrderRecord.find({ normalizedEmail: email }, { orderNumber: 1 }).sort({ dateCreated: -1 }).lean<Array<{ orderNumber?: string }>>().exec(),
  ]);

  const customerOrderNumbers = new Set((customer?.orders ?? []).map((order) => String(order.orderNumber ?? "")).filter(Boolean));
  const wooOrderNumbers = new Set(wooOrders.map((order) => String(order.orderNumber ?? "")).filter(Boolean));
  const missingOrderNumbers = Array.from(wooOrderNumbers).filter((orderNumber) => !customerOrderNumbers.has(orderNumber));
  const extraOrderNumbers = Array.from(customerOrderNumbers).filter((orderNumber) => !wooOrderNumbers.has(orderNumber));
  const mismatch = missingOrderNumbers.length > 0 || extraOrderNumbers.length > 0;

  return NextResponse.json({
    email,
    customerOrdersCount: customerOrderNumbers.size,
    wooCommerceOrderRecordsCount: wooOrderNumbers.size,
    mismatch,
    missingOrderNumbers,
    extraOrderNumbers,
    recommendation: mismatch ? "Run rebuild customers from orders" : "Customer history matches stored WooCommerce orders",
  });
}
