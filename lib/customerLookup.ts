import mongoose from "mongoose";
import { Customer, type CustomerDocument } from "@/models/Customer";

export type CustomerLookupDocument = CustomerDocument & {
  _id: unknown;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

export type CustomerLookupResult = {
  customer: CustomerLookupDocument | null;
  documentsWithSameEmail: number;
  selectedDocumentReason: string;
};

export function decodeCustomerLookupId(rawId: string) {
  try {
    return decodeURIComponent(rawId).trim();
  } catch {
    return rawId.trim();
  }
}

function normalizeEmail(value: string) {
  return decodeCustomerLookupId(value).toLowerCase();
}

function emailLookupQuery(email: string) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { email: { $regex: `^${escaped}$`, $options: "i" } };
}

function orderTimelineCount(customer: CustomerLookupDocument) {
  return Array.isArray(customer.orders) ? customer.orders.length : 0;
}

function latestCustomerTime(customer: CustomerLookupDocument) {
  const raw = customer.lastSyncedAt || customer.updatedAt || customer.createdAt || "";
  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function uniqueCustomers(customers: CustomerLookupDocument[]) {
  const byId = new Map<string, CustomerLookupDocument>();
  for (const customer of customers) {
    if (customer?._id) byId.set(String(customer._id), customer);
  }
  return Array.from(byId.values());
}

function chooseBestCustomer(
  customers: CustomerLookupDocument[],
  options: { preferredId?: string; lookupKind: "id" | "email" }
): CustomerLookupResult {
  const candidates = uniqueCustomers(customers);
  if (candidates.length === 0) {
    return { customer: null, documentsWithSameEmail: 0, selectedDocumentReason: "not_found" };
  }

  const sorted = [...candidates].sort((a, b) => {
    const orderDiff = Number(orderTimelineCount(b) > 0) - Number(orderTimelineCount(a) > 0);
    if (orderDiff !== 0) return orderDiff;
    return latestCustomerTime(b) - latestCustomerTime(a);
  });

  const selected = sorted[0];
  const preferredSelected = options.preferredId && String(selected._id) === options.preferredId;
  const hasOrders = orderTimelineCount(selected) > 0;

  let selectedDocumentReason = hasOrders ? "matched_email_with_orders" : "matched_email";
  if (options.lookupKind === "id") {
    if (preferredSelected) {
      selectedDocumentReason = hasOrders ? "matched_id_with_orders" : "matched_id";
    } else if (hasOrders) {
      selectedDocumentReason = "selected_same_email_with_orders";
    } else {
      selectedDocumentReason = "selected_latest_same_email";
    }
  } else if (!hasOrders && candidates.length > 1) {
    selectedDocumentReason = "selected_latest_same_email";
  }

  return {
    customer: selected,
    documentsWithSameEmail: candidates.length,
    selectedDocumentReason,
  };
}

export async function findBestCustomerByEmail(rawEmail: string): Promise<CustomerLookupResult> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { customer: null, documentsWithSameEmail: 0, selectedDocumentReason: "not_found" };

  const customers = await Customer.find(emailLookupQuery(email)).lean<CustomerLookupDocument[]>();
  return chooseBestCustomer(customers, { lookupKind: "email" });
}

export async function findBestCustomerByIdOrEmail(rawId: string): Promise<CustomerLookupResult> {
  const id = decodeCustomerLookupId(rawId);
  if (!id) return { customer: null, documentsWithSameEmail: 0, selectedDocumentReason: "not_found" };

  if (mongoose.isValidObjectId(id)) {
    const byId = await Customer.findById(id).lean<CustomerLookupDocument | null>();
    if (byId) {
      const email = normalizeEmail(byId.email ?? "");
      if (!email) {
        return {
          customer: byId,
          documentsWithSameEmail: 1,
          selectedDocumentReason: orderTimelineCount(byId) > 0 ? "matched_id_with_orders" : "matched_id",
        };
      }

      const sameEmailCustomers = await Customer.find(emailLookupQuery(email)).lean<CustomerLookupDocument[]>();
      return chooseBestCustomer([byId, ...sameEmailCustomers], { preferredId: String(byId._id), lookupKind: "id" });
    }
  }

  if (id.includes("@")) {
    return findBestCustomerByEmail(id);
  }

  return { customer: null, documentsWithSameEmail: 0, selectedDocumentReason: "not_found" };
}
