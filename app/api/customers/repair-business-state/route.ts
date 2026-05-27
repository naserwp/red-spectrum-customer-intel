import { NextResponse } from "next/server";
import { resolveCustomerBusinessName, resolveCustomerState } from "@/lib/customerBusinessResolver";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking } from "@/models/CustomerRanking";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

function normalizedEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

async function latestWooOrdersByEmail(emails: string[]) {
  const normalizedEmails = Array.from(new Set(emails.map(normalizedEmail).filter(Boolean)));
  if (!normalizedEmails.length) return new Map<string, WooCommerceOrderDocument>();
  const orders = await WooCommerceOrderRecord.find(
    { normalizedEmail: { $in: normalizedEmails } },
    { normalizedEmail: 1, billingCompany: 1, billingState: 1, billing: 1, billingAddress: 1, dateCreated: 1, isPaid: 1 },
  ).sort({ isPaid: -1, dateCreated: -1 }).limit(Math.min(5000, normalizedEmails.length * 5)).lean<WooCommerceOrderDocument[]>();
  const byEmail = new Map<string, WooCommerceOrderDocument>();
  for (const order of orders) {
    const email = normalizedEmail(order.normalizedEmail);
    if (email && !byEmail.has(email)) byEmail.set(email, order);
  }
  return byEmail;
}

export async function POST(request: Request) {
  await connectToDatabase();
  const body = await request.json().catch(() => ({})) as { email?: string; limit?: number; offset?: number };
  const email = normalizedEmail(body.email);
  const limit = Math.min(500, Math.max(1, Math.floor(Number(body.limit ?? 100))));
  const offset = Math.max(0, Math.floor(Number(body.offset ?? 0)));
  const query = email ? { $or: [{ normalizedEmail: email }, { emailNormalized: email }, { email }] } : {};
  const customers = await Customer.find(query, {
    name: 1,
    email: 1,
    normalizedEmail: 1,
    businessProfile: 1,
    profile: 1,
    company: 1,
    billing: 1,
    billingCompany: 1,
    billingAddress: 1,
    billingState: 1,
    address: 1,
    state: 1,
    orders: 1,
  }).sort({ updatedAt: -1 }).skip(email ? 0 : offset).limit(email ? 1 : limit).lean<Array<CustomerDocument & { _id: unknown }>>();

  const lookupEmails = email
    ? [email, ...customers.map((customer) => customer.normalizedEmail || customer.email || "")]
    : customers.map((customer) => customer.normalizedEmail || customer.email || "");
  const latestOrders = await latestWooOrdersByEmail(lookupEmails);
  let repaired = 0;
  const rows = [];
  for (const customer of customers) {
    const customerEmail = normalizedEmail(customer.normalizedEmail || customer.email);
    const latestWooOrder = latestOrders.get(customerEmail) || latestOrders.get(email);
    const resolverInput = latestWooOrder ? { ...customer, latestWooOrder } : customer;
    const business = resolveCustomerBusinessName(resolverInput);
    const state = resolveCustomerState(resolverInput);
    console.log("[business-resolver]", customerEmail || email, business.businessName, state.stateCode);
    const set: Record<string, unknown> = {};
    if (business.businessName) {
      set["businessProfile.businessName"] = business.businessName;
      set["businessProfile.company"] = business.businessName;
      set["businessProfile.businessNameSource"] = business.businessNameSource;
      set["sourceCoverage.businessNameSource"] = business.businessNameSource;
    }
    if (state.stateCode) {
      set["businessProfile.state"] = state.stateCode;
      set["businessProfile.stateCode"] = state.stateCode;
      set["businessProfile.stateSource"] = state.stateSource;
      set["sourceCoverage.stateSource"] = state.stateSource;
    }
    if (Object.keys(set).length) {
      await Customer.updateOne({ _id: customer._id }, { $set: set }).exec();
      await CustomerRanking.updateOne(
        { customerId: String(customer._id) },
        {
          $set: {
            businessName: business.businessName,
            businessNameSource: business.businessNameSource,
            stateCode: state.stateCode,
            stateName: state.stateName,
            stateSource: state.stateSource,
          },
        },
      ).exec();
      repaired += 1;
    }
    rows.push({
      customerId: String(customer._id),
      email: customer.email,
      businessName: business.businessName,
      businessNameSource: business.businessNameSource,
      stateCode: state.stateCode,
      stateName: state.stateName,
      stateSource: state.stateSource,
      repaired: Object.keys(set).length > 0,
    });
  }

  return NextResponse.json({
    ok: true,
    requestedEmail: email,
    businessName: rows[0]?.businessName ?? "",
    stateCode: rows[0]?.stateCode ?? "",
    repaired: rows.some((row) => row.repaired),
    limit,
    offset,
    processed: customers.length,
    repairedCount: repaired,
    rows,
  });
}
