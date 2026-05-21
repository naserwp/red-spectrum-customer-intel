import { NextResponse } from "next/server";
import { calculateCustomerValueMetrics } from "@/lib/customerValue";
import { connectToDatabase } from "@/lib/mongodb";
import { buildUnifiedPaymentLedger } from "@/lib/unifiedPaymentLedger";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer } from "@/models/Customer";
import { findBestCustomerByIdOrEmail } from "@/lib/customerLookup";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFailedStatus(value: string) {
  return /declin|fail|generalerror|void|error/i.test(value);
}

function isPaidStatus(value: string) {
  return /settled|paid|completed|processing|success/i.test(value) && !isFailedStatus(value);
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function buildLiveAiSummary(name: string, paidTotal: number, paidOrderCount: number, attemptedTotal: number) {
  const aiSummary = paidTotal > 0
    ? `${name} is a paid customer with ${paidOrderCount} paid orders totaling $${paidTotal.toFixed(2)}.`
    : attemptedTotal > 0
      ? "This is a hot lead who attempted checkout but has not completed payment."
      : `${name} has not completed payment yet.`;
  return {
    aiSummary,
    aiSummaryPreview: aiSummary.slice(0, 110) + (aiSummary.length > 110 ? "..." : ""),
  };
}

function gatewayPaymentFromTransaction(transaction: AuthorizeNetTransactionDocument) {
  const source = transaction.wooOrderNumberMatched || transaction.wooOrderIdMatched ? "authorize_net_reconciled" : "authorize_net_only";
  return {
    date: transaction.settledAt || transaction.submittedAt,
    provider: "authorize_net",
    transactionId: transaction.transactionId,
    invoiceNumber: transaction.invoiceNumber,
    status: transaction.transactionStatus,
    amount: transaction.amount,
    cardLast4: transaction.cardLast4,
    cardType: transaction.cardType,
    matchedBy: transaction.matchedBy || "candidate_lookup",
    matchConfidence: transaction.matchConfidence || "medium",
    source,
    customerProfileId: transaction.customerProfileId,
    customerPaymentProfileId: transaction.customerPaymentProfileId,
  };
}

function nmiGatewayPaymentFromTransaction(transaction: NmiQuickPayTransactionDocument) {
  const source = transaction.wooOrderNumberMatched || transaction.wooOrderIdMatched ? "nmi_quick_pay_reconciled" : "nmi_quick_pay_only";
  return {
    date: transaction.settledAt || transaction.submittedAt,
    provider: "nmi",
    transactionId: transaction.transactionId,
    invoiceNumber: transaction.invoiceNumber,
    status: transaction.transactionStatus,
    amount: transaction.amount,
    cardLast4: transaction.cardLast4,
    cardType: transaction.cardType,
    matchedBy: transaction.matchedBy || "candidate_lookup",
    matchConfidence: transaction.matchConfidence || "medium",
    source,
    customerProfileId: transaction.customerVaultId,
    customerPaymentProfileId: transaction.customerPaymentProfileId,
  };
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  await connectToDatabase();
  const { id } = await params;
  const safeId = decodeURIComponent(id);
  const result = await findBestCustomerByIdOrEmail(safeId);
  if (!result.customer) {
    console.log(`[customer-detail] lookup failed id=${safeId} reason=${result.selectedDocumentReason}`);
    return NextResponse.json({ error: "Customer not found.", lookup: { id: safeId, reason: result.selectedDocumentReason } }, { status: 404 });
  }
  const customer = result.customer;
  const email = customer.normalizedEmail || customer.email?.trim().toLowerCase() || "";
  const orderNumbers = (customer.orders ?? []).map((order) => order.orderNumber).filter(Boolean).slice(0, 50);
  const profileIds = Array.from(new Set([
    customer.gatewayVerification?.customerProfileId,
    ...(customer.gatewayPayments ?? []).map((payment) => payment.customerProfileId),
    ...(customer.orders ?? []).map((order) => order.gatewayVerification?.customerProfileId),
  ].map((value) => String(value ?? "").trim()).filter(Boolean)));
  const nameParts = customer.name?.trim().split(/\s+/).filter((part) => part.length > 1) ?? [];
  const candidateConditions = [
    ...(email ? [{ normalizedEmail: email }, { emailNormalized: email }, { customerEmail: email }] : []),
    { matchedCustomerId: String(customer._id) },
    ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : []),
    ...(profileIds.length ? [{ customerProfileId: { $in: profileIds } }, { customerPaymentProfileId: { $in: profileIds } }] : []),
    ...(nameParts.length >= 2 ? [{ customerName: { $regex: `^${nameParts.map(escapeRegex).join("\\s+")}`, $options: "i" } }] : []),
  ];
  const gatewayCandidates = candidateConditions.length ? await AuthorizeNetTransaction.find({ $or: candidateConditions }, {
    transactionId: 1, transactionStatus: 1, invoiceNumber: 1, amount: 1, currency: 1, submittedAt: 1, settledAt: 1, customerEmail: 1, normalizedEmail: 1,
    customerName: 1, billingFirstName: 1, billingLastName: 1, billingCompany: 1, billingPhone: 1, cardType: 1, cardLast4: 1, customerProfileId: 1,
    customerPaymentProfileId: 1, matchedBy: 1, matchConfidence: 1, wooOrderNumberMatched: 1, wooOrderIdMatched: 1,
  }).sort({ submittedAt: -1 }).limit(100).lean<AuthorizeNetTransactionDocument[]>() : [];
  const phone = customer.phone?.replace(/\D/g, "") ?? "";
  const nmiConditions = [
    ...(email ? [{ normalizedEmail: email }, { emailNormalized: email }, { customerEmail: email }] : []),
    { matchedCustomerId: String(customer._id) },
    ...(phone.length >= 7 ? [{ normalizedPhone: phone }, { billingPhone: { $regex: phone.slice(-7), $options: "i" } }] : []),
    ...(orderNumbers.length ? [{ invoiceNumber: { $in: orderNumbers } }] : []),
    ...(profileIds.length ? [{ customerVaultId: { $in: profileIds } }, { customerPaymentProfileId: { $in: profileIds } }] : []),
    ...(nameParts.length >= 2 ? [{ customerName: { $regex: `^${nameParts.map(escapeRegex).join("\\s+")}`, $options: "i" } }] : []),
    ...(customer.businessProfile?.company ? [{ billingCompany: { $regex: escapeRegex(customer.businessProfile.company), $options: "i" } }] : []),
  ];
  const nmiCandidates = nmiConditions.length ? await NmiQuickPayTransaction.find({ $or: nmiConditions }, {
    transactionId: 1, transactionStatus: 1, invoiceNumber: 1, description: 1, amount: 1, currency: 1, submittedAt: 1, settledAt: 1, customerEmail: 1, normalizedEmail: 1,
    customerName: 1, billingFirstName: 1, billingLastName: 1, billingCompany: 1, billingPhone: 1, normalizedPhone: 1, cardType: 1, cardLast4: 1, customerVaultId: 1,
    customerPaymentProfileId: 1, matchedBy: 1, matchConfidence: 1, wooOrderNumberMatched: 1, wooOrderIdMatched: 1,
  }).sort({ submittedAt: -1 }).limit(100).lean<NmiQuickPayTransactionDocument[]>() : [];
  const existingGatewayKeys = new Set((customer.gatewayPayments ?? []).map((payment) => payment.transactionId || `${payment.invoiceNumber}-${payment.amount}-${payment.date}`));
  const mergedGatewayPayments = [
    ...(customer.gatewayPayments ?? []),
    ...gatewayCandidates
      .filter((transaction) => !existingGatewayKeys.has(transaction.transactionId))
      .map(gatewayPaymentFromTransaction),
    ...nmiCandidates
      .filter((transaction) => !existingGatewayKeys.has(transaction.transactionId))
      .map(nmiGatewayPaymentFromTransaction),
  ];
  const normalizedOrders = (customer.orders ?? []).map((order) => {
    const gatewayStatus = order.gatewayVerification?.transactionStatus || order.status;
    const derivedPaid = isPaidStatus(gatewayStatus);
    const derivedAttempted = !derivedPaid && (order.isAttempted || isFailedStatus(gatewayStatus) || /attempt|pending|hold/i.test(gatewayStatus));
    return {
      ...order,
      status: derivedPaid ? order.status : isFailedStatus(gatewayStatus) ? "failed" : derivedAttempted ? "attempted" : order.status,
      isPaid: derivedPaid ? true : order.isPaid && !isFailedStatus(gatewayStatus),
      isAttempted: derivedAttempted,
    };
  });
  const normalizedProductJourney = (customer.productJourney ?? []).map((item) => {
    const derivedPaid = isPaidStatus(item.status);
    const normalizedType: "paid" | "attempted" = derivedPaid ? "paid" : "attempted";
    const normalizedStatus = derivedPaid ? item.status : isFailedStatus(item.status) ? "failed" : item.status || "attempted";
    return {
      ...item,
      type: normalizedType,
      status: normalizedStatus,
    };
  });
  const livePaidProducts = uniqueStrings(normalizedOrders.filter((order) => order.isPaid).flatMap((order) => order.lineItems.map((item) => item.name)));
  const liveAttemptedProducts = uniqueStrings(normalizedOrders.filter((order) => order.isAttempted).flatMap((order) => order.lineItems.map((item) => item.name)));
  const metrics = calculateCustomerValueMetrics({ customer: { ...customer, orders: normalizedOrders, gatewayPayments: mergedGatewayPayments, productJourney: normalizedProductJourney }, authorizeNetTransactions: gatewayCandidates, nmiTransactions: nmiCandidates });
  const unifiedPaymentLedger = buildUnifiedPaymentLedger({ customer: { ...customer, orders: normalizedOrders, gatewayPayments: mergedGatewayPayments }, authorizeNetTransactions: gatewayCandidates, nmiTransactions: nmiCandidates });
  const liveSummary = buildLiveAiSummary(customer.name, metrics.rankingTotal || Number(customer.paidTotal ?? customer.totalPaid ?? 0), normalizedOrders.filter((order) => order.isPaid).length || Number(customer.paidOrderCount ?? 0), metrics.attemptedTotal);
  const sourceCoverage = {
    ...(customer.sourceCoverage ?? {}),
    authorizeNetTransactionsFound: Math.max(customer.sourceCoverage?.authorizeNetTransactionsFound ?? 0, gatewayCandidates.length),
    nmiQuickPayTransactionsFound: Math.max(customer.sourceCoverage?.nmiQuickPayTransactionsFound ?? 0, nmiCandidates.length),
    gatewayOnlyPaymentsAttached: Math.max(customer.sourceCoverage?.gatewayOnlyPaymentsAttached ?? 0, (customer.orders ?? []).filter((order) => order.source === "authorize_net_only" || order.source === "nmi_quick_pay_only").length),
    reconciledRecords: Math.max(customer.sourceCoverage?.reconciledRecords ?? 0, mergedGatewayPayments.length),
  };
  console.log(`[customer-detail] lookup id=${safeId} reason=${result.selectedDocumentReason} documentsWithSameEmail=${result.documentsWithSameEmail}`);
  return NextResponse.json({
    customer: {
      ...customer,
      paidTotal: metrics.rankingTotal || customer.paidTotal,
      totalPaid: metrics.rankingTotal || customer.totalPaid,
      lifetimeValue: metrics.rankingTotal || customer.lifetimeValue,
      rankingPaidTotal: metrics.rankingTotal || customer.rankingPaidTotal,
      attemptedTotal: metrics.attemptedTotal,
      firstPaidDate: metrics.firstPaidDate || customer.firstPaidDate,
      lastPaidDate: metrics.lastPaidDate || customer.lastPaidDate,
      paidMonths: metrics.paidMonths || customer.paidMonths,
      stayWithUsMonths: metrics.stayWithUsMonths || customer.stayWithUsMonths,
      wooPaidTotal: metrics.wooPaidTotal,
      authorizeNetPaidTotal: metrics.authorizeNetPaidTotal,
      gatewayOnlyPaidTotal: metrics.gatewayOnlyPaidTotal,
      nmiQuickPayPaidTotal: metrics.nmiQuickPayPaidTotal,
      subscriptionPaidTotal: metrics.subscriptionPaidTotal,
      unifiedPaymentLedger: unifiedPaymentLedger.rows,
      unifiedPaymentMetrics: unifiedPaymentLedger.metrics,
      orders: normalizedOrders,
      productJourney: normalizedProductJourney,
      gatewayPayments: mergedGatewayPayments,
      paidProducts: livePaidProducts.length ? livePaidProducts : customer.paidProducts ?? [],
      attemptedProducts: liveAttemptedProducts.length ? liveAttemptedProducts : customer.attemptedProducts ?? [],
      ...liveSummary,
      sourceCoverage,
      tags: customer.tags ?? [],
      notes: customer.notes ?? "",
    },
    lookup: { reason: result.selectedDocumentReason, documentsWithSameEmail: result.documentsWithSameEmail },
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connectToDatabase();
  const { id } = await params;
  const body = (await request.json()) as { notes?: string; tags?: string[] };
  const safeId = decodeURIComponent(id);
  const { customer } = await findBestCustomerByIdOrEmail(safeId);
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });

  const updated = await Customer.findByIdAndUpdate(
    customer._id,
    { $set: { notes: body.notes ?? "", tags: body.tags ?? [] } },
    { new: true }
  ).lean();

  if (!updated) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  return NextResponse.json({ customer: updated, message: "Customer notes updated." });
}
