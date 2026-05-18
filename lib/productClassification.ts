import type { CustomerOrderHistoryItem, CustomerOrderLineItem } from "@/models/Customer";

export type ProductCategory = "base_product" | "boost" | "design_or_setup" | "other";
export type ProductJourneyType = "paid" | "attempted";

export type ProductClassification = {
  category: ProductCategory;
  productType: string;
  isBaseProduct: boolean;
  isBoost: boolean;
  isAddOn: boolean;
  normalizedName: string;
};

export type ProductJourneyItem = {
  date: string;
  orderNumber: string;
  status: string;
  paymentMethod: string;
  productName: string;
  category: ProductCategory;
  productType: string;
  amount: number;
  type: ProductJourneyType;
};

export type ProductJourneySummary = {
  firstSignupOrderNumber: string;
  firstSignupDate: string;
  firstSignupAmount: number;
  firstSignupProduct: string;
  baseProductsPurchased: string[];
  boostProductsPurchased: string[];
  addOnProductsPurchased: string[];
  attemptedBaseProducts: string[];
  attemptedBoostProducts: string[];
  attemptedAddOnProducts: string[];
  lastPurchasedProduct: string;
  lastAttemptedProduct: string;
  productJourney: ProductJourneyItem[];
};

const emptyProductSummary: ProductJourneySummary = {
  firstSignupOrderNumber: "",
  firstSignupDate: "",
  firstSignupAmount: 0,
  firstSignupProduct: "",
  baseProductsPurchased: [],
  boostProductsPurchased: [],
  addOnProductsPurchased: [],
  attemptedBaseProducts: [],
  attemptedBoostProducts: [],
  attemptedAddOnProducts: [],
  lastPurchasedProduct: "",
  lastAttemptedProduct: "",
  productJourney: [],
};

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function unique(values: string[]) {
  return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
}

function lineItemAmount(item: CustomerOrderLineItem, orderTotal: number, itemCount: number) {
  const total = Number(item.total ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  const subtotal = Number(item.subtotal ?? 0);
  if (Number.isFinite(subtotal) && subtotal > 0) return subtotal;
  const price = Number(item.price ?? 0);
  const quantity = Number(item.quantity ?? 0);
  if (Number.isFinite(price) && Number.isFinite(quantity) && price > 0 && quantity > 0) return price * quantity;
  return itemCount === 1 ? orderTotal : 0;
}

export function classifyProduct(input: Pick<CustomerOrderLineItem, "name" | "sku" | "productId">): ProductClassification {
  const normalizedName = normalizeText(input.name || "Unknown product");
  const lookup = `${normalizedName} ${input.sku ?? ""} ${input.productId ?? ""}`.toLowerCase();

  if (
    lookup.includes("business builder") ||
    lookup.includes("build your business credit")
  ) {
    return {
      category: "base_product",
      productType: "Base Signup Product",
      isBaseProduct: true,
      isBoost: false,
      isAddOn: false,
      normalizedName,
    };
  }

  if (
    lookup.includes("silver boost") ||
    lookup.includes("gold boost") ||
    lookup.includes("premium boost") ||
    /\bboost\b/.test(lookup)
  ) {
    return {
      category: "boost",
      productType: "Boost",
      isBaseProduct: false,
      isBoost: true,
      isAddOn: true,
      normalizedName,
    };
  }

  if (
    lookup.includes("logo design") ||
    lookup.includes("website") ||
    lookup.includes("setup")
  ) {
    return {
      category: "design_or_setup",
      productType: "Design/Setup Add-on",
      isBaseProduct: false,
      isBoost: false,
      isAddOn: true,
      normalizedName,
    };
  }

  return {
    category: "other",
    productType: "Other",
    isBaseProduct: false,
    isBoost: false,
    isAddOn: false,
    normalizedName,
  };
}

export function buildProductJourneySummary(orders: CustomerOrderHistoryItem[]): ProductJourneySummary {
  const chronologicalOrders = [...orders].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime());
  const productJourney = chronologicalOrders.flatMap((order) => {
    const lineItems = order.lineItems?.length ? order.lineItems : order.products ?? [];
    return lineItems.map((item) => {
      const classification = classifyProduct(item);
      return {
        date: order.isPaid ? order.paidDate || order.dateCreated : order.attemptedDate || order.dateCreated,
        orderNumber: order.orderNumber,
        status: order.status,
        paymentMethod: order.paymentMethodTitle || order.paymentMethod || "",
        productName: classification.normalizedName,
        category: classification.category,
        productType: classification.productType,
        amount: lineItemAmount(item, Number(order.total ?? 0), lineItems.length),
        type: order.isPaid ? "paid" : "attempted",
      } satisfies ProductJourneyItem;
    });
  });

  const paidEvents = productJourney.filter((item) => item.type === "paid");
  const attemptedEvents = productJourney.filter((item) => item.type === "attempted");
  const firstSignup = paidEvents.find((item) => item.category === "base_product");
  const latestPaid = [...paidEvents].reverse()[0];
  const latestAttempt = [...attemptedEvents].reverse()[0];

  return {
    ...emptyProductSummary,
    firstSignupOrderNumber: firstSignup?.orderNumber ?? "",
    firstSignupDate: firstSignup?.date ?? "",
    firstSignupAmount: firstSignup?.amount ?? 0,
    firstSignupProduct: firstSignup?.productName ?? "",
    baseProductsPurchased: unique(paidEvents.filter((item) => item.category === "base_product").map((item) => item.productName)),
    boostProductsPurchased: unique(paidEvents.filter((item) => item.category === "boost").map((item) => item.productName)),
    addOnProductsPurchased: unique(paidEvents.filter((item) => item.category === "design_or_setup").map((item) => item.productName)),
    attemptedBaseProducts: unique(attemptedEvents.filter((item) => item.category === "base_product").map((item) => item.productName)),
    attemptedBoostProducts: unique(attemptedEvents.filter((item) => item.category === "boost").map((item) => item.productName)),
    attemptedAddOnProducts: unique(attemptedEvents.filter((item) => item.category === "design_or_setup").map((item) => item.productName)),
    lastPurchasedProduct: latestPaid?.productName ?? "",
    lastAttemptedProduct: latestAttempt?.productName ?? "",
    productJourney,
  };
}
