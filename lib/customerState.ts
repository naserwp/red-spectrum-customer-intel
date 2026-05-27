import {
  buildStateOptions,
  collectCustomerStateFields as collectSharedCustomerStateFields,
  normalizeStateCode,
  resolveCustomerState as resolveSharedCustomerState,
  stateNameForCode,
  type CustomerStateField,
  type ResolvedCustomerState,
  type StateOption,
} from "@/lib/customerBusinessResolver";

function withLatestOrders(customer: unknown, extraOrders: unknown[]) {
  if (!extraOrders.length || !customer || typeof customer !== "object") return customer;
  return { ...(customer as Record<string, unknown>), latestWooOrders: extraOrders };
}

export type { CustomerStateField, ResolvedCustomerState, StateOption };
export { buildStateOptions, normalizeStateCode, stateNameForCode };

export function collectCustomerStateFields(customer: unknown, extraOrders: unknown[] = []) {
  return collectSharedCustomerStateFields(withLatestOrders(customer, extraOrders));
}

export function resolveCustomerState(customer: unknown): ResolvedCustomerState;
export function resolveCustomerState(customer: unknown, extraOrders: unknown[]): ResolvedCustomerState;
export function resolveCustomerState(customer: unknown, extraOrders?: unknown[]) {
  return resolveSharedCustomerState(withLatestOrders(customer, extraOrders ?? []));
}

export function resolveCustomerStateCode(customer: unknown, extraOrders: unknown[] = []) {
  return resolveCustomerState(customer, extraOrders).stateCode;
}
