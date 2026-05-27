import {
  collectBusinessNameFields as collectSharedBusinessNameFields,
  normalizeBusinessName,
  resolveCustomerBusinessName,
  type BusinessNameField,
  type ResolvedBusinessName,
} from "@/lib/customerBusinessResolver";

function withLatestOrders(customer: unknown, extraOrders: unknown[]) {
  if (!extraOrders.length || !customer || typeof customer !== "object") return customer;
  return { ...(customer as Record<string, unknown>), latestWooOrders: extraOrders };
}

export type { BusinessNameField, ResolvedBusinessName };
export { normalizeBusinessName };

export function collectBusinessNameFields(customer: unknown, extraOrders: unknown[] = []) {
  return collectSharedBusinessNameFields(withLatestOrders(customer, extraOrders));
}

export function resolveBusinessName(customer: unknown): ResolvedBusinessName;
export function resolveBusinessName(customer: unknown, extraOrders: unknown[]): ResolvedBusinessName;
export function resolveBusinessName(customer: unknown, extraOrders?: unknown[]) {
  return resolveCustomerBusinessName(withLatestOrders(customer, extraOrders ?? []));
}
