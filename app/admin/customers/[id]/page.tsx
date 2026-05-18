"use client";

import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type OrderLineItem = {
  productId: number;
  variationId: number;
  name: string;
  sku: string;
  quantity: number;
  subtotal: number;
  total: number;
  price: number;
};

type GatewayVerification = {
  provider: string;
  matched: boolean;
  confidence: string;
  matchedBy: string;
  transactionId: string;
  transactionStatus: string;
  amount: number;
  transactionDate: string;
  paymentProfileId: string;
  rawSummary: string;
  lastCheckedAt: string;
  configured: boolean;
  notes: string;
};

type OrderHistoryItem = {
  orderId: string;
  orderNumber: string;
  status: string;
  dateCreated: string;
  dateModified: string;
  total: number;
  currency: string;
  paymentMethod: string;
  paymentMethodTitle: string;
  transactionId: string;
  paidDate: string;
  attemptedDate: string;
  isPaid: boolean;
  isAttempted: boolean;
  billingName: string;
  billingEmail: string;
  billingPhone: string;
  billingFirstName?: string;
  billingLastName?: string;
  billingCompany?: string;
  lineItems: OrderLineItem[];
  products?: OrderLineItem[];
  refundsCount: number;
  refundsAmount: number;
  customerNote: string;
  checkoutSource: string;
  source: string;
  gatewayVerification?: GatewayVerification;
};

type CustomerDetail = {
  _id: string;
  name: string;
  email: string;
  phone?: string;
  totalPaid: number;
  paidTotal?: number;
  attemptedTotal?: number;
  paidOrderCount?: number;
  attemptedOrderCount?: number;
  leadStatus?: string;
  paymentStatus?: string;
  lastPaidDate?: string;
  lastAttemptDate?: string;
  lastPaymentMethod?: string;
  lastAttemptPaymentMethod?: string;
  lastAttemptStatus?: string;
  leadUrgency?: string;
  recommendedContactMethod?: string;
  nextAction?: string;
  orders?: OrderHistoryItem[];
  lastProducts?: string[];
  attemptedProducts?: string[];
  paidProducts?: string[];
  gatewayVerification?: GatewayVerification;
  orderCount: number;
  averageOrderValue: number;
  firstOrderDate: string;
  lastOrderDate: string;
  failedPayments: number;
  refunds: number;
  chargebacks: number;
  subscriptionStatus: string;
  score?: number;
  stars?: number;
  tier: string;
  riskLevel: string;
  estimatedCreditLimit: number;
  actualCreditLimit: number | null;
  lastSyncedAt: string;
  aiSummary: string;
  riskExplanation: string;
  recommendedAction: string;
  notes?: string;
  tags?: string[];
};

const money = (value: number) => `$${Number(value ?? 0).toFixed(2)}`;
const displayStatus = (value?: string) => value ? value.replaceAll("_", " ") : "-";
const displayDate = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
};
const displayLongDate = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const displayDateTime = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
};
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const productNames = (order?: OrderHistoryItem, fallback: string[] = []) => {
  const names = (order?.lineItems?.length ? order.lineItems : order?.products ?? []).map((item) => item.name).filter(Boolean);
  return names.length ? names.join(", ") : fallback.length ? fallback.join(", ") : "the selected product";
};

function getOrderType(order: OrderHistoryItem) {
  const status = order.status.toLowerCase();
  const method = `${order.paymentMethod} ${order.paymentMethodTitle}`.toLowerCase();
  if (order.isPaid) return "Paid";
  if (status.includes("crypto") || method.includes("crypto")) return "Crypto Attempt";
  if (status === "failed") return "Failed";
  if (status === "on-hold") return "On Hold";
  if (["pending", "checkout-draft", "payment_pending"].includes(status)) return "Pending";
  return "Attempted";
}

function badgeClass(type: string) {
  if (type === "Paid") return "border-emerald-500/50 bg-emerald-500/15 text-emerald-200";
  if (type === "Failed") return "border-red-500/50 bg-red-500/15 text-red-200";
  if (type === "Crypto Attempt") return "border-purple-500/50 bg-purple-500/15 text-purple-200";
  if (type === "On Hold") return "border-amber-500/50 bg-amber-500/15 text-amber-200";
  if (type === "Pending") return "border-amber-500/50 bg-amber-500/15 text-amber-200";
  return "border-orange-500/50 bg-orange-500/15 text-orange-200";
}

