"use client";

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Customer = {
  _id: string; name: string; email: string; phone: string; totalPaid: number; paidTotal?: number; attemptedTotal?: number;
  paidOrderCount?: number; attemptedOrderCount?: number; leadStatus?: string; paymentStatus?: string; lastPaidDate?: string; lastAttemptDate?: string;
  activeSubscriptions: number; failedPayments: number; chargebacks: number; estimatedCreditLimit: number; tier: string; riskLevel: string;
  score: number; stars: number; aiSummaryPreview: string; aiSummary: string; subscriptionStatus: string; orderCount: number; averageOrderValue: number;
  firstOrderDate: string; lastOrderDate: string; refunds: number; riskExplanation: string; recommendedAction: string;
  attemptedProducts?: string[]; lastAttemptedProduct?: string;
};

type Subscription = {
  _id?: string; subscriptionId: string; source: string; customerEmail: string; customerName: string; status: string; amount: number;
  monthlyRecurringRevenue?: number; billingInterval?: string; nextBillingDate?: string; lastBillingDate?: string; failedPaymentCount?: number;
  lastPaymentStatus?: string; sourceStatus?: string; recordType?: string; productNames?: string[]; startDate?: string; paymentMethodTitle?: string;
};

type RecurringCandidate = {
  customerName: string;
  customerEmail: string;
  product: string;
  paidMonths: number;
  lastPaid: string;
  averageAmount: number;
  suggestedReview: string;
};

type SalesMetric = {
  period: string; paidRevenue: number; attemptedPipeline: number; paidOrders: number; attemptedOrders: number; failedPayments: number;
  refunds: number; chargebacks: number; newPaidCustomers: number; newLeads: number; averageOrderValue: number;
};

type GatewayProvider = "all" | "authorize_net" | "nmi" | "stripe" | "crypto" | "woocommerce" | "unknown";
type GatewayStatus = "all" | "paid" | "attempted" | "failed" | "refunded" | "verified" | "not_verified";
type GatewayInterval = "lifetime" | "year" | "month" | "week" | "day";
type GatewayRange = "lifetime" | "year" | "month" | "last30" | "custom";

type GatewaySummaryMetric = {
  totalPaidRevenue: number; totalAttemptedPipeline: number; totalFailedAmount: number; totalRefundedAmount: number;
  totalOrders: number; paidOrders: number; attemptedOrders: number; failedOrders: number; verifiedRevenue: number;
  unverifiedPaidRevenue: number; manualReviewRevenue: number; providersCount: number;
};

type GatewayProviderMetric = {
  provider: string; paidRevenue: number; attemptedPipeline: number; failedAmount: number; refundedAmount: number;
  totalOrders: number; paidOrders: number; attemptedOrders: number; failedOrders: number; verifiedRevenue: number;
  unverifiedPaidRevenue: number; manualReviewRevenue: number; matchedOrders: number; unmatchedOrders: number; lastTransactionDate: string;
};

type GatewayTimelineMetric = {
  period: string; provider: string; paidRevenue: number; attemptedPipeline: number; failedAmount: number; refundedAmount: number;
  paidOrders: number; attemptedOrders: number; failedOrders: number; verifiedRevenue: number; unverifiedPaidRevenue: number;
};

type GatewayCustomerMetric = {
  provider: string; customerName: string; email: string; paidRevenue: number; attemptedPipeline: number; orderCount: number; lastOrderDate: string;
};

type GatewayAnalytics = {
  summary: GatewaySummaryMetric;
  byProvider: GatewayProviderMetric[];
  timeline: GatewayTimelineMetric[];
  topCustomersByGateway: GatewayCustomerMetric[];
};

type SyncRunResult = {
  jobId?: string;
  dryRun?: boolean;
  pagesFetched?: number;
  ordersFetched?: number;
  ordersUpserted?: number;
  subscriptionsFetched?: number;
  subscriptionsUpserted?: number;
  transactionsFetched?: number;
  transactionsUpserted?: number;
  transactionsProcessed?: number;
  transactionsMatched?: number;
  customersUpdated?: number;
  customersProcessed?: number;
  customersRebuilt?: number;
  dryRunCustomersMatched?: number;
  customersSkippedSmallerHistory?: number;
  hasMore?: boolean;
  nextOffset?: number;
  warnings?: string[];
  failedRequests?: Array<{ status: string; page: number; message: string }>;
  message?: string;
};

type SyncLastRun = {
  action: string;
  status: string;
  ordersImported: number;
  subscriptionsImported?: number;
  customersUpdated: number;
  gatewayTransactionsImported?: number;
  warnings: string[];
  lastRunTime: string;
};

type RebuildBatchState = {
  hasMore: boolean;
  nextOffset: number;
  dryRun: boolean;
};

type AuthNetBatchState = {
  hasMore: boolean;
  nextOffset: number;
  action: "import" | "reconcile";
};

type SyncStepResult = {
  hasMore: boolean;
  nextCursor?: Record<string, unknown>;
  progressLabel?: string;
  ordersImported?: number;
  customersUpdated?: number;
  subscriptionsImported?: number;
  authorizeNetTransactionsImported?: number;
  authorizeNetPaymentsReconciled?: number;
  warnings?: string[];
};

type SyncStatus = {
  lastSyncAt?: string;
  dataFreshness?: string;
  counts?: { customers?: number; wooOrders?: number; wooSubscriptions?: number; authorizeNetTransactions?: number };
};

const tabs = ["Overview", "Customers", "Subscriptions", "Upcoming Bills", "High Value", "Hot Leads", "Risk Review", "Gateway Analytics", "5-Year Sales", "Sync Center"] as const;
const pageSizes = [25, 50, 100] as const;
const rebuildBatchSize = 50;
const slowRequestMessage = "This request is taking longer than expected. Try again or narrow the search.";
const highValueThreshold = 2000;
const money = (n: number) => `$${n.toFixed(2)}`;
const paidAmount = (c: Customer) => Number(c.paidTotal ?? c.totalPaid ?? 0);
const attemptedAmount = (c: Customer) => Number(c.attemptedTotal ?? 0);
const customerDetailHref = (c: Customer) => `/admin/customers/${encodeURIComponent(c.email || c._id)}`;
const displayStatus = (value?: string) => value ? value.replaceAll("_", " ") : "-";
const displayDate = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
};
const displayDateTime = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
};
const dateInput = (date: Date) => date.toISOString().slice(0, 10);
const monthSpan = (start?: string) => {
  const startDate = start ? new Date(start) : null;
  if (!startDate || Number.isNaN(startDate.getTime())) return 0;
  const now = new Date();
  return Math.max(0, (now.getFullYear() - startDate.getFullYear()) * 12 + now.getMonth() - startDate.getMonth() + 1);
};

const gatewayProviderLabel: Record<string, string> = {
  all: "All",
  authorize_net: "Authorize.net",
  nmi: "NMI/Cliq",
  stripe: "Stripe",
  crypto: "Crypto",
  woocommerce: "WooCommerce/Manual",
  unknown: "Unknown",
};

const gatewayStatusLabel: Record<string, string> = {
  all: "All",
  paid: "Paid",
  attempted: "Attempted",
  failed: "Failed",
  refunded: "Refunded",
  verified: "Verified",
  not_verified: "Not Verified",
};

function csvCell(value: string | number) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function getCustomerCategory(c: Customer) {
  if (paidAmount(c) >= highValueThreshold) return "vip_paid";
  if (paidAmount(c) > 0) return "paying";
  if (attemptedAmount(c) >= highValueThreshold) return "very_hot_lead";
  if (attemptedAmount(c) > 0) return "hot_lead";
  return "cold_lead";
}

const categoryLabel: Record<string, string> = {
  vip_paid: "VIP Paid Customer",
  paying: "Paying Customer",
  very_hot_lead: "Very Hot Lead",
  hot_lead: "Hot Lead",
  cold_lead: "Cold Lead",
};

const badgeClass: Record<string, string> = {
  vip_paid: "bg-amber-500/20 text-amber-200 border-amber-500/50",
  paying: "bg-emerald-500/20 text-emerald-200 border-emerald-500/50",
  very_hot_lead: "bg-red-600/20 text-red-200 border-red-600/50",
  hot_lead: "bg-orange-600/20 text-orange-200 border-orange-600/50",
  cold_lead: "bg-zinc-700/30 text-zinc-200 border-zinc-600/60",
};

