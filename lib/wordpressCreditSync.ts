import { Customer, type CustomerDocument } from "@/models/Customer";
import { type WordPressCreditRecord, type WordPressCreditRouteProbe, fetchWordPressCreditRecords } from "@/lib/wordpressProfiles";

type LeanCustomer = CustomerDocument & { _id: unknown };

type CreditMatch = {
  customer: LeanCustomer | null;
  confidence: "exact" | "high" | "medium" | "low" | "none";
  reasons: string[];
};

type ImportWordPressCreditBatchOptions = {
  limit: number;
  offset: number;
  dryRun?: boolean;
  maxRuntimeMs?: number;
};

type ImportWordPressCreditBatchResult = {
  processed: number;
  matchedCustomers: number;
  updatedProfiles: number;
  hasMore: boolean;
  nextOffset: number;
  warnings: string[];
  selectedRoute?: string;
  routeProbes?: WordPressCreditRouteProbe[];
  records: Array<{
    postId: number;
    confidence: CreditMatch["confidence"];
    reasons: string[];
    matchedCustomerId: string;
  }>;
};

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function words(value: string) {
  return normalizeName(value).split(" ").filter((part) => part.length > 1);
}

function normalizedRecordName(record: WordPressCreditRecord) {
  return normalizeName(`${record.rawMeta._user_first_name ?? ""} ${record.rawMeta._user_last_name ?? ""}`);
}

async function findCandidateCustomers(record: WordPressCreditRecord) {
  const or: Array<Record<string, unknown>> = [];
  if (record.normalizedEmail) {
    or.push({ normalizedEmail: record.normalizedEmail });
    or.push({ emailNormalized: record.normalizedEmail });
    or.push({ email: record.normalizedEmail });
    or.push({ "businessProfile.email": record.normalizedEmail });
    or.push({ "creditProfile.email": record.normalizedEmail });
  }
  if (record.linkedUserId) {
    or.push({ "creditProfile.linkedUserId": record.linkedUserId });
    or.push({ "orders.customerId": Number(record.linkedUserId) || -1 });
  }
  if (record.linkedCustomerId) {
    or.push({ "creditProfile.linkedCustomerId": record.linkedCustomerId });
    or.push({ "orders.customerId": Number(record.linkedCustomerId) || -1 });
  }
  if (record.normalizedPhone.length >= 7) {
    or.push({ phoneNormalized: record.normalizedPhone });
    or.push({ "businessProfile.phone": { $regex: escapeRegex(record.normalizedPhone.slice(-7)), $options: "i" } });
    or.push({ phone: { $regex: escapeRegex(record.normalizedPhone.slice(-7)), $options: "i" } });
  }
  if (record.company) {
    or.push({ "businessProfile.company": { $regex: escapeRegex(record.company), $options: "i" } });
    or.push({ "orders.billingCompany": { $regex: escapeRegex(record.company), $options: "i" } });
  }
  if (record.linkedOrderId) {
    or.push({ "orders.orderId": record.linkedOrderId });
    or.push({ "orders.orderNumber": record.linkedOrderId });
  }
  if (record.linkedSubscriptionId) {
    or.push({ "orders.orderId": record.linkedSubscriptionId });
    or.push({ "orders.orderNumber": record.linkedSubscriptionId });
  }
  const nameTokens = words(normalizedRecordName(record));
  if (nameTokens.length >= 2) {
    or.push({ name: { $regex: nameTokens.map(escapeRegex).join(".*"), $options: "i" } });
    or.push({ "orders.billingName": { $regex: nameTokens.map(escapeRegex).join(".*"), $options: "i" } });
  }
  if (!or.length) return [];
  return Customer.find(
    { $or: or },
    {
      name: 1,
      email: 1,
      normalizedEmail: 1,
      phone: 1,
      phoneNormalized: 1,
      businessProfile: 1,
      creditProfile: 1,
      sourceCoverage: 1,
      orders: 1,
    }
  ).limit(10).lean<LeanCustomer[]>().exec();
}