function buildTemplates(customer: CustomerDetail, actualPaid: number, attempted: number, attemptedOrders: OrderHistoryItem[]) {
  const latestAttempt = attemptedOrders[0];
  const products = productNames(latestAttempt, customer.attemptedProducts ?? customer.lastProducts ?? []);
  const shortProduct = products.split(",")[0] || products;
  const attemptDate = displayLongDate(latestAttempt?.attemptedDate || latestAttempt?.dateCreated || customer.lastAttemptDate);
  const attemptAmount = money(attempted);
  const method = latestAttempt?.paymentMethodTitle || latestAttempt?.paymentMethod || customer.lastAttemptPaymentMethod || "payment";
  const status = displayStatus(latestAttempt?.status || customer.lastAttemptStatus);
  const orderNumbers = attemptedOrders.map((order) => `#${order.orderNumber}`).filter(Boolean).join(", ");
  const name = firstName(customer.name);

  if (actualPaid > 0) {
    return {
      email: `Subject: Thanks for your Red Spectrum order\n\nHi ${name},\n\nThank you for your recent order for ${products}. Based on your purchase history, I can help with renewal, support, or matching products that fit your current setup.\n\nBest,\nRed Spectrum Team`,
      sms: `Hi ${name}, this is Red Spectrum. Thanks for your order for ${products}. Want help with setup, renewal, or a matching product recommendation?`,
      call: `Hi ${name}, this is [Rep Name] from Red Spectrum. I am calling to follow up on your purchase of ${products} and see if you need setup help or recommendations for the next best product.`,
      note: `Paid customer. Purchased ${products}. Actual paid total ${money(actualPaid)}. Review upsell, renewal, or support opportunity.`,
    };
  }

  return {
    email: `Subject: Need help completing your Red Spectrum order?\n\nHi ${name},\n\nI noticed you started checkout for ${products} on ${attemptDate}, but the ${method} payment is still ${status} and did not complete.\n\nI can help you finish the order or resend a secure payment link.\n\nWould you like me to help complete the payment?\n\nBest,\nRed Spectrum Team`,
    sms: `Hi ${name}, this is Red Spectrum. Your checkout for ${shortProduct} is still ${status} through ${method}. Want me to resend a secure payment link or help finish it?`,
    call: `Hi ${name}, this is [Rep Name] from Red Spectrum. I am calling because I saw you started checkout for ${shortProduct}, but the ${method} payment is still ${status}. I wanted to see if you need help completing the payment or prefer another payment option.`,
    note: `Very hot lead. ${attemptedOrders.length} ${status} WooCommerce order${attemptedOrders.length === 1 ? "" : "s"} via ${method} on ${attemptDate}. Orders: ${orderNumbers || "N/A"}. Attempted products: ${products}. Attempted total: ${attemptAmount}. Payment not completed. Follow up by phone/SMS and offer secure payment link or alternate payment method. Do not mark as paid until verified.`,
  };
}

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [message, setMessage] = useState("");
  const [subscriptions, setSubscriptions] = useState<Array<Record<string, string | number>>>([]);

  useEffect(() => {
    fetch(`/api/customers/${params.id}`).then((r) => r.json()).then((d) => {
      const nextCustomer = d.customer;
      setCustomer(nextCustomer);
      setNotes(nextCustomer?.notes ?? "");
      setTags((nextCustomer?.tags ?? []).join(", "));
      const email = String(nextCustomer?.email ?? "").toLowerCase();
      fetch("/api/subscriptions?kind=all-real-data&limit=100").then((r2) => r2.json()).then((subs) => {
        setSubscriptions((subs.rows ?? []).filter((row: Record<string, string | number>) => String(row.customerEmail ?? "").toLowerCase() === email));
      });
    });
  }, [params.id]);

  const save = async () => {
    const response = await fetch(`/api/customers/${params.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }) });
    const data = await response.json();
    setMessage(data.message || "Saved");
    setCustomer(data.customer);
  };

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setMessage(`${label} copied.`);
  };

  const attemptedProductRows = useMemo(() => {
    const rows = new Map<string, { name: string; quantity: number; amount: number; lastAttemptDate: string; status: string; paymentMethod: string }>();
    for (const order of customer?.orders?.filter((item) => item.isAttempted) ?? []) {
      const items = order.lineItems.length ? order.lineItems : order.products?.length ? order.products : [{ name: "Unknown product", quantity: 1, total: order.total } as OrderLineItem];
      for (const item of items) {
        const existing = rows.get(item.name);
        const currentDate = order.attemptedDate || order.dateCreated;
        rows.set(item.name, {
          name: item.name,
          quantity: (existing?.quantity ?? 0) + Number(item.quantity ?? 0),
          amount: (existing?.amount ?? 0) + Number(item.total ?? 0),
          lastAttemptDate: !existing || new Date(currentDate).getTime() > new Date(existing.lastAttemptDate).getTime() ? currentDate : existing.lastAttemptDate,
          status: order.status,
          paymentMethod: order.paymentMethodTitle || order.paymentMethod || existing?.paymentMethod || "-",
        });
      }
    }
    return Array.from(rows.values()).sort((a, b) => new Date(b.lastAttemptDate).getTime() - new Date(a.lastAttemptDate).getTime());
  }, [customer]);

  if (!customer) return <main className="min-h-screen bg-black p-8 text-zinc-300">Loading customer details...</main>;

  const orders = [...(customer.orders ?? [])].sort((a, b) => new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime());
  const attemptedOrders = orders.filter((order) => order.isAttempted);
  const actualPaid = Number(customer.paidTotal ?? customer.totalPaid ?? 0);
  const attempted = Number(customer.attemptedTotal ?? 0);
  const templates = buildTemplates(customer, actualPaid, attempted, attemptedOrders);
  const isLead = actualPaid === 0 && attempted > 0;
  const latestRelevantOrder = attemptedOrders[0] ?? orders[0];
  const verification = latestRelevantOrder?.gatewayVerification ?? customer.gatewayVerification;
  const plan = isLead
    ? {
        priority: customer.leadUrgency === "very_high" ? "Very High" : "High",
        bestAction: customer.nextAction || "Call and resend payment link",
        goal: "Help complete payment",
        detail: "Mention the attempted product, offer payment support, and send a secure payment link or invoice. Do not call this lead a paid customer until payment completes.",
      }
    : {
        priority: "Normal",
        bestAction: customer.nextAction || "Review upsell or renewal opportunity",
        goal: "Retain and grow paid customer value",
        detail: "Suggest upsell or cross-sell based on purchased products and use renewal/retention flow if an active subscription exists.",
      };

  return <main className="min-h-screen bg-black p-4 text-base text-zinc-100 md:p-8">
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="text-3xl font-bold text-red-400">{customer.name}</h1>
        <p className="text-zinc-400">{customer.email} - {customer.phone || "N/A"}</p>
      </header>

      <section className="grid gap-3 md:grid-cols-4">
        {[
          ["Actual Paid", money(actualPaid)],
          ["Attempted Amount", money(attempted)],
          ["Paid Orders", customer.paidOrderCount ?? 0],
          ["Attempted Orders", customer.attemptedOrderCount ?? 0],
          ["Lead Status", displayStatus(customer.leadStatus)],
          ["Payment Status", displayStatus(customer.paymentStatus)],
          ["Last Paid", displayDate(customer.lastPaidDate)],
          ["Last Attempt", displayDate(customer.lastAttemptDate)],
          ["Order Count", customer.orderCount],
          ["Average Order Value", money(Number(customer.averageOrderValue ?? 0))],
          ["Risk", customer.riskLevel],
          ["Tier", actualPaid > 0 ? customer.tier : "Lead"],
        ].map(([k, v]) => <div key={String(k)} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"><p className="text-xs font-semibold uppercase text-zinc-400">{k}</p><p className="mt-2 text-xl font-bold">{String(v)}</p></div>)}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-amber-300">Product / Checkout Timeline</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-[1100px] text-sm">
            <thead className="bg-zinc-950"><tr>{["Date", "Order #", "Status", "Payment Method", "Products", "Amount", "Type", "Action"].map((h) => <th key={h} className="px-3 py-2 text-left text-xs uppercase text-zinc-400">{h}</th>)}</tr></thead>
            <tbody>{orders.map((order) => {
              const type = getOrderType(order);
              return <tr key={order.orderId} className="border-t border-zinc-800">
                <td className="px-3 py-3">{displayDateTime(order.dateCreated)}</td>
                <td className="px-3 py-3">{order.orderNumber}</td>
                <td className="px-3 py-3">{displayStatus(order.status)}</td>
                <td className="px-3 py-3">{order.paymentMethodTitle || order.paymentMethod || "-"}</td>
                <td className="px-3 py-3">{productNames(order)}</td>
                <td className="px-3 py-3">{money(order.total)}</td>
                <td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-xs ${badgeClass(type)}`}>{type}</span></td>
                <td className="px-3 py-3">{order.isPaid ? "Review retention" : "Recover checkout"}</td>
              </tr>;
            })}</tbody>
          </table>
          {orders.length === 0 && <p className="p-3 text-zinc-400">No WooCommerce order timeline has been synced for this customer yet.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-orange-300">Products Attempted</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3">{attemptedProductRows.map((product) => <div key={product.name} className="rounded border border-orange-500/30 bg-orange-500/10 p-3">
          <p className="font-semibold">{product.name}</p>
          <p className="text-sm text-zinc-300">Qty: {product.quantity}</p>
          <p className="text-sm text-zinc-300">Attempted: {money(product.amount)}</p>
          <p className="text-sm text-zinc-400">Last attempt: {displayDate(product.lastAttemptDate)}</p>
          <p className="text-sm text-zinc-400">Status: {displayStatus(product.status)}</p>
          <p className="text-sm text-zinc-400">Payment method: {product.paymentMethod}</p>
        </div>)}</div>
        {attemptedProductRows.length === 0 && <p className="mt-2 text-zinc-400">No attempted products found.</p>}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-sky-300">Payment Verification</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div><p className="text-xs uppercase text-zinc-400">WooCommerce Status</p><p className="font-semibold">{displayStatus(latestRelevantOrder?.status || customer.lastAttemptStatus)}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">WooCommerce Method</p><p className="font-semibold">{latestRelevantOrder?.paymentMethodTitle || latestRelevantOrder?.paymentMethod || customer.lastAttemptPaymentMethod || "-"}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Gateway Provider</p><p className="font-semibold">{verification?.provider || "-"}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Gateway Status</p><p className="font-semibold">{verification?.matched ? "Payment verified" : verification?.transactionStatus || "Not verified"}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Confidence</p><p className="font-semibold">{verification?.confidence || "not_found"}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Matched By</p><p className="font-semibold">{verification?.matchedBy || "-"}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Last Checked</p><p className="font-semibold">{displayDateTime(verification?.lastCheckedAt)}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Recommended</p><p className="font-semibold">{verification?.matched ? "Payment verified" : "Manual follow-up"}</p></div>
        </div>
        <p className="mt-3 text-zinc-300">{verification?.notes || "Manual verification required."}</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-red-300">Sales Executive Follow-Up Plan</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div><p className="text-xs uppercase text-zinc-400">Priority</p><p className="font-semibold">{plan.priority}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Best Action</p><p className="font-semibold">{plan.bestAction}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Contact Method</p><p className="font-semibold">{customer.recommendedContactMethod || "email"}</p></div>
          <div><p className="text-xs uppercase text-zinc-400">Goal</p><p className="font-semibold">{plan.goal}</p></div>
        </div>
        <p className="mt-3 text-zinc-300">{plan.detail}</p>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-xl font-semibold text-emerald-300">Follow-Up Templates</h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {[
            ["Email Template", templates.email],
            ["SMS Template", templates.sms],
            ["Call Script", templates.call],
            ["Internal CRM Note", templates.note],
          ].map(([label, text]) => <div key={label} className="rounded border border-zinc-700 bg-zinc-950 p-3">
            <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{label}</h3><button onClick={() => copy(text, label)} className="rounded bg-zinc-700 px-2 py-1 text-sm">Copy</button></div>
            <pre className="mt-2 whitespace-pre-wrap text-sm text-zinc-300">{text}</pre>
          </div>)}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"><h2 className="font-semibold text-red-300">Internal Review</h2><input className="mt-2 w-full rounded bg-zinc-800 p-2" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, separated, by commas" /><textarea className="mt-2 h-32 w-full rounded bg-zinc-800 p-2" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes" /><button className="mt-2 rounded bg-red-700 px-4 py-2" onClick={save}>Save Notes</button>{message && <p className="mt-2 text-emerald-300">{message}</p>}</section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"><h2 className="font-semibold text-amber-300">Subscriptions and Candidates</h2><div className="mt-2 space-y-2">{subscriptions.length === 0 ? <p className="text-zinc-400">No linked subscription or recurring product candidate records.</p> : subscriptions.map((sub) => <div key={String(sub.subscriptionId)} className="rounded border border-zinc-700 p-2 text-sm"><p className="font-semibold">{String(sub.source)} - {String(sub.subscriptionId)}</p><p>Status: {String(sub.status)} | Amount: {String(sub.amount)} | Next Bill: {String(sub.nextBillingDate || "N/A")}</p></div>)}</div></section>
    </div>
  </main>;
}
