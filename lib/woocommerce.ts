const WC_STORE_URL = process.env.WC_STORE_URL ?? "";
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY ?? "";
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET ?? "";

type WooCommerceMeta = {
  key?: string;
  value?: unknown;
};

export type WooCommerceAddress = {
  first_name?: string;
  last_name?: string;
  company?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  email?: string;
  phone?: string;
};

export type WooCommerceRefund = {
  id?: number;
  total?: string;
};

export type WooCommerceLineItem = {
  product_id?: number;
  variation_id?: number;
  name?: string;
  sku?: string;
  quantity?: number;
  subtotal?: string;
  total?: string;
  price?: number;
};

export type WooCommerceCustomer = {
  id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  billing?: WooCommerceAddress;
};

export type WooCommerceOrder = {
  id: number;
  number?: string;
  customer_id?: number;
  status?: string;
  total?: string;
  currency?: string;
  date_created?: string;
  date_modified?: string;
  date_paid?: string;
  payment_method?: string;
  payment_method_title?: string;
  transaction_id?: string;
  customer_note?: string;
  billing?: WooCommerceAddress;
  refunds?: WooCommerceRefund[];
  meta_data?: WooCommerceMeta[];
  line_items?: WooCommerceLineItem[];
};

export type WooCommerceFetchResult<T> = {
  items: T[];
  totalFetched: number;
  pagesFetched: number;
  reachedPageLimit: boolean;
  maxPages: number;
  partialSync: boolean;
  warning: string;
  fetchedByStatus: Record<string, number>;
  pagesFetchedByStatus: Record<string, number>;
  failedRequests: Array<{ status: string; page: number; message: string }>;
};

type WooCommerceFetchOptions = {
  email?: string;
  search?: string;
  customerId?: number;
  statuses?: string[];
  maxPages?: number;
  perPage?: number;
  signal?: AbortSignal;
  after?: string;
  before?: string;
};

export const wooCommerceOrderStatuses = ["completed", "processing", "pending", "failed", "cancelled", "on-hold", "checkout-draft", "refunded"];

function getWooCommerceConfig() {
  if (!WC_STORE_URL || !WC_CONSUMER_KEY || !WC_CONSUMER_SECRET) {
    console.warn(
      "[woocommerce] WC_STORE_URL, WC_CONSUMER_KEY, and WC_CONSUMER_SECRET are required for WooCommerce sync."
    );
    return null;
  }

  return {
    storeUrl: WC_STORE_URL.replace(/\/+$/, ""),
    consumerKey: WC_CONSUMER_KEY,
    consumerSecret: WC_CONSUMER_SECRET,
  };
}

export function isWooCommerceConfigured() {
  return Boolean(WC_STORE_URL && WC_CONSUMER_KEY && WC_CONSUMER_SECRET);
}

function getNumericEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchWithTimeout(url: URL, headers: HeadersInit, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, {
      headers,
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function fetchWooCommerceCollection<T>(resource: "customers" | "orders", options: WooCommerceFetchOptions = {}): Promise<WooCommerceFetchResult<T> | null> {
  const config = getWooCommerceConfig();
  if (!config) return null;

  const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
  const results: T[] = [];
  const perPage = Math.min(100, Math.max(1, options.perPage ?? getNumericEnv("WC_PER_PAGE", 100)));
  const maxPages = Math.max(1, options.maxPages ?? getNumericEnv("WC_MAX_PAGES", 25));
  const timeoutMs = getNumericEnv("WC_REQUEST_TIMEOUT_MS", 12000);
  const statuses = resource === "orders" ? options.statuses ?? wooCommerceOrderStatuses : [""];
  const seen = new Set<string>();
  const fetchedByStatus: Record<string, number> = {};
  const pagesFetchedByStatus: Record<string, number> = {};
  const failedRequests: Array<{ status: string; page: number; message: string }> = [];
  let totalPagesFetched = 0;
  let reachedPageLimit = false;
  let partialSync = false;

  for (const status of statuses) {
    if (options.signal?.aborted) break;
    fetchedByStatus[status || "all"] = 0;
    pagesFetchedByStatus[status || "all"] = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      if (options.signal?.aborted) break;
      const url = new URL(`${config.storeUrl}/wp-json/wc/v3/${resource}`);
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("page", String(page));
      if (resource === "orders" && status) {
        url.searchParams.set("status", status);
      }
      if (resource === "orders" && options.email) {
        url.searchParams.set("search", options.email);
      }
      if (options.search) {
        url.searchParams.set("search", options.search);
      }
      if (resource === "orders" && options.customerId) {
        url.searchParams.set("customer", String(options.customerId));
      }
      if (resource === "orders" && options.after) {
        url.searchParams.set("after", options.after);
      }
      if (resource === "orders" && options.before) {
        url.searchParams.set("before", options.before);
      }

      try {
        const response = await fetchWithTimeout(url, {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        }, timeoutMs, options.signal);

        if (!response.ok) {
          const message = `${response.status} ${response.statusText}`;
          failedRequests.push({ status: status || "all", page, message });
          partialSync = true;
          break;
        }

        const pageResults = (await response.json()) as T[];
        totalPagesFetched += 1;
        pagesFetchedByStatus[status || "all"] = page;

        for (const item of pageResults) {
          const maybeId = (item as { id?: number | string }).id;
          const key = maybeId === undefined ? `${status}-${page}-${fetchedByStatus[status || "all"]}` : String(maybeId);
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(item);
          fetchedByStatus[status || "all"] += 1;
        }

        if (pageResults.length < perPage) break;
        if (page === maxPages) {
          reachedPageLimit = true;
          partialSync = true;
        }
      } catch (error) {
        if (options.signal?.aborted) {
          partialSync = true;
          break;
        }
        const message = error instanceof Error ? error.message : "Unknown WooCommerce request error.";
        failedRequests.push({ status: status || "all", page, message });
        partialSync = true;
        break;
      }
    }
  }

  const warningParts = [];
  if (reachedPageLimit) warningParts.push("Partial sync, reached page limit.");
  if (failedRequests.length > 0) warningParts.push("Partial sync, one or more WooCommerce status pages failed or timed out.");
  return {
    items: results,
    totalFetched: results.length,
    pagesFetched: totalPagesFetched,
    reachedPageLimit,
    maxPages,
    partialSync,
    warning: warningParts.join(" "),
    fetchedByStatus,
    pagesFetchedByStatus,
    failedRequests,
  };
}

export function fetchWooCommerceCustomers(options: WooCommerceFetchOptions = {}) {
  return fetchWooCommerceCollection<WooCommerceCustomer>("customers", options);
}

export function fetchWooCommerceOrders(options: WooCommerceFetchOptions = {}) {
  return fetchWooCommerceCollection<WooCommerceOrder>("orders", options);
}