function usePagedRows<T>(rows: T[], size: number) {
  const [page, setPage] = useState(1);
  const total = rows.length;
  const maxPage = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(page, maxPage);
  const start = total === 0 ? 0 : (safePage - 1) * size + 1;
  const end = Math.min(total, safePage * size);
  return {
    page: safePage,
    setPage,
    total,
    start,
    end,
    rows: rows.slice((safePage - 1) * size, safePage * size),
    maxPage,
  };
}

function Card({ label, value, helper }: { label: string; value: string | number; helper?: string }) {
  return <div className="rounded-xl border border-zinc-800 bg-zinc-900/85 p-4 shadow-lg shadow-black/20 ring-1 ring-red-950/10">
    <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{label}</p>
    <p className="mt-2 text-2xl font-bold text-white md:text-3xl">{value}</p>
    {helper && <p className="mt-1 text-xs text-zinc-500">{helper}</p>}
  </div>;
}

function Pager({ start, end, total, page, maxPage, setPage }: { start: number; end: number; total: number; page: number; maxPage: number; setPage: (p: number) => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-400">
    <p>Showing {start}-{end} of {total}</p>
    <div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded bg-zinc-800 px-3 py-1 disabled:opacity-50">Previous</button><button disabled={page >= maxPage} onClick={() => setPage(page + 1)} className="rounded bg-zinc-800 px-3 py-1 disabled:opacity-50">Next</button></div>
  </div>;
}

function CustomerTable({ rows, exportCustomerPdf }: { rows: Customer[]; exportCustomerPdf: (c: Customer) => void }) {
  if (rows.length === 0) return <p className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-zinc-400">No customer profiles found. Go to Sync Center and run Import WooCommerce Orders, then Update Customer Profiles.</p>;
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[1750px] table-fixed text-sm">
      <thead className="sticky top-0 bg-zinc-950"><tr>{["Customer", "Category", "Tier", "Actual Paid", "Attempted Pipeline", "Paid Orders", "Attempted Orders", "Start", "Tenure", "Payment Status", "Lead Status", "Last Paid", "Last Attempt", "Risk", "Score", "Preview", "Actions"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
      <tbody>{rows.map((c) => {
        const cat = getCustomerCategory(c);
        return <tr key={c._id} className={`border-t border-zinc-800 ${cat === "vip_paid" ? "bg-amber-500/5" : cat.includes("hot") ? "bg-orange-500/5" : ""}`}>
          <td className="w-56 px-3 py-3"><p className="truncate font-semibold">{c.name}</p><p className="truncate text-xs text-zinc-400">{c.email}</p></td>
          <td className="px-3 py-3"><span className={`inline-flex rounded border px-2 py-1 text-xs ${badgeClass[cat]}`}>{categoryLabel[cat]}</span></td>
          <td className="px-3 py-3">{paidAmount(c) > 0 ? c.tier : "Lead"}</td>
          <td className="px-3 py-3 font-semibold">{money(paidAmount(c))}</td>
          <td className="px-3 py-3">{money(attemptedAmount(c))}</td>
          <td className="px-3 py-3">{c.paidOrderCount ?? 0}</td>
          <td className="px-3 py-3">{c.attemptedOrderCount ?? 0}</td>
          <td className="px-3 py-3">{displayDate(c.firstOrderDate)}</td>
          <td className="px-3 py-3">{monthSpan(c.firstOrderDate)} mo</td>
          <td className="px-3 py-3">{displayStatus(c.paymentStatus)}</td>
          <td className="px-3 py-3">{displayStatus(c.leadStatus)}</td>
          <td className="px-3 py-3">{displayDate(c.lastPaidDate)}</td>
          <td className="px-3 py-3">{displayDate(c.lastAttemptDate)}</td>
          <td className="px-3 py-3">{c.riskLevel}</td>
          <td className="px-3 py-3">{c.score}/{c.stars}</td>
          <td className="truncate px-3 py-3">{c.aiSummaryPreview}</td>
          <td className="px-3 py-3"><div className="flex gap-2"><Link className="rounded bg-zinc-700 px-2 py-1" href={customerDetailHref(c)}>View</Link><button onClick={() => exportCustomerPdf(c)} className="rounded bg-red-700 px-2 py-1">PDF</button></div></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function HotLeadsTable({ rows }: { rows: Customer[] }) {
  if (rows.length === 0) return <p className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-zinc-400">No hot checkout leads found. Run Import WooCommerce Orders, then Update Customer Profiles.</p>;
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[1100px] text-sm">
      <thead className="sticky top-0 bg-zinc-950"><tr>{["Customer", "Attempted Pipeline", "Attempted Orders", "Last Attempt", "Payment Status", "Lead Status", "Products Attempted", "Action"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
      <tbody>{rows.map((c) => <tr key={c._id} className="border-t border-zinc-800 bg-orange-500/5">
        <td className="px-3 py-3"><p className="font-semibold">{c.name || c.email}</p><p className="text-xs text-zinc-400">{c.email || c._id}</p></td>
        <td className="px-3 py-3 font-semibold">{money(attemptedAmount(c))}</td>
        <td className="px-3 py-3">{c.attemptedOrderCount ?? 0}</td>
        <td className="px-3 py-3">{displayDate(c.lastAttemptDate)}</td>
        <td className="px-3 py-3">{displayStatus(c.paymentStatus)}</td>
        <td className="px-3 py-3">{displayStatus(c.leadStatus)}</td>
        <td className="px-3 py-3">{(c.attemptedProducts?.length ? c.attemptedProducts : c.lastAttemptedProduct ? [c.lastAttemptedProduct] : []).join(", ") || "-"}</td>
        <td className="px-3 py-3"><Link className="rounded bg-zinc-700 px-2 py-1" href={customerDetailHref(c)}>View</Link></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function RecurringCandidatesTable({ rows }: { rows: RecurringCandidate[] }) {
  if (rows.length === 0) return <p className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-zinc-400">No recurring candidates found yet.</p>;
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[950px] text-sm">
      <thead className="sticky top-0 bg-zinc-950"><tr>{["Customer", "Product", "Paid Months", "Last Paid", "Average Amount", "Suggested Review"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.customerEmail}-${row.product}`} className="border-t border-zinc-800">
        <td className="px-3 py-3"><p className="font-semibold">{row.customerName || row.customerEmail}</p><p className="text-xs text-zinc-400">{row.customerEmail}</p></td>
        <td className="px-3 py-3">{row.product}</td>
        <td className="px-3 py-3">{row.paidMonths}</td>
        <td className="px-3 py-3">{displayDate(row.lastPaid)}</td>
        <td className="px-3 py-3">{money(Number(row.averageAmount ?? 0))}</td>
        <td className="px-3 py-3">{row.suggestedReview}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function SubscriptionTable({ rows }: { rows: Subscription[] }) {
  if (rows.length === 0) return <p className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-zinc-400">No subscription records found.</p>;
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[1200px] text-sm">
      <thead className="sticky top-0 bg-zinc-950"><tr>{["Customer", "Product", "Status", "Amount", "MRR", "Start Date", "Next Payment", "Last Payment", "Payment Method", "Action"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
      <tbody>{rows.map((s) => {
        return <tr key={s._id ?? s.subscriptionId} className="border-t border-zinc-800">
          <td className="px-3 py-3"><p className="font-semibold">{s.customerName || "-"}</p><p className="text-xs text-zinc-400">{s.customerEmail}</p></td>
          <td className="px-3 py-3">{s.productNames?.join(", ") || s.source}</td>
          <td className="px-3 py-3">{displayStatus(s.status)}</td>
          <td className="px-3 py-3">{money(Number(s.amount ?? 0))}</td>
          <td className="px-3 py-3">{money(Number(s.monthlyRecurringRevenue ?? 0))}</td>
          <td className="px-3 py-3">{displayDate(s.startDate)}</td>
          <td className="px-3 py-3">{displayDate(s.nextBillingDate)}</td>
          <td className="px-3 py-3">{displayDate(s.lastBillingDate)}</td>
          <td className="px-3 py-3">{displayStatus(s.paymentMethodTitle || s.lastPaymentStatus)}</td>
          <td className="px-3 py-3"><Link className="rounded bg-zinc-700 px-2 py-1" href={`/admin/customers/${encodeURIComponent(s.customerEmail || s.subscriptionId)}`}>View</Link></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function ValueIndex({ rows, rankOffset = 0 }: { rows: Customer[]; rankOffset?: number }) {
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[1150px] text-sm">
      <thead className="sticky top-0 bg-zinc-950"><tr>{["Rank", "Customer", "Customer Lifetime Value", "Start", "Paid Months", "Stay With Us", "Last Paid", "Attempted Pipeline", "Category", "Action"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
      <tbody>{rows.map((c, index) => {
        const cat = getCustomerCategory(c);
        return <tr key={c._id} className="border-t border-zinc-800">
          <td className="px-3 py-3 font-semibold">#{rankOffset + index + 1}</td>
          <td className="px-3 py-3"><p className="font-semibold">{c.name}</p><p className="text-xs text-zinc-400">{c.email}</p></td>
          <td className="px-3 py-3 font-semibold">{money(paidAmount(c))}</td>
          <td className="px-3 py-3">{displayDate(c.firstOrderDate)}</td>
          <td className="px-3 py-3">{c.paidOrderCount ?? 0}</td>
          <td className="px-3 py-3">{monthSpan(c.firstOrderDate)} months</td>
          <td className="px-3 py-3">{displayDate(c.lastPaidDate || c.lastOrderDate)}</td>
          <td className="px-3 py-3">{money(attemptedAmount(c))}</td>
          <td className="px-3 py-3"><span className={`inline-flex rounded border px-2 py-1 text-xs ${badgeClass[cat]}`}>{categoryLabel[cat]}</span></td>
          <td className="px-3 py-3"><Link className="rounded bg-zinc-700 px-2 py-1" href={customerDetailHref(c)}>View</Link></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function SalesHistoryTable({ rows }: { rows: SalesMetric[] }) {
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[1200px] text-sm">
      <thead className="sticky top-0 bg-zinc-950"><tr>{["Year", "Paid Revenue", "Attempted Pipeline", "Paid Orders", "Attempted Orders", "Failed Payments", "Refunds", "Chargebacks", "New Paid Customers", "New Leads", "Average Order Value"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.period} className="border-t border-zinc-800">
        <td className="px-3 py-3 font-semibold">{r.period}</td>
        <td className="px-3 py-3">{money(r.paidRevenue)}</td>
        <td className="px-3 py-3">{money(r.attemptedPipeline)}</td>
        <td className="px-3 py-3">{r.paidOrders}</td>
        <td className="px-3 py-3">{r.attemptedOrders}</td>
        <td className="px-3 py-3">{r.failedPayments}</td>
        <td className="px-3 py-3">{r.refunds}</td>
        <td className="px-3 py-3">{r.chargebacks}</td>
        <td className="px-3 py-3">{r.newPaidCustomers}</td>
        <td className="px-3 py-3">{r.newLeads}</td>
        <td className="px-3 py-3">{money(r.averageOrderValue)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function exportGatewayCsv(data: GatewayAnalytics | null) {
  if (!data) return;
  const rows: Array<Array<string | number>> = [
    ["Section", "Provider", "Period", "Customer", "Email", "Paid Revenue", "Attempted Pipeline", "Verified Revenue", "Unverified Paid", "Failed Amount", "Paid Orders", "Attempted Orders", "Matched Orders", "Unmatched Orders", "Last Transaction"],
    ...data.byProvider.map((row) => [
      "Gateway Summary",
      gatewayProviderLabel[row.provider] ?? row.provider,
      "",
      "",
      "",
      row.paidRevenue,
      row.attemptedPipeline,
      row.verifiedRevenue,
      row.unverifiedPaidRevenue,
      row.failedAmount,
      row.paidOrders,
      row.attemptedOrders,
      row.matchedOrders,
      row.unmatchedOrders,
      row.lastTransactionDate,
    ]),
    ...data.timeline.map((row) => [
      "Timeline",
      gatewayProviderLabel[row.provider] ?? row.provider,
      row.period,
      "",
      "",
      row.paidRevenue,
      row.attemptedPipeline,
      row.verifiedRevenue,
      row.unverifiedPaidRevenue,
      row.failedAmount,
      row.paidOrders,
      row.attemptedOrders,
      "",
      "",
      "",
    ]),
  ];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `gateway-analytics-${dateInput(new Date())}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function GatewayAnalyticsView({
  data,
  range,
  setRange,
  from,
  setFrom,
  to,
  setTo,
  interval,
  setInterval,
  provider,
  setProvider,
  status,
  setStatus,
  reload,
}: {
  data: GatewayAnalytics | null;
  range: GatewayRange;
  setRange: (value: GatewayRange) => void;
  from: string;
  setFrom: (value: string) => void;
  to: string;
  setTo: (value: string) => void;
  interval: GatewayInterval;
  setInterval: (value: GatewayInterval) => void;
  provider: GatewayProvider;
  setProvider: (value: GatewayProvider) => void;
  status: GatewayStatus;
  setStatus: (value: GatewayStatus) => void;
  reload: () => void;
}) {
  const summary = data?.summary;
  const rangeButtons: Array<[GatewayRange, string]> = [["lifetime", "Lifetime"], ["year", "This Year"], ["month", "This Month"], ["last30", "Last 30 Days"], ["custom", "Custom"]];
  const providerOptions: GatewayProvider[] = ["all", "authorize_net", "nmi", "stripe", "crypto", "woocommerce", "unknown"];
  const statusOptions: GatewayStatus[] = ["all", "paid", "attempted", "failed", "refunded", "verified", "not_verified"];
  const intervalOptions: GatewayInterval[] = ["lifetime", "year", "month", "week", "day"];

  return <section className="space-y-4">
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-2">
          {rangeButtons.map(([value, label]) => <button key={value} onClick={() => setRange(value)} className={`rounded px-3 py-2 text-sm font-semibold ${range === value ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}>{label}</button>)}
        </div>
        <label className="text-xs uppercase text-zinc-400">From<input type="date" value={from} onChange={(event) => { setRange("custom"); setFrom(event.target.value); }} className="mt-1 block rounded bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-800" /></label>
        <label className="text-xs uppercase text-zinc-400">To<input type="date" value={to} onChange={(event) => { setRange("custom"); setTo(event.target.value); }} className="mt-1 block rounded bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-800" /></label>
        <label className="text-xs uppercase text-zinc-400">Provider<select value={provider} onChange={(event) => setProvider(event.target.value as GatewayProvider)} className="mt-1 block rounded bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-800">{providerOptions.map((value) => <option key={value} value={value}>{gatewayProviderLabel[value]}</option>)}</select></label>
        <label className="text-xs uppercase text-zinc-400">Status<select value={status} onChange={(event) => setStatus(event.target.value as GatewayStatus)} className="mt-1 block rounded bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-800">{statusOptions.map((value) => <option key={value} value={value}>{gatewayStatusLabel[value]}</option>)}</select></label>
        <label className="text-xs uppercase text-zinc-400">Interval<select value={interval} onChange={(event) => setInterval(event.target.value as GatewayInterval)} className="mt-1 block rounded bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-1 ring-zinc-800">{intervalOptions.map((value) => <option key={value} value={value}>{displayStatus(value)}</option>)}</select></label>
        <button onClick={reload} className="rounded bg-zinc-700 px-4 py-2 text-sm font-semibold hover:bg-zinc-600">Refresh</button>
        <button onClick={() => exportGatewayCsv(data)} disabled={!data} className="rounded bg-emerald-700 px-4 py-2 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-50">Export CSV</button>
      </div>
    </div>

    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card label={range === "lifetime" ? "Lifetime Paid Revenue" : "Paid Revenue"} value={money(Number(summary?.totalPaidRevenue ?? 0))} helper="completed/processing/paid only" />
      <Card label="Attempted Pipeline" value={money(Number(summary?.totalAttemptedPipeline ?? 0))} helper="unpaid/failed/on-hold checkout attempts" />
      <Card label="Verified Revenue" value={money(Number(summary?.verifiedRevenue ?? 0))} helper="matched gateway transactions" />
      <Card label="Unverified Paid Revenue" value={money(Number(summary?.unverifiedPaidRevenue ?? 0))} helper="WooCommerce paid, not gateway verified yet" />
      <Card label="Failed Payments" value={money(Number(summary?.totalFailedAmount ?? 0))} helper={`${Number(summary?.failedOrders ?? 0)} failed orders`} />
      <Card label="Manual Review Amount" value={money(Number(summary?.manualReviewRevenue ?? 0))} helper="low/not_found confidence or unknown provider" />
      <Card label="Total Orders" value={Number(summary?.totalOrders ?? 0)} helper={`${Number(summary?.providersCount ?? 0)} active providers`} />
      <Card label="Paid Orders" value={Number(summary?.paidOrders ?? 0)} helper={`${Number(summary?.attemptedOrders ?? 0)} attempted orders`} />
    </section>

    <section className="space-y-2">
      <h2 className="text-xl font-semibold text-zinc-100">Gateway Summary</h2>
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="min-w-[1400px] text-sm">
          <thead className="sticky top-0 bg-zinc-950"><tr>{["Gateway", "Paid Revenue", "Attempted Pipeline", "Verified Revenue", "Unverified Paid", "Failed Amount", "Paid Orders", "Attempted Orders", "Matched Orders", "Unmatched Orders", "Last Transaction"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
          <tbody>{(data?.byProvider ?? []).map((row) => <tr key={row.provider} className="border-t border-zinc-800">
            <td className="px-3 py-3 font-semibold">{gatewayProviderLabel[row.provider] ?? row.provider}</td>
            <td className="px-3 py-3">{money(row.paidRevenue)}</td>
            <td className="px-3 py-3">{money(row.attemptedPipeline)}</td>
            <td className="px-3 py-3">{money(row.verifiedRevenue)}</td>
            <td className="px-3 py-3">{money(row.unverifiedPaidRevenue)}</td>
            <td className="px-3 py-3">{money(row.failedAmount)}</td>
            <td className="px-3 py-3">{row.paidOrders}</td>
            <td className="px-3 py-3">{row.attemptedOrders}</td>
            <td className="px-3 py-3">{row.matchedOrders}</td>
            <td className="px-3 py-3">{row.unmatchedOrders}</td>
            <td className="px-3 py-3">{displayDate(row.lastTransactionDate)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>

    <section className="space-y-2">
      <h2 className="text-xl font-semibold text-zinc-100">Monthly / Weekly Timeline</h2>
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="min-w-[1200px] text-sm">
          <thead className="sticky top-0 bg-zinc-950"><tr>{["Period", "Gateway", "Paid Revenue", "Attempted Pipeline", "Failed Amount", "Verified Revenue", "Paid Orders", "Attempted Orders"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
          <tbody>{(data?.timeline ?? []).map((row) => <tr key={`${row.period}-${row.provider}`} className="border-t border-zinc-800">
            <td className="px-3 py-3 font-semibold">{row.period}</td>
            <td className="px-3 py-3">{gatewayProviderLabel[row.provider] ?? row.provider}</td>
            <td className="px-3 py-3">{money(row.paidRevenue)}</td>
            <td className="px-3 py-3">{money(row.attemptedPipeline)}</td>
            <td className="px-3 py-3">{money(row.failedAmount)}</td>
            <td className="px-3 py-3">{money(row.verifiedRevenue)}</td>
            <td className="px-3 py-3">{row.paidOrders}</td>
            <td className="px-3 py-3">{row.attemptedOrders}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>

    <section className="space-y-2">
      <h2 className="text-xl font-semibold text-zinc-100">Top Customers by Gateway</h2>
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="min-w-[1100px] text-sm">
          <thead className="sticky top-0 bg-zinc-950"><tr>{["Gateway", "Customer", "Email", "Paid Revenue", "Attempted Pipeline", "Orders", "Last Order Date", "View Customer"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
          <tbody>{(data?.topCustomersByGateway ?? []).map((row) => <tr key={`${row.provider}-${row.email}`} className="border-t border-zinc-800">
            <td className="px-3 py-3">{gatewayProviderLabel[row.provider] ?? row.provider}</td>
            <td className="px-3 py-3 font-semibold">{row.customerName}</td>
            <td className="px-3 py-3 text-zinc-400">{row.email}</td>
            <td className="px-3 py-3">{money(row.paidRevenue)}</td>
            <td className="px-3 py-3">{money(row.attemptedPipeline)}</td>
            <td className="px-3 py-3">{row.orderCount}</td>
            <td className="px-3 py-3">{displayDate(row.lastOrderDate)}</td>
            <td className="px-3 py-3"><Link className="rounded bg-zinc-700 px-2 py-1" href={`/admin/customers/${encodeURIComponent(row.email)}`}>View</Link></td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
  </section>;
}

export default function AdminPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown>>({});
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionCandidates, setSubscriptionCandidates] = useState<Subscription[]>([]);
  const [upcomingBills, setUpcomingBills] = useState<Subscription[]>([]);
  const [recurringCandidates, setRecurringCandidates] = useState<RecurringCandidate[]>([]);
  const [hotLeadRows, setHotLeadRows] = useState<Customer[]>([]);
  const [riskRows, setRiskRows] = useState<Customer[]>([]);
  const [salesHistory, setSalesHistory] = useState<SalesMetric[]>([]);
  const [gatewayAnalytics, setGatewayAnalytics] = useState<GatewayAnalytics | null>(null);
  const [gatewayRange, setGatewayRange] = useState<GatewayRange>("lifetime");
  const [gatewayFrom, setGatewayFrom] = useState("2019-01-01");
  const [gatewayTo, setGatewayTo] = useState(dateInput(new Date()));
  const [gatewayInterval, setGatewayInterval] = useState<GatewayInterval>("month");
  const [gatewayProvider, setGatewayProvider] = useState<GatewayProvider>("all");
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>("all");
  const [upcomingMeta, setUpcomingMeta] = useState<Record<string, unknown>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [requestWarning, setRequestWarning] = useState("");
  const [tabLoading, setTabLoading] = useState<Record<string, boolean>>({});
  const [syncRunning, setSyncRunning] = useState(false);
  const [advancedToolsOpen, setAdvancedToolsOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncResult, setSyncResult] = useState<SyncRunResult | null>(null);
  const [syncLastRun, setSyncLastRun] = useState<SyncLastRun | null>(null);
  const [rebuildBatch, setRebuildBatch] = useState<RebuildBatchState | null>(null);
  const [authNetBatch, setAuthNetBatch] = useState<AuthNetBatchState | null>(null);
  const [importedOrdersCount, setImportedOrdersCount] = useState(0);
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(50);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const requestControllers = useRef(new Map<string, { controller: AbortController; key: string }>());
  const stopSyncRef = useRef(false);

  const fetchJson = useCallback(async (scope: string, url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"}:${url}:${typeof init?.body === "string" ? init.body : ""}`;
    const existing = requestControllers.current.get(scope);
    if (existing?.key === key) return null;
    existing?.controller.abort();

    const controller = new AbortController();
    requestControllers.current.set(scope, { controller, key });
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15000);
    try {
      const response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Request failed.");
      return data;
    } catch (fetchError) {
      if (controller.signal.aborted) {
        if (timedOut) setRequestWarning(slowRequestMessage);
        return null;
      }
      throw fetchError;
    } finally {
      window.clearTimeout(timeout);
      const current = requestControllers.current.get(scope);
      if (current?.key === key) requestControllers.current.delete(scope);
    }
  }, []);

  useEffect(() => () => {
    requestControllers.current.forEach(({ controller }) => controller.abort());
    requestControllers.current.clear();
  }, []);

  const loadCustomers = useCallback(async (nextPage = 1, query = appliedSearch, nextPageSize = pageSize) => {
    const params = new URLSearchParams({ page: String(nextPage), limit: String(nextPageSize) });
    if (query.trim()) params.set("q", query.trim());
    const data = await fetchJson("customers-table", `/api/customers/table?${params.toString()}`);
    if (!data) return;
    setCustomers(data.rows || []);
    setTotal(data.total || 0);
    setPage(data.page || nextPage);
  }, [appliedSearch, fetchJson, pageSize]);

  const loadHotLeads = useCallback(async (query = appliedSearch) => {
    const params = new URLSearchParams({ kind: "hot-leads", limit: "100" });
    if (query.trim()) params.set("q", query.trim());
    const data = await fetchJson("hot-leads", `/api/customers/table?${params.toString()}`);
    if (!data) return;
    setHotLeadRows(data.rows || []);
  }, [appliedSearch, fetchJson]);

  const loadSummary = useCallback(async () => {
    const summaryData = await fetchJson("summary", "/api/analytics/summary");
    if (!summaryData) return;
    setSummary(summaryData || {});
  }, [fetchJson]);

  const loadSyncStatus = useCallback(async () => {
    const statusData = await fetchJson("sync-status", "/api/sync/status");
    if (!statusData) return;
    setSyncStatus(statusData);
  }, [fetchJson]);

  const loadSubscriptions = useCallback(async () => {
    const [subscriptionData, candidateData] = await Promise.all([
      fetchJson("subscriptions-real", "/api/subscriptions?kind=real&limit=100"),
      fetchJson("subscriptions-candidates", "/api/subscriptions?kind=candidates&limit=100"),
    ]);
    if (subscriptionData) setSubscriptions(subscriptionData.rows || []);
    if (candidateData) setSubscriptionCandidates(candidateData.rows || []);
  }, [fetchJson]);

  const loadUpcomingBills = useCallback(async () => {
    const upcomingData = await fetchJson("upcoming-bills", "/api/upcoming-bills");
    if (!upcomingData) return;
    setUpcomingBills(upcomingData.rows || []);
    setRecurringCandidates(upcomingData.recurringCandidates || []);
    setUpcomingMeta(upcomingData || {});
  }, [fetchJson]);

  const loadRiskRows = useCallback(async () => {
    const riskData = await fetchJson("risk-customers", "/api/risk-customers");
    if (!riskData) return;
    setRiskRows(riskData.rows || []);
  }, [fetchJson]);

  const loadSalesHistory = useCallback(async () => {
    const salesData = await fetchJson("sales-history", "/api/analytics/sales-history?years=5");
    if (!salesData) return;
    setSalesHistory(salesData.yearly || []);
  }, [fetchJson]);

  const applyGatewayRange = useCallback((range: GatewayRange) => {
    const now = new Date();
    setGatewayRange(range);
    if (range === "lifetime") {
      setGatewayFrom("2019-01-01");
      setGatewayTo(dateInput(now));
      setGatewayInterval("month");
      return;
    }
    if (range === "year") {
      setGatewayFrom(`${now.getFullYear()}-01-01`);
      setGatewayTo(dateInput(now));
      setGatewayInterval("month");
      return;
    }
    if (range === "month") {
      setGatewayFrom(dateInput(new Date(now.getFullYear(), now.getMonth(), 1)));
      setGatewayTo(dateInput(now));
      setGatewayInterval("day");
      return;
    }
    if (range === "last30") {
      setGatewayFrom(dateInput(new Date(now.getTime() - 30 * 86400000)));
      setGatewayTo(dateInput(now));
      setGatewayInterval("day");
    }
  }, []);

  const loadGatewayData = useCallback(async () => {
    const params = new URLSearchParams({
      from: gatewayFrom || "2019-01-01",
      to: gatewayTo || dateInput(new Date()),
      interval: gatewayInterval,
      provider: gatewayProvider,
      status: gatewayStatus,
    });
    const data = await fetchJson("gateway-analytics", `/api/analytics/gateways?${params.toString()}`);
    if (!data) return;
    setGatewayAnalytics(data);
  }, [fetchJson, gatewayFrom, gatewayTo, gatewayInterval, gatewayProvider, gatewayStatus]);

  const loadActiveTab = useCallback(async (activeTab: (typeof tabs)[number], options?: { page?: number; query?: string; pageSize?: (typeof pageSizes)[number] }) => {
    const nextPage = options?.page ?? 1;
    const query = options?.query ?? appliedSearch;
    const nextPageSize = options?.pageSize ?? pageSize;
    setTabLoading((current) => ({ ...current, [activeTab]: true }));
    try {
      if (activeTab === "Overview") await Promise.all([loadSummary(), loadCustomers(nextPage, query, nextPageSize)]);
      else if (activeTab === "Customers") await loadCustomers(nextPage, query, nextPageSize);
      else if (activeTab === "Subscriptions") await Promise.all([loadSummary(), loadSubscriptions()]);
      else if (activeTab === "Upcoming Bills") await Promise.all([loadSummary(), loadUpcomingBills()]);
      else if (activeTab === "Hot Leads") await Promise.all([loadSummary(), loadHotLeads(query)]);
      else if (activeTab === "Risk Review") await Promise.all([loadSummary(), loadRiskRows()]);
      else if (activeTab === "Gateway Analytics") await loadGatewayData();
      else if (activeTab === "5-Year Sales") await Promise.all([loadSummary(), loadSalesHistory()]);
      else if (activeTab === "High Value") await Promise.all([loadSummary(), loadCustomers(nextPage, query, nextPageSize)]);
    } finally {
      setTabLoading((current) => ({ ...current, [activeTab]: false }));
    }
  }, [appliedSearch, loadCustomers, loadGatewayData, loadHotLeads, loadRiskRows, loadSalesHistory, loadSubscriptions, loadSummary, loadUpcomingBills, pageSize]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadActiveTab(tab, { page: 1, query: appliedSearch }).catch(() => setError("Unable to load dashboard data."));
  }, [tab, loadActiveTab, appliedSearch]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSyncStatus().catch(() => undefined);
  }, [loadSyncStatus]);

  const handleApplySearch = () => {
    const query = search.trim();
    setMessage("");
    setRequestWarning("");
    setError("");
    setPage(1);
    if (query === appliedSearch) {
      loadActiveTab(tab, { page: 1, query }).catch(() => setError("Unable to load dashboard data."));
      return;
    }
    setAppliedSearch(query);
  };

  const handleTabChange = (nextTab: (typeof tabs)[number]) => {
    setMessage("");
    setRequestWarning("");
    setTab(nextTab);
  };

  const runSyncNow = async () => {
    setError("");
    setMessage("Starting sync...");
    setSyncRunning(true);
    stopSyncRef.current = false;
    let cursor: Record<string, unknown> | undefined;
    const totals = { ordersImported: 0, customersUpdated: 0, subscriptionsImported: 0, authorizeNetTransactionsImported: 0, authorizeNetPaymentsReconciled: 0 };
    const warnings: string[] = [];
    try {
      for (let step = 0; step < 250; step += 1) {
        if (stopSyncRef.current) {
          setMessage("Sync stopped.");
          break;
        }
        const data = await fetchJson("sync-run-step", "/api/sync/run-step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cursor }),
        }) as SyncStepResult | null;
        if (!data) {
          warnings.push("Sync step did not return a response.");
          break;
        }
        totals.ordersImported += Number(data.ordersImported ?? 0);
        totals.customersUpdated += Number(data.customersUpdated ?? 0);
        totals.subscriptionsImported += Number(data.subscriptionsImported ?? 0);
        totals.authorizeNetTransactionsImported += Number(data.authorizeNetTransactionsImported ?? 0);
        totals.authorizeNetPaymentsReconciled += Number(data.authorizeNetPaymentsReconciled ?? 0);
        warnings.push(...(data.warnings ?? []).filter(Boolean));
        cursor = data.nextCursor;
        setMessage(data.progressLabel || "Sync step complete.");
        if (!data.hasMore) {
          setMessage(`Sync complete. Orders: ${totals.ordersImported}. Customers updated: ${totals.customersUpdated}. Subscriptions: ${totals.subscriptionsImported}. Authorize.net transactions: ${totals.authorizeNetTransactionsImported}.`);
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
      setSyncLastRun({
        action: "Sync Now",
        status: warnings.length ? "Completed with warnings" : "Completed",
        ordersImported: totals.ordersImported,
        subscriptionsImported: totals.subscriptionsImported,
        gatewayTransactionsImported: totals.authorizeNetTransactionsImported,
        customersUpdated: totals.customersUpdated,
        warnings,
        lastRunTime: new Date().toLocaleString(),
      });
      await Promise.all([loadSyncStatus(), loadActiveTab(tab, { page: 1, query: appliedSearch })]);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Sync failed.");
    } finally {
      setSyncRunning(false);
      stopSyncRef.current = false;
    }
  };

  const stopSyncNow = () => {
    stopSyncRef.current = true;
    requestControllers.current.get("sync-run-step")?.controller.abort();
    setSyncRunning(false);
  };

  const syncWooCommerce = async () => {
    setError("");
    setMessage("Sync in progress...");
    const res = await fetch("/api/customers/sync", { method: "POST" });
    const data = await res.json();
    if (!res.ok) return setError(data.error || "Sync failed");
    const warning = data.warning ? ` ${data.warning}` : "";
    setMessage(`${data.message || "Sync completed"} Orders fetched: ${data.totalOrdersFetched ?? 0}. Paid orders: ${data.paidOrders ?? 0}. Unpaid orders: ${data.unpaidOrders ?? 0}.${warning}`);
    await loadActiveTab(tab, { page: 1, query: appliedSearch });
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };

  const runOrderBackfill = async (dryRun: boolean) => {
    setError("");
    setMessage(dryRun ? "Testing WooCommerce order import..." : "Importing WooCommerce orders...");
    const res = await fetch("/api/woocommerce/backfill-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "2019-01-01",
        to: dateInput(new Date()),
        perPage: 25,
        maxPages: 1,
        dryRun,
      }),
    });
    const data = await res.json();
    setSyncResult(data);
    if (!res.ok) return setError(data.error || "Backfill failed");
    const ordersImported = Number(data.ordersUpserted ?? 0);
    if (!dryRun) setImportedOrdersCount(ordersImported);
    const successMessage = dryRun
      ? "Test complete. WooCommerce connection is working."
      : `Imported ${ordersImported} WooCommerce orders.`;
    setMessage(successMessage);
    setSyncLastRun({
      action: dryRun ? "Test WooCommerce Order Import" : "Import WooCommerce Orders",
      status: data.partialSync ? "Completed with warnings" : "Completed",
      ordersImported: dryRun ? 0 : ordersImported,
      customersUpdated: 0,
      warnings: data.warnings ?? [],
      lastRunTime: new Date().toLocaleString(),
    });
    await loadActiveTab(tab, { page: 1, query: appliedSearch });
  };

  const runSubscriptionBackfill = async (dryRun: boolean) => {
    setError("");
    setMessage(dryRun ? "Testing WooCommerce subscription import..." : "Importing WooCommerce subscriptions...");
    const res = await fetch("/api/woocommerce/backfill-subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        perPage: 25,
        maxPages: 1,
        dryRun,
      }),
    });
    const data = await res.json();
    setSyncResult(data);
    if (!res.ok) return setError(data.error || "Subscription import failed");
    const subscriptionsImported = Number(data.subscriptionsUpserted ?? 0);
    const successMessage = dryRun
      ? "Test complete. WooCommerce subscription connection is working."
      : data.partialSync && Number(data.subscriptionsFetched ?? 0) === 0
        ? "No WooCommerce subscriptions were imported. Check warnings for endpoint availability."
        : `Imported ${subscriptionsImported} WooCommerce subscriptions.`;
    setMessage(successMessage);
    setSyncLastRun({
      action: dryRun ? "Test WooCommerce Subscription Import" : "Import WooCommerce Subscriptions",
      status: data.partialSync ? "Completed with warnings" : "Completed",
      ordersImported: 0,
      subscriptionsImported: dryRun ? 0 : subscriptionsImported,
      customersUpdated: 0,
      warnings: data.warnings ?? [],
      lastRunTime: new Date().toLocaleString(),
    });
    await loadActiveTab(tab, { page: 1, query: appliedSearch });
  };

  const runAuthorizeNetImport = async (offset = 0) => {
    setError("");
    setMessage("Importing Authorize.net transactions...");
    const res = await fetch("/api/authorize-net/backfill-transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "2024-01-01",
        to: dateInput(new Date()),
        limit: 50,
        offset,
        dryRun: false,
      }),
    });
    const data = await res.json();
    setSyncResult(data);
    if (!res.ok) return setError(data.error || "Authorize.net import failed");
    const imported = Number(data.transactionsUpserted ?? 0);
    setMessage(data.hasMore ? `Imported ${imported} Authorize.net transactions. Continue import to process next batch.` : `Imported ${imported} Authorize.net transactions.`);
    setAuthNetBatch(data.hasMore ? { hasMore: true, nextOffset: Number(data.nextOffset ?? offset + 50), action: "import" } : null);
    setSyncLastRun({
      action: "Import Authorize.net Transactions",
      status: data.warnings?.length ? "Completed with warnings" : "Completed",
      ordersImported: 0,
      customersUpdated: 0,
      gatewayTransactionsImported: imported,
      warnings: data.warnings ?? [],
      lastRunTime: new Date().toLocaleString(),
    });
    await loadActiveTab(tab, { page: 1, query: appliedSearch });
  };

  const runAuthorizeNetReconcile = async (offset = 0) => {
    setError("");
    setMessage("Reconciling Authorize.net payments...");
    const res = await fetch("/api/authorize-net/reconcile-customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: 50,
        offset,
        dryRun: false,
      }),
    });
    const data = await res.json();
    setSyncResult(data);
    if (!res.ok) return setError(data.error || "Authorize.net reconciliation failed");
    const updated = Number(data.customersUpdated ?? 0);
    setMessage(String(data.message || `Updated ${updated} customer payment records.`));
    setAuthNetBatch(data.hasMore ? { hasMore: true, nextOffset: Number(data.nextOffset ?? offset + 50), action: "reconcile" } : null);
    setSyncLastRun({
      action: "Reconcile Authorize.net Payments",
      status: data.warnings?.length ? "Completed with warnings" : "Completed",
      ordersImported: 0,
      customersUpdated: updated,
      warnings: data.warnings ?? [],
      lastRunTime: new Date().toLocaleString(),
    });
    await loadActiveTab(tab, { page: 1, query: appliedSearch });
  };

  const runCustomerRebuild = async (dryRun: boolean, offset = 0) => {
    setError("");
    if (!dryRun && importedOrdersCount === 0) {
      setError("Run Import WooCommerce Orders before updating customer profiles. If this is a new browser session, run Test WooCommerce Order Import first to confirm available orders.");
      return;
    }
    setMessage(dryRun ? "Previewing customer profile update..." : "Updating customer profiles...");
    const res = await fetch("/api/customers/rebuild-from-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "2019-01-01",
        to: dateInput(new Date()),
        limit: rebuildBatchSize,
        offset,
        dryRun,
      }),
    });
    const data = await res.json();
    setSyncResult(data);
    if (!res.ok) return setError(data.error || "Customer rebuild failed");
    const customersUpdated = Number(data.customersRebuilt ?? data.dryRunCustomersMatched ?? 0);
    const processed = Number(data.customersProcessed ?? 0);
    const successMessage = String(data.message || (data.hasMore ? `Processed ${processed} customers. Continue update to process next batch.` : `Processed ${processed} customers.`));
    setMessage(successMessage);
    setRebuildBatch(data.hasMore ? { hasMore: true, nextOffset: Number(data.nextOffset ?? offset + processed), dryRun } : null);
    setSyncLastRun({
      action: dryRun ? "Preview Customer Profile Update" : "Update Customer Profiles",
      status: data.partialSync ? "Completed with warnings" : "Completed",
      ordersImported: 0,
      customersUpdated: dryRun ? 0 : customersUpdated,
      warnings: data.warnings ?? [],
      lastRunTime: new Date().toLocaleString(),
    });
    await loadActiveTab(tab, { page: 1, query: appliedSearch });
  };

  const exportCustomerPdf = (c: Customer) => {
    const doc = new jsPDF();
    doc.text(`Customer - ${c.name}`, 14, 16);
    autoTable(doc, {
      startY: 24,
      head: [["Metric", "Value"]],
      body: [
        ["Email", c.email],
        ["Actual Paid Amount", money(paidAmount(c))],
        ["Attempted Amount", money(attemptedAmount(c))],
        ["Paid Order Count", String(c.paidOrderCount ?? 0)],
        ["Attempted Order Count", String(c.attemptedOrderCount ?? 0)],
        ["Lead Status", displayStatus(c.leadStatus)],
        ["Payment Status", displayStatus(c.paymentStatus)],
        ["Last Paid Date", displayDate(c.lastPaidDate)],
        ["Last Attempt Date", displayDate(c.lastAttemptDate)],
        ["Subscription Status", c.subscriptionStatus || "unknown"],
        ["Customer Lifetime Value", money(paidAmount(c))],
        ["Tenure", `${monthSpan(c.firstOrderDate)} months`],
      ],
    });
    doc.save(`customer-${c.email}.pdf`);
  };

  const customerStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const customerEnd = Math.min(total, page * pageSize);
  const customerMaxPage = Math.max(1, Math.ceil(total / pageSize));
  const highValueRows = useMemo(() => customers.filter((c) => paidAmount(c) >= highValueThreshold).sort((a, b) => paidAmount(b) - paidAmount(a)), [customers]);
  const riskDisplayRows = riskRows.length ? riskRows : customers.filter((c) => c.riskLevel === "high" || c.failedPayments > 0 || c.chargebacks > 0);
  const highValuePage = usePagedRows(highValueRows, pageSize);
  const hotLeadPage = usePagedRows(hotLeadRows, pageSize);
  const riskPage = usePagedRows(riskDisplayRows, pageSize);
  const subPage = usePagedRows(subscriptions, pageSize);
  const candidatePage = usePagedRows(subscriptionCandidates, pageSize);
  const upcomingPage = usePagedRows(upcomingBills, pageSize);
  const salesPage = usePagedRows(salesHistory, pageSize);

  return <main className="min-h-screen bg-[radial-gradient(circle_at_top,#22070b_0,#09090b_34%,#000_100%)] p-4 text-base text-zinc-100 md:p-8">
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="rounded-2xl border border-red-950/60 bg-zinc-950/90 p-5 shadow-xl shadow-black/30">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-red-400">Red Spectrum</p>
            <h1 className="mt-2 text-3xl font-bold text-white md:text-4xl">Customer Intelligence</h1>
            <p className="mt-1 text-sm text-zinc-400">Paid revenue, subscription status, checkout pipeline, and customer risk.</p>
            <p className="mt-2 text-xs text-zinc-500">{syncStatus?.lastSyncAt ? `Last synced: ${displayDateTime(syncStatus.lastSyncAt)}` : syncStatus?.dataFreshness || "Data sync needed"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => handleTabChange("Sync Center")} className="rounded-lg bg-red-600 px-5 py-3 font-semibold text-white shadow-lg shadow-red-950/30 transition hover:bg-red-500">Sync Center</button>
            <button onClick={logout} className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-3 font-semibold text-zinc-200 transition hover:border-red-800 hover:bg-zinc-800">Logout</button>
          </div>
        </div>
      </header>
      <nav className="sticky top-0 z-10 flex gap-2 overflow-auto rounded-xl border border-red-950/40 bg-zinc-950/95 p-3 shadow-lg shadow-black/30 backdrop-blur">{tabs.map((t) => <button key={t} onClick={() => handleTabChange(t)} className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition ${tab === t ? "bg-red-600 text-white shadow-lg shadow-red-950/50 ring-1 ring-red-400/30" : "border border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-red-900 hover:bg-zinc-800 hover:text-white"}`}>{t}</button>)}</nav>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/80 p-3">
        <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} onKeyDown={(e) => { if (e.key === "Enter") handleApplySearch(); }} className="min-w-64 rounded bg-zinc-950 px-3 py-2 text-sm outline-none ring-1 ring-zinc-800" placeholder="Search customers by name, email, phone" />
        <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value) as (typeof pageSizes)[number]); setPage(1); }} className="rounded bg-zinc-950 px-3 py-2 text-sm ring-1 ring-zinc-800">{pageSizes.map((size) => <option key={size} value={size}>{size} rows</option>)}</select>
        <button onClick={handleApplySearch} className="rounded bg-zinc-700 px-4 py-2 text-sm font-semibold">Apply</button>
      </div>
      {error && <p className="rounded border border-red-800 bg-red-950/50 p-3">{error}</p>}
      {requestWarning && <p className="rounded border border-amber-700 bg-amber-950/50 p-3 text-amber-100">{requestWarning}</p>}
      {tabLoading[tab] && <p className="rounded border border-zinc-800 bg-zinc-900 p-3 text-zinc-400">Loading {tab}...</p>}
      {tab === "Sync Center" && message && <p className="rounded border border-emerald-800 bg-emerald-950/50 p-3">{message}</p>}

      {tab === "Overview" && <>
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="Paid Revenue" value={money(Number(summary.paidRevenue ?? 0))} helper="Actual paid WooCommerce orders only" />
          <Card label="Attempted Pipeline" value={money(Number(summary.attemptedRevenue ?? 0))} helper="Unpaid checkout/payment attempts" />
          <Card label="Active Subscriptions" value={Number(summary.activeSubscriptions ?? 0)} helper={String(summary.subscriptionNote || "Real active subscription records only")} />
          <Card label="Failed Payments This Month" value={Number(summary.failedPaymentsThisMonth ?? 0)} helper="Real subscription failures this month" />
        </section>
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="New Customers This Month" value={Number(summary.newCustomersThisMonth ?? 0)} />
          <Card label="New Paid Customers This Month" value={Number(summary.newPaidCustomersThisMonth ?? 0)} />
          <Card label="New Hot Leads This Month" value={Number(summary.newHotLeadsThisMonth ?? 0)} helper="Customers who attempted checkout but did not complete payment" />
          <Card label="High Value This Month" value={Number(summary.highValueCustomersThisMonth ?? 0)} helper={`Paid customers at or above ${money(highValueThreshold)}`} />
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-zinc-100">High-To-Low Customer Value</h2>
          <ValueIndex rows={customers} rankOffset={(page - 1) * pageSize} />
          <Pager start={customerStart} end={customerEnd} total={total} page={page} maxPage={customerMaxPage} setPage={loadCustomers} />
        </section>
      </>}

      {tab === "Customers" && <><CustomerTable rows={customers} exportCustomerPdf={exportCustomerPdf} /><Pager start={customerStart} end={customerEnd} total={total} page={page} maxPage={customerMaxPage} setPage={loadCustomers} /></>}

      {tab === "Subscriptions" && <>
        <section className="grid gap-3 sm:grid-cols-3"><Card label="Total Subscriptions" value={Number(summary.totalSubscriptions ?? 0)} helper="Excludes placeholders and candidates" /><Card label="MRR" value={money(Number(summary.monthlyRecurringRevenue ?? 0))} helper="Active real subscriptions only" /><Card label="Subscription Candidates" value={Number(summary.subscriptionCandidates ?? 0)} helper="Recurring-like WooCommerce orders, not active subscriptions" /></section>
        <h2 className="text-xl font-semibold text-zinc-100">Active Subscriptions</h2><SubscriptionTable rows={subPage.rows} /><Pager {...subPage} />
        <div>
          <h2 className="text-xl font-semibold text-zinc-100">Subscription Candidates</h2>
          <p className="mt-1 text-sm text-zinc-400">Subscription Candidates are recurring-like WooCommerce orders, not confirmed active subscriptions.</p>
        </div>
        <SubscriptionTable rows={candidatePage.rows} /><Pager {...candidatePage} />
      </>}

      {tab === "Upcoming Bills" && <>
        <section className="grid gap-3 sm:grid-cols-3"><Card label="Upcoming 30D" value={Number(summary.upcomingBills30d ?? 0)} helper="Active subscriptions with real next billing date" /><Card label="Estimated Upcoming Revenue" value={money(Number(summary.estimatedUpcomingRevenue30d ?? 0))} /><Card label="High Risk Upcoming" value={Number(upcomingMeta.highRiskCount ?? 0)} /></section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-zinc-100">Active Subscriptions With Next Billing Date</h2>
          {typeof upcomingMeta.message === "string" && upcomingMeta.message && <p className="rounded border border-zinc-800 bg-zinc-900 p-3 text-zinc-400">{upcomingMeta.message}</p>}
          {upcomingPage.rows.length > 0 ? <><SubscriptionTable rows={upcomingPage.rows} /><Pager {...upcomingPage} /></> : null}
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-zinc-100">Recurring Candidates</h2>
          <p className="text-sm text-zinc-400">Customers with repeated paid Business Builder orders but no real next billing date.</p>
          <RecurringCandidatesTable rows={recurringCandidates} />
        </section>
      </>}

      {tab === "High Value" && <><Card label="High Value Paid Customers" value={Number(summary.highValueCustomers ?? 0)} helper="Unpaid leads excluded" /><ValueIndex rows={highValuePage.rows} /><Pager {...highValuePage} /></>}

      {tab === "Hot Leads" && <>
        <section className="grid gap-3 sm:grid-cols-3"><Card label="Hot Checkout Leads" value={hotLeadRows.length} helper="Unpaid checkout/payment attempts and newer failed attempts after last paid order" /><Card label="Attempted Pipeline" value={money(hotLeadRows.reduce((sum, row) => sum + attemptedAmount(row), 0))} /><Card label="Failed/Pending Attempts This Month" value={Number(summary.failedCheckoutAttemptsThisMonth ?? 0)} /></section>
        <HotLeadsTable rows={hotLeadPage.rows} /><Pager {...hotLeadPage} />
      </>}

      {tab === "Risk Review" && <><section className="grid gap-3 sm:grid-cols-4"><Card label="Risk Customers" value={riskDisplayRows.length} /><Card label="Failed Payments Total" value={Number(summary.failedPaymentsTotal ?? 0)} /><Card label="Failed Payments Last 30D" value={Number(summary.failedPaymentsLast30Days ?? 0)} /><Card label="Failed Checkout Attempts This Month" value={Number(summary.failedCheckoutAttemptsThisMonth ?? 0)} /></section><CustomerTable rows={riskPage.rows} exportCustomerPdf={exportCustomerPdf} /><Pager {...riskPage} /></>}

      {tab === "Gateway Analytics" && <GatewayAnalyticsView data={gatewayAnalytics} range={gatewayRange} setRange={applyGatewayRange} from={gatewayFrom} setFrom={setGatewayFrom} to={gatewayTo} setTo={setGatewayTo} interval={gatewayInterval} setInterval={setGatewayInterval} provider={gatewayProvider} setProvider={setGatewayProvider} status={gatewayStatus} setStatus={setGatewayStatus} reload={loadGatewayData} />}

      {tab === "5-Year Sales" && <><section className="grid gap-3 sm:grid-cols-3"><Card label="Paid Revenue This Month" value={money(Number(summary.paidRevenueThisMonth ?? 0))} /><Card label="Attempted Pipeline This Month" value={money(Number(summary.attemptedPipelineThisMonth ?? 0))} /><Card label="Checkout Attempts This Month" value={Number(summary.checkoutAttemptsThisMonth ?? 0)} /></section><SalesHistoryTable rows={salesPage.rows} /><Pager {...salesPage} /></>}

      {tab === "Sync Center" && <section className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/70 p-5">
        <div>
          <h2 className="mb-2 text-xl font-semibold text-red-300">Sync Center</h2>
          <p className="text-sm text-zinc-400">Imports new WooCommerce orders, updates customers, imports subscriptions, and reconciles Authorize.net payments in safe batches.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button disabled={syncRunning} onClick={runSyncNow} className="rounded bg-red-600 px-6 py-3 font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60">Sync Now</button>
          {syncRunning && <button onClick={stopSyncNow} className="rounded bg-zinc-700 px-6 py-3 font-semibold hover:bg-zinc-600">Stop Sync</button>}
        </div>
        <div className="rounded-xl border border-red-950/40 bg-zinc-950 p-4">
          <button onClick={() => setAdvancedToolsOpen((open) => !open)} className="font-semibold text-red-300">{advancedToolsOpen ? "Hide" : "Show"} Advanced Tools</button>
          {advancedToolsOpen && <div className="mt-3 space-y-3">
            <p className="text-sm text-zinc-400">Technical one-step tools for debugging. Sync Now is the normal workflow.</p>
            <div className="flex flex-wrap gap-3">
              <button onClick={() => runOrderBackfill(true)} className="rounded bg-zinc-700 px-5 py-3 font-semibold hover:bg-zinc-600">Test WooCommerce Order Import</button>
              <button onClick={() => runOrderBackfill(false)} className="rounded bg-red-600 px-5 py-3 font-semibold hover:bg-red-500">Import WooCommerce Orders</button>
              <button onClick={() => runCustomerRebuild(true)} className="rounded bg-zinc-700 px-5 py-3 font-semibold hover:bg-zinc-600">Preview Customer Profile Update</button>
              <button disabled={importedOrdersCount === 0} onClick={() => runCustomerRebuild(false)} className="rounded bg-emerald-700 px-5 py-3 font-semibold hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50">Update Customer Profiles</button>
              {rebuildBatch?.hasMore && <button onClick={() => runCustomerRebuild(rebuildBatch.dryRun, rebuildBatch.nextOffset)} className="rounded bg-emerald-800 px-5 py-3 font-semibold hover:bg-emerald-700">Continue Customer Profile {rebuildBatch.dryRun ? "Preview" : "Update"}</button>}
              <button onClick={() => runSubscriptionBackfill(true)} className="rounded bg-zinc-700 px-5 py-3 font-semibold hover:bg-zinc-600">Test WooCommerce Subscription Import</button>
              <button onClick={() => runSubscriptionBackfill(false)} className="rounded bg-red-700 px-5 py-3 font-semibold hover:bg-red-600">Import WooCommerce Subscriptions</button>
              <button onClick={syncWooCommerce} className="rounded bg-zinc-800 px-5 py-3 font-semibold text-zinc-200 hover:bg-zinc-700">Single Customer Repair Sync</button>
              <button onClick={() => runAuthorizeNetImport()} className="rounded bg-zinc-700 px-5 py-3 font-semibold hover:bg-zinc-600">Import Authorize.net Transactions</button>
              <button onClick={() => runAuthorizeNetReconcile()} className="rounded bg-red-800 px-5 py-3 font-semibold hover:bg-red-700">Reconcile Authorize.net Payments</button>
              {authNetBatch?.hasMore && <button onClick={() => authNetBatch.action === "import" ? runAuthorizeNetImport(authNetBatch.nextOffset) : runAuthorizeNetReconcile(authNetBatch.nextOffset)} className="rounded bg-zinc-800 px-5 py-3 font-semibold hover:bg-zinc-700">Continue Authorize.net {authNetBatch.action === "import" ? "Import" : "Reconcile"}</button>}
            </div>
          </div>}
        </div>
        {importedOrdersCount === 0 && <p className="text-sm text-zinc-400">Update Customer Profiles is disabled until this page has imported WooCommerce orders. Run Import WooCommerce Orders first.</p>}
        <div className="grid gap-3 md:grid-cols-5">
          <Card label="Last Action" value={syncLastRun?.action ?? "None"} />
          <Card label="Job Status" value={syncLastRun?.status ?? "Idle"} />
          <Card label="Orders Imported" value={syncLastRun?.ordersImported ?? 0} />
          <Card label="Subscriptions Imported" value={syncLastRun?.subscriptionsImported ?? 0} />
          <Card label="Gateway Transactions" value={syncLastRun?.gatewayTransactionsImported ?? 0} />
          <Card label="Customers Updated" value={syncLastRun?.customersUpdated ?? 0} />
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-300">
          <p><span className="font-semibold text-zinc-100">Last run time:</span> {syncLastRun?.lastRunTime ?? "-"}</p>
          <p className="mt-2"><span className="font-semibold text-zinc-100">Warnings:</span> {syncLastRun?.warnings?.length ? syncLastRun.warnings.slice(0, 5).join(" ") : "-"}</p>
        </div>
        {syncResult?.failedRequests?.length ? <p className="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-100">Failed requests: {syncResult.failedRequests.length}</p> : null}
      </section>}
    </div>
  </main>;
}
