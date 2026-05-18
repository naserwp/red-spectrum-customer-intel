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
};

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

async function fetchWooCommerceCollection<T>(resource: "customers" | "orders"): Promise<WooCommerceFetchResult<T> | null> {
  const config = getWooCommerceConfig();
  if (!config) return null;

  const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
  const results: T[] = [];
  const maxPages = Math.max(1, Number(process.env.WC_MAX_PAGES ?? 100));
  let pagesFetched = 0;
  let reachedPageLimit = false;

  try {
    for (let page = 1; page <= maxPages; page += 1) {
      const url = new URL(`${config.storeUrl}/wp-json/wc/v3/${resource}`);
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      if (resource === "orders") {
        url.searchParams.set("status", "any");
      }

      const response = await fetch(url, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
        },
        cache: "no-store",
      });

      if (!response.ok) {
        console.warn(`[woocommerce] Failed to fetch ${resource}: ${response.status} ${response.statusText}`);
        return null;
      }

      const pageResults = (await response.json()) as T[];
      pagesFetched = page;
      results.push(...pageResults);

      if (pageResults.length < 100) break;
      if (page === maxPages) reachedPageLimit = true;
    }

    return { items: results, totalFetched: results.length, pagesFetched, reachedPageLimit, maxPages };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown WooCommerce request error.";
    console.warn(`[woocommerce] Failed to fetch ${resource}. ${message}`);
    return null;
  }
}

export function fetchWooCommerceCustomers() {
  return fetchWooCommerceCollection<WooCommerceCustomer>("customers");
}

export function fetchWooCommerceOrders() {
  return fetchWooCommerceCollection<WooCommerceOrder>("orders");
}