export async function findCustomerForCreditRecord(record: WordPressCreditRecord): Promise<CreditMatch> {
  const candidates = await findCandidateCustomers(record);
  if (!candidates.length) return { customer: null, confidence: "none", reasons: [] };
  const recordName = normalizedRecordName(record);
  const scored = candidates.map((customer) => {
    let score = 0;
    const reasons: string[] = [];
    if (record.normalizedEmail && [customer.normalizedEmail, customer.email?.trim().toLowerCase(), customer.businessProfile?.email?.trim().toLowerCase(), customer.creditProfile?.email?.trim().toLowerCase()].includes(record.normalizedEmail)) {
      score += 120;
      reasons.push("email");
    }
    if (record.linkedUserId && (customer.creditProfile?.linkedUserId === record.linkedUserId || (customer.orders ?? []).some((order) => String(order.customerId ?? "") === record.linkedUserId))) {
      score += 90;
      reasons.push("linked_user_id");
    }
    if (record.linkedCustomerId && (customer.creditProfile?.linkedCustomerId === record.linkedCustomerId || (customer.orders ?? []).some((order) => String(order.customerId ?? "") === record.linkedCustomerId))) {
      score += 90;
      reasons.push("linked_customer_id");
    }
    if (record.normalizedPhone && [customer.phoneNormalized, String(customer.phone ?? "").replace(/\D/g, ""), String(customer.businessProfile?.phone ?? "").replace(/\D/g, "")].includes(record.normalizedPhone)) {
      score += 70;
      reasons.push("phone");
    } else if (record.normalizedPhone.length >= 7) {
      const tail = record.normalizedPhone.slice(-7);
      if ([customer.phone, customer.businessProfile?.phone].some((value) => String(value ?? "").replace(/\D/g, "").endsWith(tail))) {
        score += 45;
        reasons.push("phone_tail");
      }
    }
    if (record.company) {
      const companyValues = [customer.businessProfile?.company, ...(customer.orders ?? []).map((order) => order.billingCompany)];
      if (companyValues.some((value) => normalizeName(String(value ?? "")) === normalizeName(record.company))) {
        score += 55;
        reasons.push("company");
      }
    }
    if (record.linkedOrderId && (customer.orders ?? []).some((order) => String(order.orderId) === record.linkedOrderId || String(order.orderNumber) === record.linkedOrderId)) {
      score += 65;
      reasons.push("linked_order");
    }
    if (record.linkedSubscriptionId && (customer.orders ?? []).some((order) => String(order.orderId) === record.linkedSubscriptionId || String(order.orderNumber) === record.linkedSubscriptionId)) {
      score += 45;
      reasons.push("linked_subscription");
    }
    if (recordName) {
      const customerNames = [customer.name, ...(customer.orders ?? []).map((order) => order.billingName)];
      if (customerNames.some((value) => normalizeName(String(value ?? "")) === recordName)) {
        score += 45;
        reasons.push("name");
      }
    }
    return { customer, score, reasons };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const confidence: CreditMatch["confidence"] = best.score >= 120 ? "exact" : best.score >= 90 ? "high" : best.score >= 50 ? "medium" : best.score > 0 ? "low" : "none";
  return { customer: best.customer, confidence, reasons: best.reasons };
}

function buildCreditUpdate(record: WordPressCreditRecord, customer: LeanCustomer, importedAt: string) {
  const totalCreditLimit = Math.max(record.approvedCredits, record.availableCredit);
  return {
    creditProfile: {
      approvedCredits: record.approvedCredits,
      availableCredit: record.availableCredit,
      outstandingBalance: record.outstandingBalance,
      creditStatus: record.creditStatus,
      lastBillDate: record.lastBillDate,
      nextBillingDate: record.nextBillingDate,
      sourcePostId: String(record.postId),
      sourcePostType: "wc_cs_credits",
      sourceOrderId: record.linkedOrderId,
      sourceSubscriptionId: record.linkedSubscriptionId,
      linkedUserId: record.linkedUserId,
      linkedCustomerId: record.linkedCustomerId,
      email: record.email,
      phone: record.phone,
      company: record.company,
      ein: record.ein,
      source: "wc_cs_credits" as const,
      verified: true,
      importedAt,
    },
    actualCreditLimit: record.approvedCredits || null,
    estimatedCreditLimit: totalCreditLimit,
    "businessProfile.ein": record.ein || customer.businessProfile?.ein || "",
    "businessProfile.approvedCredits": record.approvedCredits,
    "businessProfile.availableCredit": record.availableCredit,
    "businessProfile.outstandingBalance": record.outstandingBalance,
    "businessProfile.creditStatus": record.creditStatus,
    "businessProfile.creditLimit": record.approvedCredits,
    "businessProfile.potentialCreditLimit": totalCreditLimit,
    "businessProfile.lastBillDate": record.lastBillDate,
    "businessProfile.nextBillingDate": record.nextBillingDate,
    "businessProfile.creditMetaVerified": true,
    "businessProfile.creditMetaSource": "wc_cs_credits",
    "businessProfile.creditFallbackReason": "",
    "businessProfile.source": customer.businessProfile?.source || "wc_cs_credits",
    "sourceCoverage.creditMetaVerified": true,
    "sourceCoverage.creditMetaSource": "wc_cs_credits",
    "sourceCoverage.approvedCreditsFound": record.approvedCredits,
    "sourceCoverage.availableCreditsFound": record.availableCredit,
    "sourceCoverage.einSource": record.ein ? "wc_cs_credits" : (customer.sourceCoverage?.einSource || ""),
    "sourceCoverage.selectedCreditKey": record.detectedKeys.approved,
    "sourceCoverage.selectedAvailableCreditKey": record.detectedKeys.available,
    "sourceCoverage.selectedOutstandingKey": record.detectedKeys.outstanding,
    "sourceCoverage.selectedEinKey": record.detectedKeys.ein,
    "sourceCoverage.lastSyncedAt": importedAt,
  };
}

export async function importWordPressCreditBatch(options: ImportWordPressCreditBatchOptions): Promise<ImportWordPressCreditBatchResult> {
  const { limit, offset, dryRun = false, maxRuntimeMs = 8000 } = options;
  const { posts, total, selectedRoute, routeProbes } = await fetchWordPressCreditRecords({ limit, offset });
  const warnings: string[] = [];
  const importedAt = new Date().toISOString();
  const deadline = Date.now() + maxRuntimeMs;
  let matchedCustomers = 0;
  let updatedProfiles = 0;
  let examined = 0;
  const records: ImportWordPressCreditBatchResult["records"] = [];

  for (const record of posts) {
    if (Date.now() >= deadline) {
      warnings.push("Stopped WordPress credit import batch to stay within runtime budget.");
      break;
    }
    examined += 1;
    if (!record.verified) {
      warnings.push(`Post ${record.postId} skipped because verified approved/available credits were not found.`);
      continue;
    }
    const match = await findCustomerForCreditRecord(record);
    records.push({
      postId: record.postId,
      confidence: match.confidence,
      reasons: match.reasons,
      matchedCustomerId: match.customer ? String(match.customer._id) : "",
    });
    if (!match.customer) continue;
    matchedCustomers += 1;
    if (dryRun) continue;
    await Customer.updateOne({ _id: match.customer._id }, { $set: buildCreditUpdate(record, match.customer, importedAt) }).exec();
    updatedProfiles += 1;
  }

  const processed = examined;
  const nextOffset = offset + processed;
  const hasMore = posts.length === limit && (total === 0 || nextOffset < total);
  return {
    processed,
    matchedCustomers,
    updatedProfiles,
    hasMore,
    nextOffset,
    warnings,
    selectedRoute,
    routeProbes,
    records,
  };
}
