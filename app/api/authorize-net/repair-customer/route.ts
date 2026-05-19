import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { reconcileAuthorizeNetTransaction } from "@/lib/authorizeNetReconciliation";
import { connectToDatabase } from "@/lib/mongodb";
import { normalizePhone } from "@/lib/wooOrderImport";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";

export const dynamic = "force-dynamic";

type LeanCustomer = CustomerDocument & { _id: unknown };
type ManualTransaction = {
  transactionId?: string;
  invoiceNumber?: string;
  amount?: number;
  status?: string;
  transactionStatus?: string;
  submittedAt?: string;
  settledAt?: string;
  customerName?: string;
  customerEmail?: string;
  cardLast4?: string;
  cardType?: string;
  customerProfileId?: string;
  customerPaymentProfileId?: string;
  description?: string;
};

function normalizedEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function customerNameTerms(customer: LeanCustomer) {
  return customer.name.split(/\s+/).map((part) => part.trim()).filter((part) => part.length > 1);
}

function dateString(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function manualToStored(transaction: ManualTransaction, fallbackEmail: string, fallbackProfileId: string, importedAt: string) {
  const email = normalizedEmail(transaction.customerEmail || fallbackEmail);
  const settledAt = dateString(transaction.settledAt);
  const submittedAt = dateString(transaction.submittedAt) || settledAt;
  return {
    transactionId: String(transaction.transactionId ?? "").trim(),
    transactionStatus: String(transaction.transactionStatus || transaction.status || "").trim(),
    responseCode: "",
    authCode: "",
    invoiceNumber: String(transaction.invoiceNumber ?? "").trim(),
    description: String(transaction.description ?? "").trim(),
    amount: Number(transaction.amount ?? 0),
    currency: "USD",
    submittedAt,
    settledAt,
    customerEmail: email,
    normalizedEmail: email,
    emailNormalized: email,
    customerName: String(transaction.customerName ?? "").replace(/\s+/g, " ").trim(),
    billingFirstName: "",
    billingLastName: "",
    billingCompany: "",
    billingPhone: "",
    cardType: String(transaction.cardType ?? "").trim(),
    cardLast4: String(transaction.cardLast4 ?? "").replace(/\D/g, "").slice(-4),
    paymentMethod: "card",
    customerProfileId: String(transaction.customerProfileId || fallbackProfileId || "").trim(),
    customerPaymentProfileId: String(transaction.customerPaymentProfileId ?? "").trim(),
    rawSafeMeta: [{ key: "source", value: "manual_repair" }],
    importedAt,
  } satisfies Partial<AuthorizeNetTransactionDocument>;
}

async function findCustomersByBody(email: string, customerId?: string) {
  if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
    return Customer.findById(customerId).lean<LeanCustomer | null>().exec();
  }
  if (!email) return null;
  return Customer.findOne({ $or: [{ normalizedEmail: email }, { email }] }).lean<LeanCustomer | null>().exec();
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed. Use POST with email or customerId." }, { status: 405 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { email?: string; customerId?: string; customerProfileId?: string; manualTransactions?: ManualTransaction[] };
  const email = normalizedEmail(body.email);
  await connectToDatabase();

  const customer = await findCustomersByBody(email, body.customerId);
  if (!customer) {
    return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  }

  const customerEmail = customer.normalizedEmail || normalizedEmail(customer.email);
  const profileIds = Array.from(new Set([
    body.customerProfileId,
    customer.gatewayVerification?.customerProfileId,
    ...(customer.gatewayPayments ?? []).map((payment) => payment.customerProfileId),
    ...(customer.orders ?? []).map((order) => order.gatewayVerification?.customerProfileId),
  ].map((value) => String(value ?? "").trim()).filter(Boolean)));
  const fallbackProfileId = profileIds[0] ?? "";
  const importedAt = new Date().toISOString();
  const manualWarnings: string[] = [];

  for (const manual of body.manualTransactions ?? []) {
    const normalized = manualToStored(manual, customerEmail, fallbackProfileId, importedAt);
    if (!normalized.transactionId) {
      manualWarnings.push("Skipped manual transaction without transactionId.");
      continue;
    }
    await AuthorizeNetTransaction.updateOne(
      { transactionId: normalized.transactionId },
      { $set: normalized },
      { upsert: true }
    ).exec();
  }

  const paidTotalBefore = Number(customer.paidTotal ?? customer.totalPaid ?? 0);
  const gatewayPaymentsBefore = customer.gatewayPayments?.length ?? 0;
  const ordersBefore = customer.orders?.length ?? 0;
  const orderNumbers = Array.from(new Set((customer.orders ?? []).map((order) => order.orderNumber).filter(Boolean))).slice(0, 50);
  const phone = normalizePhone(customer.phone ?? "");
  const terms = customerNameTerms(customer);
  const nameRegex = terms.length >= 2 ? terms.map(escapeRegex).join(".*") : "";
  const cardLast4s = Array.from(new Set((customer.gatewayPayments ?? []).map((payment) => payment.cardLast4).filter(Boolean)));

  const [byEmail, byName, byPhone, byInvoice, byProfileId, byCardName] = await Promise.all([
    customerEmail && !customerEmail.endsWith("@woocommerce.local")
      ? AuthorizeNetTransaction.find({ $or: [{ normalizedEmail: customerEmail }, { customerEmail: { $regex: `^${escapeRegex(customerEmail)}$`, $options: "i" } }] }).sort({ submittedAt: -1 }).limit(50).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
    nameRegex
      ? AuthorizeNetTransaction.find({ customerName: { $regex: nameRegex, $options: "i" } }).sort({ submittedAt: -1 }).limit(50).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
    phone.length >= 7
      ? AuthorizeNetTransaction.find({ billingPhone: { $regex: escapeRegex(phone.slice(-7)), $options: "i" } }).sort({ submittedAt: -1 }).limit(50).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
    orderNumbers.length
      ? AuthorizeNetTransaction.find({ invoiceNumber: { $in: orderNumbers } }).sort({ submittedAt: -1 }).limit(50).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
    profileIds.length
      ? AuthorizeNetTransaction.find({ $or: [{ customerProfileId: { $in: profileIds } }, { customerPaymentProfileId: { $in: profileIds } }] }).sort({ submittedAt: -1 }).limit(50).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
    cardLast4s.length && nameRegex
      ? AuthorizeNetTransaction.find({ cardLast4: { $in: cardLast4s }, customerName: { $regex: nameRegex, $options: "i" } }).sort({ submittedAt: -1 }).limit(50).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
  ]);

  const candidateMap = new Map<string, AuthorizeNetTransactionDocument>();
  for (const transaction of [...byEmail, ...byName, ...byPhone, ...byInvoice, ...byProfileId, ...byCardName]) {
    if (transaction.transactionId && !candidateMap.has(transaction.transactionId)) candidateMap.set(transaction.transactionId, transaction);
  }
  const candidates = Array.from(candidateMap.values()).slice(0, 50);
  let addedGatewayOnlyPayments = 0;
  let verifiedWooOrders = 0;
  let skippedDuplicates = 0;
  let matched = 0;

  for (const transaction of candidates) {
    const result = await reconcileAuthorizeNetTransaction(transaction, false);
    if (!result.matched || result.customerId !== String(customer._id)) continue;
    matched += 1;
    if (result.attachedAuthorizeNetOnly) addedGatewayOnlyPayments += 1;
    if (result.verifiedWooOrder) verifiedWooOrders += 1;
    if (result.skippedDuplicate) skippedDuplicates += 1;
  }

  const updatedCustomer = await Customer.findById(customer._id).lean<LeanCustomer | null>().exec();
  const gatewayOnlyOrders = updatedCustomer?.orders?.filter((order) => order.source === "authorize_net_only").length ?? 0;
  const verifiedOrders = updatedCustomer?.orders?.filter((order) => order.gatewayVerification?.matched).length ?? 0;
  const wooStored = updatedCustomer?.orders?.filter((order) => order.source !== "authorize_net_only").length ?? 0;
  const wooFound = Number(updatedCustomer?.sourceCoverage?.wooCommerceOrderRecordsFound ?? wooStored);
  const missingRecords = Math.max(0, wooFound - wooStored);
  await Customer.updateOne(
    { _id: customer._id },
    {
      $set: {
        "sourceCoverage.authorizeNetTransactionsFound": candidates.length,
        "sourceCoverage.gatewayOnlyPaymentsAttached": gatewayOnlyOrders,
        "sourceCoverage.reconciledRecords": verifiedOrders + gatewayOnlyOrders,
        "sourceCoverage.missingUnattachedRecords": missingRecords,
      },
    }
  ).exec();

  const finalCustomer = await Customer.findById(customer._id).lean<LeanCustomer | null>().exec();
  return NextResponse.json({
    customerId: String(customer._id),
    processed: candidates.length,
    matched,
    transactionsFoundByEmail: byEmail.length,
    transactionsFoundByName: byName.length,
    transactionsFoundByPhone: byPhone.length,
    transactionsFoundByInvoice: byInvoice.length,
    transactionsFoundByProfileId: byProfileId.length,
    totalCandidateTransactions: candidates.length,
    addedGatewayOnlyPayments,
    addedPayments: addedGatewayOnlyPayments,
    verifiedWooOrders,
    skippedDuplicates,
    paidTotalBefore,
    paidTotalAfter: Number(finalCustomer?.paidTotal ?? finalCustomer?.totalPaid ?? paidTotalBefore),
    gatewayPaymentsCount: finalCustomer?.gatewayPayments?.length ?? gatewayPaymentsBefore,
    ordersCount: finalCustomer?.orders?.length ?? ordersBefore,
    warnings: manualWarnings,
    message: `Processed ${candidates.length} Authorize.net candidate transactions for ${customer.email}. Added ${addedGatewayOnlyPayments} gateway-only payments.`,
  });
}
