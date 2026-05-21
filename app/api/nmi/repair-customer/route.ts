import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { reconcileNmiTransaction } from "@/lib/nmiReconciliation";
import { normalizeNmiPhone } from "@/lib/nmiQuickPay";
import { connectToDatabase } from "@/lib/mongodb";
import { Customer, type CustomerDocument } from "@/models/Customer";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";

export const dynamic = "force-dynamic";

type LeanCustomer = CustomerDocument & { _id: unknown };

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findCustomer(email: string, customerId?: string) {
  if (customerId && mongoose.Types.ObjectId.isValid(customerId)) return Customer.findById(customerId).lean<LeanCustomer | null>();
  if (!email) return null;
  return Customer.findOne({ $or: [{ normalizedEmail: email }, { emailNormalized: email }, { email }] }).lean<LeanCustomer | null>();
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed. Use POST with email or customerId." }, { status: 405 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { email?: string; customerId?: string };
  const email = normalizeEmail(body.email);
  await connectToDatabase();
  const customer = await findCustomer(email, body.customerId);
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });

  const customerEmail = customer.normalizedEmail || normalizeEmail(customer.email);
  const phone = normalizeNmiPhone(customer.phone ?? "");
  const orderNumbers = Array.from(new Set((customer.orders ?? []).map((order) => order.orderNumber).filter(Boolean))).slice(0, 50);
  const nameParts = customer.name.split(/\s+/).filter((part) => part.length > 1);
  const nameRegex = nameParts.length >= 2 ? nameParts.map(escapeRegex).join(".*") : "";
  const company = customer.businessProfile?.company || customer.orders?.find((order) => order.billingCompany)?.billingCompany || "";
  const cardLast4s = Array.from(new Set((customer.gatewayPayments ?? []).map((payment) => payment.cardLast4).filter(Boolean)));

  const [byEmail, byPhone, byInvoice, byName, byCompany, byCard] = await Promise.all([
    customerEmail && !customerEmail.endsWith("@woocommerce.local")
      ? NmiQuickPayTransaction.find({ $or: [{ normalizedEmail: customerEmail }, { emailNormalized: customerEmail }, { customerEmail }] }).sort({ submittedAt: -1 }).limit(50).lean<NmiQuickPayTransactionDocument[]>()
      : Promise.resolve([]),
    phone.length >= 7
      ? NmiQuickPayTransaction.find({ $or: [{ normalizedPhone: phone }, { billingPhone: { $regex: escapeRegex(phone.slice(-7)), $options: "i" } }] }).sort({ submittedAt: -1 }).limit(50).lean<NmiQuickPayTransactionDocument[]>()
      : Promise.resolve([]),
    orderNumbers.length
      ? NmiQuickPayTransaction.find({ invoiceNumber: { $in: orderNumbers } }).sort({ submittedAt: -1 }).limit(50).lean<NmiQuickPayTransactionDocument[]>()
      : Promise.resolve([]),
    nameRegex
      ? NmiQuickPayTransaction.find({ customerName: { $regex: nameRegex, $options: "i" } }).sort({ submittedAt: -1 }).limit(50).lean<NmiQuickPayTransactionDocument[]>()
      : Promise.resolve([]),
    company
      ? NmiQuickPayTransaction.find({ billingCompany: { $regex: escapeRegex(company), $options: "i" } }).sort({ submittedAt: -1 }).limit(50).lean<NmiQuickPayTransactionDocument[]>()
      : Promise.resolve([]),
    cardLast4s.length
      ? NmiQuickPayTransaction.find({ cardLast4: { $in: cardLast4s } }).sort({ submittedAt: -1 }).limit(50).lean<NmiQuickPayTransactionDocument[]>()
      : Promise.resolve([]),
  ]);

  const candidateMap = new Map<string, NmiQuickPayTransactionDocument>();
  for (const transaction of [...byEmail, ...byPhone, ...byInvoice, ...byName, ...byCompany, ...byCard]) {
    if (transaction.transactionId && !candidateMap.has(transaction.transactionId)) candidateMap.set(transaction.transactionId, transaction);
  }
  const candidates = Array.from(candidateMap.values()).slice(0, 50);
  const paidTotalBefore = Number(customer.paidTotal ?? customer.totalPaid ?? 0);
  let matched = 0;
  let addedGatewayOnlyPayments = 0;
  let verifiedWooOrders = 0;
  let skippedDuplicates = 0;

  for (const transaction of candidates) {
    const result = await reconcileNmiTransaction(transaction, false);
    if (!result.matched || result.customerId !== String(customer._id)) continue;
    matched += 1;
    if (result.attachedGatewayOnly) addedGatewayOnlyPayments += 1;
    if (result.verifiedWooOrder) verifiedWooOrders += 1;
    if (result.skippedDuplicate) skippedDuplicates += 1;
  }

  const finalCustomer = await Customer.findById(customer._id).lean<LeanCustomer | null>();
  return NextResponse.json({
    customerId: String(customer._id),
    processed: candidates.length,
    matched,
    transactionsFoundByEmail: byEmail.length,
    transactionsFoundByPhone: byPhone.length,
    transactionsFoundByInvoice: byInvoice.length,
    transactionsFoundByName: byName.length,
    transactionsFoundByCompany: byCompany.length,
    transactionsFoundByCard: byCard.length,
    totalCandidateTransactions: candidates.length,
    addedGatewayOnlyPayments,
    verifiedWooOrders,
    skippedDuplicates,
    paidTotalBefore,
    paidTotalAfter: Number(finalCustomer?.paidTotal ?? finalCustomer?.totalPaid ?? paidTotalBefore),
    gatewayPaymentsCount: finalCustomer?.gatewayPayments?.length ?? customer.gatewayPayments?.length ?? 0,
    ordersCount: finalCustomer?.orders?.length ?? customer.orders?.length ?? 0,
    message: `Processed ${candidates.length} NMI Quick Pay candidate transactions for ${customer.email}. Added ${addedGatewayOnlyPayments} gateway-only payments.`,
  });
}
