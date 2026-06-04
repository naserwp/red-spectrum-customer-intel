import { normalizeStateCode } from "@/lib/customerBusinessResolver";

export type SortBy = "latestOrder" | "oldestOrder" | "newestCustomer" | "oldestCustomer" | "lifetimeValue" | "monthlyValue" | "yearlyValue" | "lastPaid";

export function normalizedStateParam(value: string | null) {
  if (!value || value.toLowerCase() === "all") return "";
  return normalizeStateCode(value);
}

export function paging(searchParams: URLSearchParams, defaultLimit = 25) {
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? defaultLimit)));
  return { page, limit, skip: (page - 1) * limit };
}

export function dateRangeQuery(searchParams: URLSearchParams, field: string) {
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const range: Record<string, string> = {};
  if (from) range.$gte = `${from}T00:00:00.000Z`;
  if (to) range.$lte = `${to}T23:59:59.999Z`;
  return Object.keys(range).length ? { [field]: range } : {};
}

export function customerSort(searchParams: URLSearchParams): Record<string, 1 | -1> {
  const sortBy = (searchParams.get("sortBy") ?? "lifetimeValue") as SortBy;
  const requestedDir = searchParams.get("sortDir");
  const dir: 1 | -1 = requestedDir === "asc" ? 1 : -1;
  if (sortBy === "latestOrder") return { lastOrderDate: -1, createdAt: -1 };
  if (sortBy === "oldestOrder") return { lastOrderDate: 1, createdAt: 1 };
  if (sortBy === "newestCustomer") return { createdAt: -1 };
  if (sortBy === "oldestCustomer") return { createdAt: 1 };
  if (sortBy === "monthlyValue") return { recurringAmount: dir, lifetimeValue: -1 };
  if (sortBy === "yearlyValue") return { lifetimeValue: dir, rankingPaidTotal: dir };
  if (sortBy === "lastPaid") return { lastPaidDate: dir, latestPaidDate: dir, createdAt: -1 };
  return { lifetimeValue: dir, rankingPaidTotal: dir, paidTotal: dir, totalPaid: dir };
}

export function rankingSort(searchParams: URLSearchParams, period = "all"): Record<string, 1 | -1> {
  const sortBy = searchParams.get("sortBy") || "";
  const dir: 1 | -1 = searchParams.get("sortDir") === "asc" ? 1 : -1;
  if (sortBy === "monthlyValue" || (!sortBy && period === "monthly")) return { monthlySpent: dir, lifetimeSpent: -1 };
  if (sortBy === "yearlyValue" || (!sortBy && period === "yearly")) return { yearlySpent: dir, lifetimeSpent: -1 };
  if (sortBy === "lastPaid") return { latestPaidDate: dir, lifetimeSpent: -1 };
  if (sortBy === "latestOrder") return { latestPaidDate: -1, lifetimeSpent: -1 };
  if (sortBy === "oldestOrder") return { latestPaidDate: 1, lifetimeSpent: -1 };
  if (sortBy === "newestCustomer") return { createdAt: -1 };
  if (sortBy === "oldestCustomer") return { createdAt: 1 };
  return { lifetimeSpent: dir };
}
