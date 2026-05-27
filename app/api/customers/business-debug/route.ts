import { NextResponse } from "next/server";
import { collectBusinessNameFields, resolveBusinessName } from "@/lib/customerBusiness";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export async function GET(request: Request) {
  await connectToDatabase();
  const { searchParams } = new URL(request.url);
  const email = normalizeEmail(searchParams.get("email"));
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  const customer = await Customer.findOne(
    { $or: [{ normalizedEmail: email }, { emailNormalized: email }, { email }] },
    {
      name: 1,
      email: 1,
      normalizedEmail: 1,
      company: 1,
      businessProfile: 1,
      profile: 1,
      billing: 1,
      billingCompany: 1,
      billingAddress: 1,
      orders: 1,
    },
  ).lean<(CustomerDocument & { _id: unknown }) | null>();

  const wooOrders = await WooCommerceOrderRecord.find(
    { normalizedEmail: email },
    { orderNumber: 1, normalizedEmail: 1, billingCompany: 1, billing: 1, billingAddress: 1, dateCreated: 1, isPaid: 1 },
  ).sort({ isPaid: -1, dateCreated: -1 }).limit(10).lean<WooCommerceOrderDocument[]>();

  const resolved = resolveBusinessName(customer, wooOrders);
  return NextResponse.json({
    email,
    customerFound: Boolean(customer),
    customerId: customer?._id ? String(customer._id) : "",
    wooOrdersChecked: wooOrders.length,
    allCompanyFieldsFound: collectBusinessNameFields(customer, wooOrders),
    resolvedBusinessName: resolved.businessName,
    sourceUsed: resolved.businessNameSource,
  });
}
