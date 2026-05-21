import mongoose from "mongoose";
import { NextResponse } from "next/server";
import {
  fetchBatchTransactionSummaries,
  fetchCustomerProfile,
  fetchCustomerProfileIds,
  fetchSettledBatchIds,
  fetchTransactionDetails,
  fetchTransactionIdsForCustomerProfile,
  isAuthorizeNetConfigured,
  isDeclinedOrFailed,
  isSettledSuccessful,
  normalizeAuthorizeNetTransaction,
} from "@/lib/authorizeNet";
import { buildReconciledCustomerUpdate, reconcileAuthorizeNetTransaction } from "@/lib/authorizeNetReconciliation";
import { connectToDatabase } from "@/lib/mongodb";
import { normalizePhone } from "@/lib/wooOrderImport";
import { AuthorizeNetTransaction, type AuthorizeNetTransactionDocument } from "@/models/AuthorizeNetTransaction";
import { Customer, type CustomerDocument } from "@/models/Customer";

export const dynamic = "force-dynamic";
const earliestAuthorizeBatchDate = "2024-01-01";

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

type RepairBody = {
  email?: string;
  customerId?: string;
  customerProfileId?: string;
  customerProfileIds?: string[];
  invoiceNumbers?: string[];
  cardLast4s?: string[];
  amounts?: number[];
  skipCatalogDiscovery?: boolean;
  skipBatchDiscovery?: boolean;
  localOnly?: boolean;
  from?: string;
  to?: string;
  manualTransactions?: ManualTransaction[];
};

type SearchCriteria = {
  email: string;
  phone: string;
  phoneLast7: string;
  firstName: string;
  lastName: string;
  fullName: string;
  invoiceNumbers: Set<string>;
  cardLast4s: Set<string>;
  amounts: Set<string>;
  profileIds: Set<string>;
};

type ProfileCatalogDiscovery = {
  profileIds: string[];
  profilesScanned: number;
  profilesMatched: number;
};

function normalizedEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizedName(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizedLast4(value: unknown) {
  return String(value ?? "").replace(/\D/g, "").slice(-4);
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

function dateInput(value: unknown, fallback: string) {
  const raw = String(value ?? fallback).trim();
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function minDate(a: string, b: string) {
  return new Date(`${a}T00:00:00Z`) <= new Date(`${b}T00:00:00Z`) ? a : b;
}

function isOnOrBefore(a: string, b: string) {
  return new Date(`${a}T00:00:00Z`).getTime() <= new Date(`${b}T00:00:00Z`).getTime();
}

function uniqueStrings(values: Array<unknown>) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function normalizedAmount(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed.toFixed(2) : "";
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
    cardLast4: normalizedLast4(transaction.cardLast4),
    paymentMethod: "card",
    customerProfileId: String(transaction.customerProfileId || fallbackProfileId || "").trim(),
    customerPaymentProfileId: String(transaction.customerPaymentProfileId ?? "").trim(),
    rawSafeMeta: [{ key: "source", value: "manual_repair" }],
    importedAt,
  } satisfies Partial<AuthorizeNetTransactionDocument>;
}

function buildSearchCriteria(customer: LeanCustomer, body: RepairBody, discoveredProfiles: string[]) {
  const nameParts = customer.name.trim().split(/\s+/).filter(Boolean);
  const firstName = normalizedName(nameParts[0] ?? "");
  const lastName = normalizedName(nameParts[nameParts.length - 1] ?? "");
  const invoiceNumbers = uniqueStrings([
    ...(body.invoiceNumbers ?? []),
    ...(customer.orders ?? []).map((order) => order.orderNumber),
  ]);
  const cardLast4s = uniqueStrings([
    ...(body.cardLast4s ?? []),
    ...(customer.gatewayPayments ?? []).map((payment) => payment.cardLast4),
    ...(customer.orders ?? []).map((order) => order.gatewayVerification?.last4),
  ]).map(normalizedLast4).filter(Boolean);
  const amounts = uniqueStrings([
    ...(body.amounts ?? []),
    ...(customer.orders ?? []).map((order) => order.total),
    ...(customer.gatewayPayments ?? []).map((payment) => payment.amount),
  ]).map(normalizedAmount).filter(Boolean);
  return {
    email: customer.normalizedEmail || normalizedEmail(customer.email),
    phone: normalizePhone(customer.phone ?? ""),
    phoneLast7: normalizePhone(customer.phone ?? "").slice(-7),
    firstName,
    lastName,
    fullName: normalizedName(customer.name),
    invoiceNumbers: new Set(invoiceNumbers),
    cardLast4s: new Set(cardLast4s),
    amounts: new Set(amounts),
    profileIds: new Set(discoveredProfiles),
  } satisfies SearchCriteria;
}

function summaryMatchesSearch(summary: {
  invoiceNumber: string;
  firstName: string;
  lastName: string;
  amount: number;
  cardLast4: string;
  customerProfileId: string;
}, criteria: SearchCriteria) {
  const invoiceMatch = summary.invoiceNumber && criteria.invoiceNumbers.has(summary.invoiceNumber);
  const cardMatch = summary.cardLast4 && criteria.cardLast4s.has(normalizedLast4(summary.cardLast4));
  const profileMatch = summary.customerProfileId && criteria.profileIds.has(summary.customerProfileId);
  const amountMatch = normalizedAmount(summary.amount) && criteria.amounts.has(normalizedAmount(summary.amount));
  const firstNameMatch = criteria.firstName && normalizedName(summary.firstName) === criteria.firstName;
  const lastNameMatch = criteria.lastName && normalizedName(summary.lastName) === criteria.lastName;
  const amountAssistedMatch = amountMatch && (cardMatch || profileMatch || (firstNameMatch && lastNameMatch) || lastNameMatch);
  return invoiceMatch || cardMatch || profileMatch || amountAssistedMatch || (firstNameMatch && lastNameMatch);
}

function profileMatchesSearch(profile: {
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  company: string;
  cardLast4s: string[];
}, criteria: SearchCriteria) {
  const emailMatch = profile.email && profile.email === criteria.email;
  const phoneMatch = Boolean(criteria.phoneLast7 && normalizePhone(profile.phone).endsWith(criteria.phoneLast7));
  const firstNameMatch = criteria.firstName && normalizedName(profile.firstName) === criteria.firstName;
  const lastNameMatch = criteria.lastName && normalizedName(profile.lastName) === criteria.lastName;
  const companyNameMatch = criteria.fullName && normalizedName(profile.company).includes(criteria.lastName);
  const cardMatch = profile.cardLast4s.some((last4) => criteria.cardLast4s.has(normalizedLast4(last4)));
  return Boolean(emailMatch || phoneMatch || cardMatch || (firstNameMatch && lastNameMatch) || companyNameMatch);
}

function detailMatchesSearch(transaction: Partial<AuthorizeNetTransactionDocument>, criteria: SearchCriteria) {
  const emailMatch = transaction.normalizedEmail && transaction.normalizedEmail === criteria.email;
  const invoiceMatch = transaction.invoiceNumber && criteria.invoiceNumbers.has(transaction.invoiceNumber);
  const profileMatch = transaction.customerProfileId && criteria.profileIds.has(transaction.customerProfileId);
  const phoneMatch = Boolean(criteria.phoneLast7 && normalizePhone(transaction.billingPhone ?? "").endsWith(criteria.phoneLast7));
  const cardMatch = Boolean(transaction.cardLast4 && criteria.cardLast4s.has(normalizedLast4(transaction.cardLast4)));
  const amountMatch = Boolean(normalizedAmount(transaction.amount) && criteria.amounts.has(normalizedAmount(transaction.amount)));
  const nameMatch = normalizedName(transaction.customerName).includes(criteria.firstName) && normalizedName(transaction.customerName).includes(criteria.lastName);
  const amountAssistedMatch = amountMatch && (emailMatch || profileMatch || phoneMatch || cardMatch || nameMatch);
  return Boolean(emailMatch || invoiceMatch || profileMatch || phoneMatch || cardMatch || amountAssistedMatch || (nameMatch && cardMatch));
}

async function findCustomersByBody(email: string, customerId?: string) {
  if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
    return Customer.findById(customerId).lean<LeanCustomer | null>().exec();
  }
  if (!email) return null;
  return Customer.findOne({ $or: [{ normalizedEmail: email }, { email }] }).lean<LeanCustomer | null>().exec();
}

async function discoverProfileIdsFromKnownTransactions(customer: LeanCustomer, importedAt: string, warnings: string[]) {
  const orderTransactionIds = Array.from(new Set((customer.orders ?? []).map((order) => order.transactionId).filter(Boolean))).slice(0, 12);
  const discoveredProfileIds: string[] = [];
  for (const transactionId of orderTransactionIds) {
    try {
      const detail = await fetchTransactionDetails(transactionId);
      const normalized = normalizeAuthorizeNetTransaction(detail, importedAt);
      if (normalized.customerProfileId) discoveredProfileIds.push(String(normalized.customerProfileId));
    } catch (error) {
      warnings.push(`${transactionId}: ${error instanceof Error ? error.message : "Authorize.net profile discovery failed."}`);
    }
  }
  return uniqueStrings(discoveredProfileIds);
}

async function discoverProfileIdsFromLocalTransactions(customer: LeanCustomer, criteria: SearchCriteria) {
  const terms = customerNameTerms(customer);
  const nameRegex = terms.length >= 2 ? terms.map(escapeRegex).join(".*") : "";
  const localMatches = await AuthorizeNetTransaction.find({
    $or: [
      ...(criteria.email ? [{ normalizedEmail: criteria.email }, { emailNormalized: criteria.email }, { customerEmail: criteria.email }] : []),
      ...(criteria.phoneLast7 ? [{ billingPhone: { $regex: escapeRegex(criteria.phoneLast7), $options: "i" } }] : []),
      ...(criteria.invoiceNumbers.size ? [{ invoiceNumber: { $in: Array.from(criteria.invoiceNumbers) } }] : []),
      ...(nameRegex ? [{ customerName: { $regex: nameRegex, $options: "i" } }] : []),
      ...(criteria.cardLast4s.size ? [{ cardLast4: { $in: Array.from(criteria.cardLast4s) } }] : []),
    ],
  }, {
    customerProfileId: 1,
    customerPaymentProfileId: 1,
  }).limit(250).lean<Array<Pick<AuthorizeNetTransactionDocument, "customerProfileId" | "customerPaymentProfileId">>>();
  return uniqueStrings(localMatches.flatMap((transaction) => [transaction.customerProfileId, transaction.customerPaymentProfileId]));
}

async function discoverProfilesFromGatewayCatalog(criteria: SearchCriteria, signal: AbortSignal, warnings: string[]): Promise<ProfileCatalogDiscovery> {
  const matchedProfiles: string[] = [];
  let profilesScanned = 0;
  const maxProfilesToScan = 250;
  const startedAt = Date.now();
  try {
    const profileIds = await fetchCustomerProfileIds(signal);
    for (const profileId of profileIds) {
      if (signal.aborted || profilesScanned >= maxProfilesToScan || Date.now() - startedAt > 12000) break;
      profilesScanned += 1;
      try {
        const profile = await fetchCustomerProfile(profileId, signal);
        if (profileMatchesSearch(profile, criteria)) {
          matchedProfiles.push(profile.customerProfileId);
        }
      } catch (error) {
        warnings.push(`Customer profile ${profileId}: ${error instanceof Error ? error.message : "Authorize.net customer profile fetch failed."}`);
      }
    }
    if (profileIds.length > profilesScanned) {
      warnings.push(`Customer profile catalog scan stopped after ${profilesScanned} profiles to keep repair bounded.`);
    }
  } catch (error) {
    warnings.push(`Customer profile catalog: ${error instanceof Error ? error.message : "Authorize.net customer profile lookup failed."}`);
  }

  const uniqueProfiles = uniqueStrings(matchedProfiles);
  return {
    profileIds: uniqueProfiles,
    profilesScanned,
    profilesMatched: uniqueProfiles.length,
  };
}

function knownCustomerMatch(transaction: AuthorizeNetTransactionDocument, criteria: SearchCriteria) {
  if (transaction.invoiceNumber && criteria.invoiceNumbers.has(transaction.invoiceNumber)) {
    return { matchedBy: "invoiceNumber", confidence: "exact" as const };
  }
  if (transaction.normalizedEmail && transaction.normalizedEmail === criteria.email) {
    return { matchedBy: "normalizedEmail", confidence: "high" as const };
  }
  if (transaction.customerProfileId && criteria.profileIds.has(transaction.customerProfileId)) {
    return { matchedBy: "customerProfileId", confidence: "high" as const };
  }
  if (criteria.phoneLast7 && normalizePhone(transaction.billingPhone ?? "").endsWith(criteria.phoneLast7)) {
    return { matchedBy: "phone", confidence: "medium" as const };
  }
  return { matchedBy: "billing_name", confidence: "medium" as const };
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed. Use POST with email or customerId." }, { status: 405 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as RepairBody;
  const email = normalizedEmail(body.email);
  await connectToDatabase();

  const customer = await findCustomersByBody(email, body.customerId);
  if (!customer) {
    return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  }

  const customerEmail = customer.normalizedEmail || normalizedEmail(customer.email);
  const importedAt = new Date().toISOString();
  const warnings: string[] = [];
  const initialProfileIds = uniqueStrings([
    body.customerProfileId,
    ...(body.customerProfileIds ?? []),
    customer.gatewayVerification?.customerProfileId,
    ...(customer.gatewayPayments ?? []).map((payment) => payment.customerProfileId),
    ...(customer.orders ?? []).map((order) => order.gatewayVerification?.customerProfileId),
  ]);
  const discoveredFromKnownTransactions = isAuthorizeNetConfigured()
    ? await discoverProfileIdsFromKnownTransactions(customer, importedAt, warnings)
    : [];
  const criteria = buildSearchCriteria(customer, body, [...initialProfileIds, ...discoveredFromKnownTransactions]);
  const discoveredFromLocalTransactions = await discoverProfileIdsFromLocalTransactions(customer, criteria);
  const profileIds = uniqueStrings([...initialProfileIds, ...discoveredFromKnownTransactions, ...discoveredFromLocalTransactions]);
  criteria.profileIds = new Set(profileIds);

  const debugProfileCounts: Record<string, number> = {};
  const searchedProfiles: string[] = [];
  const fetchedTransactionIds = new Set<string>();
  const normalizedMatches = new Map<string, Partial<AuthorizeNetTransactionDocument>>();
  let fetchedFromGateway = 0;
  let insertedFromGateway = 0;
  let skippedGatewayDuplicates = 0;
  let rejectedGatewayRecords = 0;
  let latestImportedTransactionId = "";
  let batchWindowsScanned = 0;
  let catalogProfilesScanned = 0;
  let catalogProfilesMatched = 0;

  if (isAuthorizeNetConfigured() && !body.localOnly) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const addMatchingDetail = async (transactionId: string, fallbackProfileId = "") => {
        if (fetchedTransactionIds.has(transactionId)) return;
        fetchedTransactionIds.add(transactionId);
        try {
          const detail = await fetchTransactionDetails(transactionId, controller.signal);
          const normalized = normalizeAuthorizeNetTransaction(detail, importedAt);
          if (!normalized.transactionId) {
            rejectedGatewayRecords += 1;
            return;
          }
          if (fallbackProfileId && !normalized.customerProfileId) normalized.customerProfileId = fallbackProfileId;
          if (normalized.customerProfileId) criteria.profileIds.add(normalized.customerProfileId);
          if (detailMatchesSearch(normalized, criteria)) {
            normalizedMatches.set(String(normalized.transactionId), normalized);
          }
        } catch (error) {
          rejectedGatewayRecords += 1;
          warnings.push(`${transactionId}: ${error instanceof Error ? error.message : "Authorize.net detail fetch failed."}`);
        }
      };

      if (!body.skipCatalogDiscovery) {
        const catalogDiscovery = await discoverProfilesFromGatewayCatalog(criteria, controller.signal, warnings);
        catalogProfilesScanned = catalogDiscovery.profilesScanned;
        catalogProfilesMatched = catalogDiscovery.profilesMatched;
        for (const profileId of catalogDiscovery.profileIds) {
          criteria.profileIds.add(profileId);
        }
      }

      for (const profileId of Array.from(criteria.profileIds)) {
        searchedProfiles.push(profileId);
        try {
          const ids = Array.from(new Set(await fetchTransactionIdsForCustomerProfile(profileId, 100, 1, controller.signal)));
          debugProfileCounts[profileId] = ids.length;
          fetchedFromGateway += ids.length;
          for (const transactionId of ids) {
            await addMatchingDetail(transactionId, profileId);
          }
        } catch (error) {
          warnings.push(`Profile ${profileId}: ${error instanceof Error ? error.message : "Authorize.net profile fetch failed."}`);
        }
      }

      if (!body.skipBatchDiscovery) {
        const from = dateInput(body.from, customer.firstOrderDate || earliestAuthorizeBatchDate);
        const to = dateInput(body.to, new Date().toISOString().slice(0, 10));
        const batchScanFrom = isOnOrBefore(earliestAuthorizeBatchDate, from) ? from : earliestAuthorizeBatchDate;
        for (let windowStart = batchScanFrom; isOnOrBefore(windowStart, to); windowStart = addDays(windowStart, 31)) {
          if (controller.signal.aborted) break;
          const windowEnd = minDate(addDays(windowStart, 30), to);
          batchWindowsScanned += 1;
          try {
            const batches = await fetchSettledBatchIds(windowStart, windowEnd, controller.signal);
            for (const batch of batches) {
              const summaries = await fetchBatchTransactionSummaries(batch.batchId, controller.signal);
              const batchHasPotentialMatch = summaries.some((summary) => summaryMatchesSearch(summary, criteria));
              for (const summary of summaries) {
                if (summary.customerProfileId) criteria.profileIds.add(summary.customerProfileId);
                if (batchHasPotentialMatch || summaryMatchesSearch(summary, criteria)) {
                  await addMatchingDetail(summary.transactionId, summary.customerProfileId);
                }
              }
            }
          } catch (error) {
            warnings.push(`Settled batch scan ${windowStart} to ${windowEnd}: ${error instanceof Error ? error.message : "Authorize.net batch scan failed."}`);
          }
        }
      }

      const newlyDiscoveredProfiles = Array.from(criteria.profileIds).filter((profileId) => !searchedProfiles.includes(profileId));
      for (const profileId of newlyDiscoveredProfiles) {
        searchedProfiles.push(profileId);
        try {
          const ids = Array.from(new Set(await fetchTransactionIdsForCustomerProfile(profileId, 100, 1, controller.signal)));
          debugProfileCounts[profileId] = ids.length;
          fetchedFromGateway += ids.length;
          for (const transactionId of ids) {
            await addMatchingDetail(transactionId, profileId);
          }
        } catch (error) {
          warnings.push(`Profile ${profileId}: ${error instanceof Error ? error.message : "Authorize.net profile fetch failed."}`);
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const fallbackProfileId = profileIds[0] ?? "";
  for (const manual of body.manualTransactions ?? []) {
    const normalized = manualToStored(manual, customerEmail, fallbackProfileId, importedAt);
    if (!normalized.transactionId) {
      warnings.push("Skipped manual transaction without transactionId.");
      continue;
    }
    normalizedMatches.set(String(normalized.transactionId), normalized);
  }

  const matchedTransactions = Array.from(normalizedMatches.values());
  if (matchedTransactions.length > 0) {
    latestImportedTransactionId = String(matchedTransactions[0]?.transactionId ?? "");
    const writeResult = await AuthorizeNetTransaction.bulkWrite(matchedTransactions.map((transaction) => ({
      updateOne: {
        filter: { transactionId: transaction.transactionId },
        update: { $set: transaction },
        upsert: true,
      },
    })), { ordered: false });
    insertedFromGateway = writeResult.upsertedCount + writeResult.modifiedCount;
    skippedGatewayDuplicates = Math.max(0, writeResult.matchedCount - writeResult.modifiedCount);
  }

  const paidTotalBefore = Number(customer.paidTotal ?? customer.totalPaid ?? 0);
  const gatewayPaymentsBefore = customer.gatewayPayments?.length ?? 0;
  const ordersBefore = customer.orders?.length ?? 0;
  const phone = normalizePhone(customer.phone ?? "");
  const terms = customerNameTerms(customer);
  const nameRegex = terms.length >= 2 ? terms.map(escapeRegex).join(".*") : "";
  const cardLast4s = Array.from(criteria.cardLast4s);

  const [byEmail, byName, byPhone, byInvoice, byProfileId, byCardName] = await Promise.all([
    customerEmail && !customerEmail.endsWith("@woocommerce.local")
      ? AuthorizeNetTransaction.find({ $or: [{ normalizedEmail: customerEmail }, { customerEmail: { $regex: `^${escapeRegex(customerEmail)}$`, $options: "i" } }] }).sort({ submittedAt: -1 }).limit(300).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
    nameRegex
      ? AuthorizeNetTransaction.find({ customerName: { $regex: nameRegex, $options: "i" } }).sort({ submittedAt: -1 }).limit(300).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
    phone.length >= 7
      ? AuthorizeNetTransaction.find({ billingPhone: { $regex: escapeRegex(phone.slice(-7)), $options: "i" } }).sort({ submittedAt: -1 }).limit(300).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
    criteria.invoiceNumbers.size
      ? AuthorizeNetTransaction.find({ invoiceNumber: { $in: Array.from(criteria.invoiceNumbers) } }).sort({ submittedAt: -1 }).limit(300).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
    criteria.profileIds.size
      ? AuthorizeNetTransaction.find({ $or: [{ customerProfileId: { $in: Array.from(criteria.profileIds) } }, { customerPaymentProfileId: { $in: Array.from(criteria.profileIds) } }] }).sort({ submittedAt: -1 }).limit(300).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
    cardLast4s.length && nameRegex
      ? AuthorizeNetTransaction.find({ cardLast4: { $in: cardLast4s }, customerName: { $regex: nameRegex, $options: "i" } }).sort({ submittedAt: -1 }).limit(300).lean<AuthorizeNetTransactionDocument[]>().exec()
      : Promise.resolve([]),
  ]);

  const candidateMap = new Map<string, AuthorizeNetTransactionDocument>();
  for (const transaction of [...byEmail, ...byName, ...byPhone, ...byInvoice, ...byProfileId, ...byCardName]) {
    if (transaction.transactionId && !candidateMap.has(transaction.transactionId) && detailMatchesSearch(transaction, criteria)) {
      candidateMap.set(transaction.transactionId, transaction);
    }
  }
  const candidates = Array.from(candidateMap.values()).slice(0, 400);
  let addedGatewayOnlyPayments = 0;
  let verifiedWooOrders = 0;
  let skippedDuplicates = 0;
  let matched = 0;
  let settledMatched = 0;
  let declinedMatched = 0;
  let unmatchedSettled = 0;

  if (body.localOnly) {
    let workingCustomer = customer;
    for (const transaction of candidates) {
      const match = knownCustomerMatch(transaction, criteria);
      const result = buildReconciledCustomerUpdate(workingCustomer, transaction, match.matchedBy, match.confidence);
      workingCustomer = {
        ...workingCustomer,
        ...result.updates,
      };
      matched += 1;
      if (isSettledSuccessful(transaction.transactionStatus)) settledMatched += 1;
      else if (isDeclinedOrFailed(transaction.transactionStatus)) declinedMatched += 1;
      if (result.attachedAuthorizeNetOnly) addedGatewayOnlyPayments += 1;
      if (result.verifiedWooOrder) verifiedWooOrders += 1;
      if (result.skippedDuplicate) skippedDuplicates += 1;
    }
    await Customer.updateOne({ _id: customer._id }, { $set: workingCustomer }).exec();
  } else {
    for (const transaction of candidates) {
      const result = await reconcileAuthorizeNetTransaction(transaction, false);
      if (!result.matched || result.customerId !== String(customer._id)) {
        if (isSettledSuccessful(transaction.transactionStatus)) unmatchedSettled += 1;
        continue;
      }
      matched += 1;
      if (isSettledSuccessful(transaction.transactionStatus)) settledMatched += 1;
      else if (isDeclinedOrFailed(transaction.transactionStatus)) declinedMatched += 1;
      if (result.attachedAuthorizeNetOnly) addedGatewayOnlyPayments += 1;
      if (result.verifiedWooOrder) verifiedWooOrders += 1;
      if (result.skippedDuplicate) skippedDuplicates += 1;
    }
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
    settledMatched,
    declinedMatched,
    unmatchedSettled,
    paidTotalBefore,
    paidTotalAfter: Number(finalCustomer?.paidTotal ?? finalCustomer?.totalPaid ?? paidTotalBefore),
    gatewayPaymentsCount: finalCustomer?.gatewayPayments?.length ?? gatewayPaymentsBefore,
    ordersCount: finalCustomer?.orders?.length ?? ordersBefore,
    warnings,
      debug: {
        profilesSearched: searchedProfiles,
        profilesFound: Array.from(criteria.profileIds),
        catalogProfilesScanned,
        catalogProfilesMatched,
        transactionsFetchedPerProfile: debugProfileCounts,
        fetchedFromGateway,
        insertedIntoMongo: insertedFromGateway,
      skippedDuplicates: skippedGatewayDuplicates,
      matchedCustomers: matched,
      rejectedRecords: rejectedGatewayRecords,
      latestImportedTransactionId,
      batchWindowsScanned,
      unmatchedSettled,
      settledMatched,
      declinedMatched,
    },
    message: `Processed ${candidates.length} Authorize.net candidate transactions for ${customer.email}. Added ${addedGatewayOnlyPayments} gateway-only payments.`,
  });
}
