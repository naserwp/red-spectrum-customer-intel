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
  email?: string;
  phone?: string;
};

export type WooCommerceRefund = {
  id?: number;
  total?: string;
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
  status?: string;
  total?: string;
  date_created?: string;
  billing?: WooCommerceAddress;
  refunds?: WooCommerceRefund[];
  meta_data?: WooCommerceMeta[];
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

async function fetchWooCommerceCollection<T>(resource: "customers" | "orders") {
  const config = getWooCommerceConfig();
  if (!config) return null;

  const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString("base64");
  const results: T[] = [];

  try {
    for (let page = 1; page <= 10; page += 1) {
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
      results.push(...pageResults);

      if (pageResults.length < 100) break;
    }

    return results;
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
