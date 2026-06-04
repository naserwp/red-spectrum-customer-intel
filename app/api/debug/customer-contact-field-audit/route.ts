import { NextResponse } from "next/server";
import { extractBestBusinessContactFields } from "@/lib/customerContactFields";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { CustomerRanking, type CustomerRankingDocument } from "@/models/CustomerRanking";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

export const dynamic = "force-dynamic";

type LeanCustomer = Partial<CustomerDocument> & { _id: unknown };

function clean(value: unknown) {
  const text = String(value ?? "").trim();
  return text && text !== "Missing" && text !== "-" ? text : "";
}

function normalizeEmail(value: unknown) {
  return clean(value).toLowerCase();
}

function sourceIncludes(values: Record<string, string>, source: string) {
  return Object.values(values).some((value) => value.toLowerCase().includes(source));
}

function presentCounts(customer: LeanCustomer) {
  return {
    address: Boolean(clean(customer.businessProfile?.address1)),
    city: Boolean(clean(customer.businessProfile?.city)),
    state: Boolean(clean(customer.businessProfile?.stateCode || customer.businessProfile?.state)),
    zip: Boolean(clean(customer.businessProfile?.zip)),
    phone: Boolean(clean(customer.businessProfile?.phone || customer.phone)),
    ein: Boolean(clean(customer.businessProfile?.ein || customer.creditProfile?.ein)),
    businessName: Boolean(clean(customer.businessProfile?.businessName || customer.businessProfile?.company)),
  };
}

export async function GET() {
  const started = Date.now();
  await connectToDatabase();
  const totalCustomers = await Customer.countDocuments({});
  const batchSize = 500;
  let cursor = "";
  let addressPresent = 0;
  let cityPresent = 0;
  let statePresent = 0;
  let zipPresent = 0;
  let phonePresent = 0;
  let einPresent = 0;
  let businessNamePresent = 0;
  let repairableFromWooOrders = 0;
  let repairableFromFactiivProfile = 0;
  let notRepairable = 0;
  const sampleMissing: unknown[] = [];

  while (true) {
    const query = cursor ? { _id: { $gt: cursor } } : {};
    const customers = await Customer.find(query, {
      name: 1,
      email: 1,
      normalizedEmail: 1,
      phone: 1,
      businessProfile: 1,
      creditProfile: 1,
      factiivProfile: 1,
    }).sort({ _id: 1 }).limit(batchSize).lean<LeanCustomer[]>();
    if (!customers.length) break;
    cursor = String(customers[customers.length - 1]._id);
    const emails = customers.map((customer) => normalizeEmail(customer.normalizedEmail || customer.email)).filter(Boolean);
    const [rankings, wooOrders] = await Promise.all([
      CustomerRanking.find({ email: { $in: emails } }).lean<CustomerRankingDocument[]>(),
      WooCommerceOrderRecord.find({ normalizedEmail: { $in: emails } }, {
        normalizedEmail: 1,
        billingEmail: 1,
        billingPhone: 1,
        billingCompany: 1,
        billingAddress: 1,
        rawSafeMeta: 1,
        dateCreated: 1,
        isPaid: 1,
      }).sort({ dateCreated: -1 }).lean<WooCommerceOrderDocument[]>(),
    ]);
    const rankingByEmail = new Map(rankings.map((ranking) => [normalizeEmail(ranking.email), ranking]));
    const ordersByEmail = new Map<string, WooCommerceOrderDocument[]>();
    for (const order of wooOrders) {
      const email = normalizeEmail(order.normalizedEmail || order.billingEmail);
      if (!email) continue;
      ordersByEmail.set(email, [...(ordersByEmail.get(email) ?? []), order]);
    }

    for (const customer of customers) {
      const counts = presentCounts(customer);
      if (counts.address) addressPresent += 1;
      if (counts.city) cityPresent += 1;
      if (counts.state) statePresent += 1;
      if (counts.zip) zipPresent += 1;
      if (counts.phone) phonePresent += 1;
      if (counts.ein) einPresent += 1;
      if (counts.businessName) businessNamePresent += 1;

      const missing = Object.entries(counts).filter(([, present]) => !present).map(([field]) => field);
      if (!missing.length) continue;
      const email = normalizeEmail(customer.normalizedEmail || customer.email);
      const contact = extractBestBusinessContactFields(customer, rankingByEmail.get(email), ordersByEmail.get(email) ?? []);
      const repairableFields = missing.filter((field) => {
        if (field === "address") return Boolean(contact.address1);
        if (field === "phone") return Boolean(contact.phoneNumber);
        if (field === "businessName") return Boolean(contact.businessName);
        return Boolean(contact[field as keyof typeof contact]);
      });
      if (repairableFields.length && sourceIncludes(contact.fieldSources, "woocommerce")) repairableFromWooOrders += 1;
      else if (repairableFields.length && sourceIncludes(contact.fieldSources, "factiiv")) repairableFromFactiivProfile += 1;
      else notRepairable += 1;

      if (sampleMissing.length < 20) {
        sampleMissing.push({
          customerId: String(customer._id),
          email,
          name: customer.name,
          missing,
          repairableFields,
          proposed: contact,
        });
      }
    }
    if (customers.length < batchSize) break;
  }

  return NextResponse.json({
    totalCustomers,
    addressPresent,
    addressMissing: totalCustomers - addressPresent,
    cityPresent,
    cityMissing: totalCustomers - cityPresent,
    statePresent,
    stateMissing: totalCustomers - statePresent,
    zipPresent,
    zipMissing: totalCustomers - zipPresent,
    phonePresent,
    phoneMissing: totalCustomers - phonePresent,
    einPresent,
    einMissing: totalCustomers - einPresent,
    businessNamePresent,
    businessNameMissing: totalCustomers - businessNamePresent,
    repairableFromWooOrders,
    repairableFromFactiivProfile,
    notRepairable,
    sampleMissing,
    totalMs: Date.now() - started,
  });
}
