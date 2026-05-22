import { NextResponse } from "next/server";
import { calculateCustomerValueMetrics } from "@/lib/customerValue";
import { connectToDatabase } from "@/lib/mongodb";
import { buildUnifiedPaymentLedger } from "@/lib/unifiedPaymentLedger";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer } from "@/models/Customer";
import { findBestCustomerByIdOrEmail } from "@/lib/customerLookup";
import { NmiQuickPayTransaction, type NmiQuickPayTransactionDocument } from "@/models/NmiQuickPayTransaction";
import { WooCommerceOrderRecord, type WooCommerceOrderDocument } from "@/models/WooCommerceOrder";

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

function hasText(value: unknown) {
  return String(value ?? "").trim().length > 0;
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function metaValue(metaRows: Array<{ key?: string; value?: string }> | undefined, keys: string[]) {
  const rows = Array.isArray(metaRows) ? metaRows : [];
  for (const key of keys) {
    const found = rows.find((row) => String(row?.key ?? "").trim().toLowerCase() === key.toLowerCase());
    if (hasText(found?.value)) return String(found?.value).trim();
  }
  return "";
}

function pickBusinessValue(
  field: string,
  candidates: Array<{ value: unknown; source: string }>
) {
  const match = candidates.find((candidate) => {
    if (typeof candidate.value === "number") return Number.isFinite(candidate.value) && candidate.value > 0;
    return hasText(candidate.value);
  });
  return {
    value: match?.value ?? "",
    source: match?.source ?? "",
    field,
  };
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
  const knownInvoiceNumbers = uniqueStrings([
    ...orderNumbers,
    ...gatewayCandidates.map((transaction) => transaction.invoiceNumber),
    ...nmiCandidates.map((transaction) => transaction.invoiceNumber),
  ]);
  const normalizedCustomerName = normalizeName(customer.name ?? "");
  const wooConditions = [
    ...(email ? [{ normalizedEmail: email }] : []),
    ...(phone.length >= 7 ? [{ normalizedPhone: phone }, { billingPhone: { $regex: phone.slice(-7), $options: "i" } }] : []),
    ...(knownInvoiceNumbers.length ? [{ orderNumber: { $in: knownInvoiceNumbers } }] : []),
    ...(normalizedCustomerName ? [{ billingName: { $regex: `^${nameParts.map(escapeRegex).join("\\s+")}`, $options: "i" } }] : []),
    ...(customer.businessProfile?.company ? [{ billingCompany: { $regex: escapeRegex(customer.businessProfile.company), $options: "i" } }] : []),
    ...(gatewayCandidates.map((transaction) => transaction.billingCompany).filter(Boolean).length ? [{
      billingCompany: { $in: gatewayCandidates.map((transaction) => String(transaction.billingCompany ?? "").trim()).filter(Boolean) },
    }] : []),
  ];
  const wooOrderCandidates = wooConditions.length ? await WooCommerceOrderRecord.find({ $or: wooConditions }, {
    orderNumber: 1,
    customerId: 1,
    billingFirstName: 1,
    billingLastName: 1,
    billingName: 1,
    billingEmail: 1,
    normalizedEmail: 1,
    billingPhone: 1,
    normalizedPhone: 1,
    billingCompany: 1,
    billingAddress: 1,
    rawSafeMeta: 1,
    dateCreated: 1,
  }).sort({ dateCreated: -1 }).limit(50).lean<WooCommerceOrderDocument[]>() : [];
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
  const latestWooOrderWithBusinessData = wooOrderCandidates.find((order) =>
    hasText(order.billingCompany) ||
    hasText(order.billingAddress?.address1) ||
    hasText(order.billingAddress?.city) ||
    hasText(metaValue(order.rawSafeMeta, ["ein", "dba", "doing_business_as", "website", "business_website", "shipping_address_1", "shipping_city", "shipping_state", "shipping_postcode", "shipping_country"]))
  );
  const latestStoredOrderWithBusinessData = normalizedOrders.find((order) =>
    hasText(order.billingCompany) || hasText(order.billingAddress?.address1) || hasText(order.billingAddress?.city) ||
    hasText(metaValue(order.metaData, ["ein", "dba", "doing_business_as", "website", "business_website"]))
  );
  const latestAuthorizeNetBusiness = gatewayCandidates.find((transaction) =>
    hasText(transaction.billingCompany) || hasText(transaction.billingPhone) || hasText(transaction.customerEmail)
  );
  const businessProfileSources: Record<string, string> = {};
  const resolvedBusinessName = pickBusinessValue("company", [
    { value: customer.businessProfile?.company, source: customer.businessProfile?.source || "customer" },
    { value: latestWooOrderWithBusinessData?.billingCompany, source: "woocommerce" },
    { value: latestStoredOrderWithBusinessData?.billingCompany, source: "customer" },
    { value: latestAuthorizeNetBusiness?.billingCompany, source: "authorize_net" },
    { value: customer.name, source: "customer" },
  ]);
  const resolvedDba = pickBusinessValue("dba", [
    { value: customer.businessProfile?.dba, source: customer.businessProfile?.source || "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["dba", "doing_business_as"]), source: "woocommerce" },
    { value: metaValue(latestStoredOrderWithBusinessData?.metaData, ["dba", "doing_business_as"]), source: "customer" },
  ]);
  const resolvedEin = pickBusinessValue("ein", [
    { value: customer.businessProfile?.ein, source: customer.businessProfile?.source || "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["ein"]), source: "woocommerce" },
    { value: metaValue(latestStoredOrderWithBusinessData?.metaData, ["ein"]), source: "customer" },
  ]);
  const resolvedPhone = pickBusinessValue("phone", [
    { value: customer.businessProfile?.phone, source: customer.businessProfile?.source || "customer" },
    { value: latestWooOrderWithBusinessData?.billingPhone, source: "woocommerce" },
    { value: latestStoredOrderWithBusinessData?.billingPhone, source: "customer" },
    { value: latestAuthorizeNetBusiness?.billingPhone, source: "authorize_net" },
    { value: customer.phone, source: "customer" },
  ]);
  const resolvedEmail = pickBusinessValue("email", [
    { value: customer.businessProfile?.email, source: customer.businessProfile?.source || "customer" },
    { value: latestWooOrderWithBusinessData?.billingEmail, source: "woocommerce" },
    { value: latestStoredOrderWithBusinessData?.billingEmail, source: "customer" },
    { value: latestAuthorizeNetBusiness?.customerEmail, source: "authorize_net" },
    { value: customer.email, source: "customer" },
  ]);
  const resolvedAddress1 = pickBusinessValue("address1", [
    { value: customer.businessProfile?.address1, source: customer.businessProfile?.source || "customer" },
    { value: latestWooOrderWithBusinessData?.billingAddress?.address1, source: "woocommerce" },
    { value: latestStoredOrderWithBusinessData?.billingAddress?.address1, source: "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["billing_address_1", "business_address"]), source: "woocommerce" },
  ]);
  const resolvedAddress2 = pickBusinessValue("address2", [
    { value: customer.businessProfile?.address2, source: customer.businessProfile?.source || "customer" },
    { value: latestWooOrderWithBusinessData?.billingAddress?.address2, source: "woocommerce" },
    { value: latestStoredOrderWithBusinessData?.billingAddress?.address2, source: "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["billing_address_2"]), source: "woocommerce" },
  ]);
  const resolvedCity = pickBusinessValue("city", [
    { value: customer.businessProfile?.city, source: customer.businessProfile?.source || "customer" },
    { value: latestWooOrderWithBusinessData?.billingAddress?.city, source: "woocommerce" },
    { value: latestStoredOrderWithBusinessData?.billingAddress?.city, source: "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["billing_city"]), source: "woocommerce" },
  ]);
  const resolvedState = pickBusinessValue("state", [
    { value: customer.businessProfile?.state, source: customer.businessProfile?.source || "customer" },
    { value: latestWooOrderWithBusinessData?.billingAddress?.state, source: "woocommerce" },
    { value: latestStoredOrderWithBusinessData?.billingAddress?.state, source: "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["billing_state"]), source: "woocommerce" },
  ]);
  const resolvedZip = pickBusinessValue("zip", [
    { value: customer.businessProfile?.zip, source: customer.businessProfile?.source || "customer" },
    { value: latestWooOrderWithBusinessData?.billingAddress?.postcode, source: "woocommerce" },
    { value: latestStoredOrderWithBusinessData?.billingAddress?.postcode, source: "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["billing_postcode"]), source: "woocommerce" },
  ]);
  const resolvedCountry = pickBusinessValue("country", [
    { value: customer.businessProfile?.country, source: customer.businessProfile?.source || "customer" },
    { value: latestWooOrderWithBusinessData?.billingAddress?.country, source: "woocommerce" },
    { value: latestStoredOrderWithBusinessData?.billingAddress?.country, source: "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["billing_country"]), source: "woocommerce" },
  ]);
  const resolvedWebsite = pickBusinessValue("website", [
    { value: customer.businessProfile?.website, source: customer.businessProfile?.source || "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["website", "business_website"]), source: "woocommerce" },
    { value: metaValue(latestStoredOrderWithBusinessData?.metaData, ["website", "business_website"]), source: "customer" },
  ]);
  const resolvedShippingAddress1 = pickBusinessValue("shippingAddress1", [
    { value: customer.businessProfile?.shippingAddress1, source: customer.businessProfile?.source || "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["shipping_address_1"]), source: "woocommerce" },
  ]);
  const resolvedShippingAddress2 = pickBusinessValue("shippingAddress2", [
    { value: customer.businessProfile?.shippingAddress2, source: customer.businessProfile?.source || "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["shipping_address_2"]), source: "woocommerce" },
  ]);
  const resolvedShippingCity = pickBusinessValue("shippingCity", [
    { value: customer.businessProfile?.shippingCity, source: customer.businessProfile?.source || "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["shipping_city"]), source: "woocommerce" },
  ]);
  const resolvedShippingState = pickBusinessValue("shippingState", [
    { value: customer.businessProfile?.shippingState, source: customer.businessProfile?.source || "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["shipping_state"]), source: "woocommerce" },
  ]);
  const resolvedShippingZip = pickBusinessValue("shippingZip", [
    { value: customer.businessProfile?.shippingZip, source: customer.businessProfile?.source || "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["shipping_postcode"]), source: "woocommerce" },
  ]);
  const resolvedShippingCountry = pickBusinessValue("shippingCountry", [
    { value: customer.businessProfile?.shippingCountry, source: customer.businessProfile?.source || "customer" },
    { value: metaValue(latestWooOrderWithBusinessData?.rawSafeMeta, ["shipping_country"]), source: "woocommerce" },
  ]);
  const resolvedCreditStatus = pickBusinessValue("creditStatus", [
    { value: customer.businessProfile?.creditStatus, source: customer.businessProfile?.source || "customer" },
    { value: customer.businessProfile?.net30Status, source: customer.businessProfile?.source || "customer" },
    { value: customer.businessProfile?.accountStatus, source: customer.businessProfile?.source || "customer" },
  ]);
  const resolvedLastBillDate = pickBusinessValue("lastBillDate", [
    { value: customer.businessProfile?.lastBillDate, source: customer.businessProfile?.source || "customer" },
  ]);
  const resolvedNextBillingDate = pickBusinessValue("nextBillingDate", [
    { value: customer.businessProfile?.nextBillingDate, source: customer.businessProfile?.source || "customer" },
  ]);
  const resolvedCreditLimitLastUpdated = pickBusinessValue("creditLimitLastUpdated", [
    { value: customer.businessProfile?.creditLimitLastUpdated, source: customer.businessProfile?.source || "customer" },
  ]);
  for (const resolved of [resolvedBusinessName, resolvedDba, resolvedEin, resolvedPhone, resolvedEmail, resolvedAddress1, resolvedAddress2, resolvedCity, resolvedState, resolvedZip, resolvedCountry, resolvedWebsite, resolvedShippingAddress1, resolvedShippingAddress2, resolvedShippingCity, resolvedShippingState, resolvedShippingZip, resolvedShippingCountry]) {
    if (resolved.source) businessProfileSources[resolved.field] = resolved.source;
  }
  const creditMetaVerified = Boolean(customer.creditProfile?.verified && customer.creditProfile?.source === "wc_cs_credits");
  const enrichedBusinessProfile = {
    ...(customer.businessProfile ?? {}),
    company: String(resolvedBusinessName.value || customer.businessProfile?.company || ""),
    dba: String(resolvedDba.value || customer.businessProfile?.dba || ""),
    ein: String(resolvedEin.value || customer.businessProfile?.ein || ""),
    phone: String(resolvedPhone.value || customer.businessProfile?.phone || ""),
    email: String(resolvedEmail.value || customer.businessProfile?.email || ""),
    address1: String(resolvedAddress1.value || customer.businessProfile?.address1 || ""),
    address2: String(resolvedAddress2.value || customer.businessProfile?.address2 || ""),
    city: String(resolvedCity.value || customer.businessProfile?.city || ""),
    state: String(resolvedState.value || customer.businessProfile?.state || ""),
    zip: String(resolvedZip.value || customer.businessProfile?.zip || ""),
    country: String(resolvedCountry.value || customer.businessProfile?.country || ""),
    website: String(resolvedWebsite.value || customer.businessProfile?.website || ""),
    shippingAddress1: String(resolvedShippingAddress1.value || customer.businessProfile?.shippingAddress1 || ""),
    shippingAddress2: String(resolvedShippingAddress2.value || customer.businessProfile?.shippingAddress2 || ""),
    shippingCity: String(resolvedShippingCity.value || customer.businessProfile?.shippingCity || ""),
    shippingState: String(resolvedShippingState.value || customer.businessProfile?.shippingState || ""),
    shippingZip: String(resolvedShippingZip.value || customer.businessProfile?.shippingZip || ""),
    shippingCountry: String(resolvedShippingCountry.value || customer.businessProfile?.shippingCountry || ""),
    approvedCredits: creditMetaVerified ? Number(customer.creditProfile?.approvedCredits ?? customer.businessProfile?.approvedCredits ?? 0) : 0,
    availableCredit: creditMetaVerified ? Number(customer.creditProfile?.availableCredit ?? customer.businessProfile?.availableCredit ?? 0) : 0,
    outstandingBalance: creditMetaVerified ? Number(customer.creditProfile?.outstandingBalance ?? customer.businessProfile?.outstandingBalance ?? 0) : 0,
    creditStatus: String(customer.creditProfile?.creditStatus || resolvedCreditStatus.value || customer.businessProfile?.creditStatus || customer.businessProfile?.net30Status || customer.businessProfile?.accountStatus || ""),
    creditMetaVerified,
    creditMetaSource: creditMetaVerified ? "wc_cs_credits" : (customer.businessProfile?.creditMetaSource || "unknown"),
    creditFallbackReason: creditMetaVerified ? "" : "WP credit meta not verified",
    creditLimit: creditMetaVerified ? Number(customer.creditProfile?.approvedCredits ?? customer.businessProfile?.creditLimit ?? 0) : 0,
    potentialCreditLimit: creditMetaVerified ? Math.max(
      Number(customer.creditProfile?.approvedCredits ?? 0),
      Number(customer.creditProfile?.availableCredit ?? 0),
      Number(customer.businessProfile?.potentialCreditLimit ?? 0)
    ) : 0,
    creditLimitLastUpdated: String(resolvedCreditLimitLastUpdated.value || customer.businessProfile?.creditLimitLastUpdated || ""),
    lastBillDate: String(customer.creditProfile?.lastBillDate || resolvedLastBillDate.value || customer.businessProfile?.lastBillDate || ""),
    nextBillingDate: String(customer.creditProfile?.nextBillingDate || resolvedNextBillingDate.value || customer.businessProfile?.nextBillingDate || ""),
  };
  const metrics = calculateCustomerValueMetrics({ customer: { ...customer, orders: normalizedOrders, gatewayPayments: mergedGatewayPayments, productJourney: normalizedProductJourney }, authorizeNetTransactions: gatewayCandidates, nmiTransactions: nmiCandidates });
  const unifiedPaymentLedger = buildUnifiedPaymentLedger({ customer: { ...customer, orders: normalizedOrders, gatewayPayments: mergedGatewayPayments }, authorizeNetTransactions: gatewayCandidates, nmiTransactions: nmiCandidates });
  const liveSummary = buildLiveAiSummary(customer.name, metrics.rankingTotal || Number(customer.paidTotal ?? customer.totalPaid ?? 0), normalizedOrders.filter((order) => order.isPaid).length || Number(customer.paidOrderCount ?? 0), metrics.attemptedTotal);
  const sourceCoverage = {
    ...(customer.sourceCoverage ?? {}),
    authorizeNetTransactionsFound: Math.max(customer.sourceCoverage?.authorizeNetTransactionsFound ?? 0, gatewayCandidates.length),
    nmiQuickPayTransactionsFound: Math.max(customer.sourceCoverage?.nmiQuickPayTransactionsFound ?? 0, nmiCandidates.length),
    gatewayOnlyPaymentsAttached: Math.max(customer.sourceCoverage?.gatewayOnlyPaymentsAttached ?? 0, (customer.orders ?? []).filter((order) => order.source === "authorize_net_only" || order.source === "nmi_quick_pay_only").length),
    reconciledRecords: Math.max(customer.sourceCoverage?.reconciledRecords ?? 0, mergedGatewayPayments.length),
    wooProfileMatched: wooOrderCandidates.length > 0 || /wordpress|woocommerce/i.test(String(customer.businessProfile?.sourcePlatform || customer.businessProfile?.source || "")),
    wooOrdersUsedForEnrichment: wooOrderCandidates.length,
    businessFieldsSource: businessProfileSources,
    creditMetaSource: creditMetaVerified ? "wc_cs_credits" : (enrichedBusinessProfile.creditMetaSource || customer.sourceCoverage?.creditMetaSource || ""),
    selectedCreditKey: String(customer.sourceCoverage?.selectedCreditKey ?? ""),
    selectedAvailableCreditKey: String(customer.sourceCoverage?.selectedAvailableCreditKey ?? ""),
    selectedOutstandingKey: String(customer.sourceCoverage?.selectedOutstandingKey ?? ""),
    selectedEinKey: String(customer.sourceCoverage?.selectedEinKey ?? ""),
    approvedCreditsFound: creditMetaVerified ? Math.max(Number(customer.sourceCoverage?.approvedCreditsFound ?? 0), Number(customer.creditProfile?.approvedCredits ?? 0)) : 0,
    availableCreditsFound: creditMetaVerified ? Math.max(Number(customer.sourceCoverage?.availableCreditsFound ?? 0), Number(customer.creditProfile?.availableCredit ?? 0)) : 0,
    einSource: resolvedEin.source || customer.sourceCoverage?.einSource || "",
    creditMetaVerified,
    creditFallbackReason: enrichedBusinessProfile.creditFallbackReason || customer.sourceCoverage?.creditFallbackReason || "",
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
      actualCreditLimit: creditMetaVerified ? Number(enrichedBusinessProfile.creditLimit ?? 0) : null,
      estimatedCreditLimit: creditMetaVerified ? Number(enrichedBusinessProfile.potentialCreditLimit ?? 0) : 0,
      unifiedPaymentLedger: unifiedPaymentLedger.rows,
      unifiedPaymentMetrics: unifiedPaymentLedger.metrics,
      orders: normalizedOrders,
      productJourney: normalizedProductJourney,
      gatewayPayments: mergedGatewayPayments,
      businessProfile: enrichedBusinessProfile,
      creditProfile: customer.creditProfile,
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
