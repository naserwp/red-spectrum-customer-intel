"use client";

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Customer = {
  _id: string;
  name: string;
  email: string;
  phone: string;
  totalPaid: number;
  paidTotal?: number;
  attemptedTotal?: number;
  paidOrderCount?: number;
  attemptedOrderCount?: number;
  leadStatus?: string;
  paymentStatus?: string;
  lastPaidDate?: string;
  lastAttemptDate?: string;
  activeSubscriptions: number;
  failedPayments: number;
  chargebacks: number;
  estimatedCreditLimit: number;
  tier: string;
  riskLevel: string;
  score: number;
  stars: number;
  aiSummaryPreview: string;
  aiSummary: string;
  subscriptionStatus: string;
  orderCount: number;
  averageOrderValue: number;
  firstOrderDate: string;
  lastOrderDate: string;
  refunds: number;
  riskExplanation: string;
  recommendedAction: string;
};

type Subscription = {
  _id?: string;
  subscriptionId: string;
  source: string;
  customerEmail: string;
  customerName: string;
  status: string;
  amount: number;
  monthlyRecurringRevenue?: number;
  billingInterval?: string;
  nextBillingDate?: string;
  lastBillingDate?: string;
  failedPaymentCount?: number;
  lastPaymentStatus?: string;
};

const money = (n: number) => `$${n.toFixed(2)}`;
const tabs = ["Overview", "Customers", "Subscriptions", "Upcoming Bills", "High Value", "Risk Review", "Sync Center"] as const;

const paidAmount = (c: Customer) => Number(c.paidTotal ?? c.totalPaid ?? 0);
const attemptedAmount = (c: Customer) => Number(c.attemptedTotal ?? 0);
const displayDate = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
};
const displayStatus = (value?: string) => value ? value.replaceAll("_", " ") : "-";
const monthSpan = (start?: string, end?: string) => {
  if (!start) return 0;
  const startDate = new Date(start);
  const endDate = end ? new Date(end) : new Date();
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.max(0, (endDate.getFullYear() - startDate.getFullYear()) * 12 + endDate.getMonth() - startDate.getMonth() + 1);
};

function getCustomerCategory(c: Customer) {
  const paid = paidAmount(c);
  const attempted = attemptedAmount(c);
  if (paid >= 2000) return "vip_paid";
  if (paid > 0) return "paying";
  if (attempted >= 2000) return "very_hot_lead";
  if (attempted > 0) return "hot_lead";
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

function MetricGrid({ summary }: { summary: Record<string, unknown> }) {
  return <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
    ["Total Subscriptions", Number(summary.totalSubscriptions ?? 0)],
    ["Active Subscriptions", Number(summary.activeSubscriptions ?? 0)],
    ["MRR", money(Number(summary.monthlyRecurringRevenue ?? 0))],
    ["Upcoming 30d", Number(summary.upcomingBills30d ?? 0)],
    ["Failed Payments", Number(summary.failedPayments ?? 0)],
    ["Paid Revenue", money(Number(summary.paidRevenue ?? summary.totalRevenue ?? 0))],
    ["Attempted Pipeline", money(Number(summary.attemptedRevenue ?? 0))],
    ["Est. Upcoming Revenue", money(Number(summary.estimatedUpcomingRevenue30d ?? 0))],
  ].map(([k, v]) => <div key={String(k)} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"><p className="text-xs uppercase text-zinc-400">{k}</p><p className="mt-2 text-2xl font-semibold">{String(v)}</p></div>)}</section>;
}

function ValueIndex({ customers, limit }: { customers: Customer[]; limit?: number }) {
  const rows = [...customers].sort((a, b) => paidAmount(b) - paidAmount(a) || attemptedAmount(b) - attemptedAmount(a)).slice(0, limit ?? customers.length);
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[1100px] text-xs">
      <thead className="bg-zinc-950"><tr>{["Rank", "Customer", "Lifetime Value", "Start", "Paid Months", "Tenure", "Last Paid", "Attempted", "Category", "Action"].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead>
      <tbody>{rows.map((c, index) => {
        const cat = getCustomerCategory(c);
        return <tr key={c._id} className="border-t border-zinc-800">
          <td className="px-3 py-2 font-semibold">#{index + 1}</td>
          <td className="px-3 py-2"><p className="font-semibold">{c.name}</p><p className="text-zinc-400">{c.email}</p></td>
          <td className="px-3 py-2 font-semibold">{money(paidAmount(c))}</td>
          <td className="px-3 py-2">{displayDate(c.firstOrderDate)}</td>
          <td className="px-3 py-2">{c.paidOrderCount ?? 0}</td>
          <td className="px-3 py-2">{monthSpan(c.firstOrderDate)} mo</td>
          <td className="px-3 py-2">{displayDate(c.lastPaidDate || c.lastOrderDate)}</td>
          <td className="px-3 py-2">{money(attemptedAmount(c))}</td>
          <td className="px-3 py-2"><span className={`inline-flex rounded border px-2 py-1 ${badgeClass[cat]}`}>{categoryLabel[cat]}</span></td>
          <td className="px-3 py-2"><Link className="rounded bg-zinc-700 px-2 py-1" href={`/admin/customers/${c._id}`}>View</Link></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function CustomerTable({ customers, exportCustomerPdf }: { customers: Customer[]; exportCustomerPdf: (c: Customer) => void }) {
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[1700px] table-fixed text-xs">
      <thead className="bg-zinc-950"><tr>{["Customer", "Category", "Tier", "Actual Paid", "Attempted Amount", "Paid Orders", "Attempted Orders", "Start", "Tenure", "Payment Status", "Lead Status", "Last Paid", "Last Attempt", "Risk", "Score", "Preview", "Actions"].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead>
      <tbody>{customers.map((c) => {
        const cat = getCustomerCategory(c);
        return <tr key={c._id} className={`border-t border-zinc-800 ${cat === "vip_paid" ? "bg-amber-500/5" : cat.includes("hot") ? "bg-orange-500/5" : ""}`}>
          <td className="w-52 px-3 py-2"><p className="truncate font-semibold">{c.name}</p><p className="truncate text-zinc-400">{c.email}</p></td>
          <td className="px-3 py-2"><span className={`inline-flex rounded border px-2 py-1 ${badgeClass[cat]}`}>{categoryLabel[cat]}</span></td>
          <td className="px-3 py-2">{paidAmount(c) > 0 ? c.tier : "Lead"}</td>
          <td className="px-3 py-2">{money(paidAmount(c))}</td>
          <td className="px-3 py-2">{money(attemptedAmount(c))}</td>
          <td className="px-3 py-2">{c.paidOrderCount ?? 0}</td>
          <td className="px-3 py-2">{c.attemptedOrderCount ?? 0}</td>
          <td className="px-3 py-2">{displayDate(c.firstOrderDate)}</td>
          <td className="px-3 py-2">{monthSpan(c.firstOrderDate)} mo</td>
          <td className="px-3 py-2">{displayStatus(c.paymentStatus)}</td>
          <td className="px-3 py-2">{displayStatus(c.leadStatus)}</td>
          <td className="px-3 py-2">{displayDate(c.lastPaidDate)}</td>
          <td className="px-3 py-2">{displayDate(c.lastAttemptDate)}</td>
          <td className="px-3 py-2">{c.riskLevel}</td>
          <td className="px-3 py-2">{c.score}/{c.stars} stars</td>
          <td className="truncate px-3 py-2">{c.aiSummaryPreview}</td>
          <td className="px-3 py-2"><div className="flex gap-2"><Link className="rounded bg-zinc-700 px-2 py-1" href={`/admin/customers/${c._id}`}>View</Link><button onClick={() => exportCustomerPdf(c)} className="rounded bg-red-700 px-2 py-1">PDF</button></div></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function SubscriptionTable({ rows }: { rows: Subscription[] }) {
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[1100px] text-xs">
      <thead className="bg-zinc-950"><tr>{["Customer", "Source", "Status", "Amount", "MRR", "Interval", "Next Bill", "Last Bill", "Failed", "Last Payment"].map((h) => <th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead>
      <tbody>{rows.map((s) => <tr key={s._id ?? s.subscriptionId} className="border-t border-zinc-800">
        <td className="px-3 py-2"><p className="font-semibold">{s.customerName || "-"}</p><p className="text-zinc-400">{s.customerEmail}</p></td>
        <td className="px-3 py-2">{s.source}</td>
        <td className="px-3 py-2">{displayStatus(s.status)}</td>
        <td className="px-3 py-2">{money(Number(s.amount ?? 0))}</td>
        <td className="px-3 py-2">{money(Number(s.monthlyRecurringRevenue ?? 0))}</td>
        <td className="px-3 py-2">{s.billingInterval ?? "-"}</td>
        <td className="px-3 py-2">{displayDate(s.nextBillingDate)}</td>
        <td className="px-3 py-2">{displayDate(s.lastBillingDate)}</td>
        <td className="px-3 py-2">{s.failedPaymentCount ?? 0}</td>
        <td className="px-3 py-2">{displayStatus(s.lastPaymentStatus)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export default function AdminPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown>>({});
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [upcomingBills, setUpcomingBills] = useState<Subscription[]>([]);
  const [riskRows, setRiskRows] = useState<Customer[]>([]);
  const [upcomingMeta, setUpcomingMeta] = useState<Record<string, unknown>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const loadCustomers = useCallback(async (nextPage = page) => {
    const data = await fetch(`/api/customers/table?page=${nextPage}&limit=100`, { cache: "no-store" }).then((r) => r.json());
    setCustomers(data.rows || []);
    setTotal(data.total || 0);
    setPage(data.page || nextPage);
  }, [page]);

  const loadDashboardData = useCallback(async () => {
    const [summaryData, subscriptionData, upcomingData, riskData] = await Promise.all([
      fetch("/api/analytics/summary", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/subscriptions?limit=100", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/upcoming-bills", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/risk-customers", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setSummary(summaryData || {});
    setSubscriptions(subscriptionData.rows || []);
    setUpcomingBills(upcomingData.rows || []);
    setUpcomingMeta(upcomingData || {});
    setRiskRows(riskData.rows || []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCustomers(1).catch(() => setError("Unable to load customers."));
    loadDashboardData().catch(() => setError("Unable to load dashboard data."));
  }, [loadCustomers, loadDashboardData]);

  const syncWooCommerce = async () => {
    setError("");
    setMessage("Sync in progress...");
    const res = await fetch("/api/customers/sync", { method: "POST" });
    const d = await res.json();
    if (!res.ok) return setError(d.error || "Sync failed");
    setMessage(d.message || "Sync completed");
    await loadCustomers(1);
    await loadDashboardData();
  };

  const exportCustomerPdf = (c: Customer) => {
    const doc = new jsPDF();
    doc.text(`Customer - ${c.name}`, 14, 16);
    autoTable(doc, {
      startY: 24,
      head: [["Metric", "Value"]],
      body: [
        ["Email", c.email],
        ["Customer Lifetime Value", money(paidAmount(c))],
        ["Attempted Amount", money(attemptedAmount(c))],
        ["Start Date", displayDate(c.firstOrderDate)],
        ["Paid Months", String(c.paidOrderCount ?? 0)],
        ["Tenure", `${monthSpan(c.firstOrderDate)} months`],
        ["Payment Status", displayStatus(c.paymentStatus)],
        ["Lead Status", displayStatus(c.leadStatus)],
        ["Tier", paidAmount(c) > 0 ? c.tier : "Lead"],
        ["Risk", c.riskLevel],
        ["AI", c.aiSummary],
      ],
    });
    doc.save(`customer-${c.email}.pdf`);
  };

  const vipPaidCustomers = useMemo(
    () => customers.filter((c) => paidAmount(c) >= 2000).sort((a, b) => paidAmount(b) - paidAmount(a)).slice(0, 5),
    [customers]
  );
  const hotCheckoutLeads = useMemo(
    () => customers.filter((c) => paidAmount(c) === 0 && attemptedAmount(c) > 0).sort((a, b) => attemptedAmount(b) - attemptedAmount(a)).slice(0, 5),
    [customers]
  );
  const lowValueCustomers = useMemo(
    () => customers.filter((c) => paidAmount(c) > 0).sort((a, b) => paidAmount(a) - paidAmount(b)).slice(0, 10),
    [customers]
  );

  return <main className="min-h-screen bg-gradient-to-b from-zinc-950 to-black p-4 text-zinc-100 md:p-8">
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-3xl font-bold text-red-400">Red Spectrum Intelligence</h1><p className="text-zinc-400">Multi-source subscriptions, risk review, and recurring revenue analytics.</p></div><button onClick={syncWooCommerce} className="rounded bg-red-600 px-4 py-2 font-semibold hover:bg-red-500">Sync Center</button></header>
      <nav className="sticky top-0 z-10 flex gap-2 overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/80 p-2 backdrop-blur">{tabs.map((t) => <button key={t} onClick={() => setTab(t)} className={`rounded px-3 py-2 text-sm ${tab === t ? "bg-red-600 text-white" : "bg-zinc-800 text-zinc-300"}`}>{t}</button>)}</nav>
      {error && <p className="rounded border border-red-800 bg-red-950/50 p-3">{error}</p>}
      {message && <p className="rounded border border-emerald-800 bg-emerald-950/50 p-3">{message}</p>}

      {tab === "Overview" && <>
        <MetricGrid summary={summary} />
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"><h2 className="mb-3 text-lg font-semibold text-amber-200">VIP Paid Customers</h2><div className="grid gap-2 md:grid-cols-5">{vipPaidCustomers.map((c) => <div key={c._id} className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-sm"><p className="font-semibold">{c.name}</p><p>{money(paidAmount(c))}</p><p>{c.paidOrderCount ?? 0} paid months/orders</p></div>)}</div>{vipPaidCustomers.length === 0 && <p className="text-sm text-zinc-400">No high-value paid customers on this page.</p>}</section>
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"><h2 className="mb-3 text-lg font-semibold text-orange-200">Hot Checkout Leads</h2><div className="grid gap-2 md:grid-cols-5">{hotCheckoutLeads.map((c) => <div key={c._id} className="rounded border border-orange-500/30 bg-orange-500/10 p-2 text-sm"><p className="font-semibold">{c.name}</p><p>{money(attemptedAmount(c))} attempted</p><p>{displayStatus(c.leadStatus)}</p></div>)}</div>{hotCheckoutLeads.length === 0 && <p className="text-sm text-zinc-400">No unpaid checkout leads on this page.</p>}</section>
        <section className="space-y-3"><h2 className="text-lg font-semibold text-zinc-100">Customer Value Index</h2><ValueIndex customers={customers} limit={10} /></section>
      </>}

      {tab === "Customers" && <>
        <MetricGrid summary={summary} />
        <CustomerTable customers={customers} exportCustomerPdf={exportCustomerPdf} />
        <div className="flex items-center justify-between"><p className="text-sm text-zinc-400">Showing page {page}. Total rows: {total}</p><div className="flex gap-2"><button disabled={page <= 1} onClick={() => loadCustomers(page - 1)} className="rounded bg-zinc-800 px-3 py-1 disabled:opacity-50">Prev</button><button disabled={page * 100 >= total} onClick={() => loadCustomers(page + 1)} className="rounded bg-zinc-800 px-3 py-1 disabled:opacity-50">Next</button></div></div>
      </>}

      {tab === "Subscriptions" && <>
        <MetricGrid summary={summary} />
        <SubscriptionTable rows={subscriptions} />
      </>}

      {tab === "Upcoming Bills" && <>
        <section className="grid gap-3 sm:grid-cols-3">{[
          ["Upcoming Bills", Number(upcomingMeta.rows ? upcomingBills.length : summary.upcomingBills30d ?? 0)],
          ["High Risk Upcoming", Number(upcomingMeta.highRiskCount ?? 0)],
          ["Estimated Upcoming", money(Number(upcomingMeta.estimatedUpcomingRevenue ?? summary.estimatedUpcomingRevenue30d ?? 0))],
        ].map(([k, v]) => <div key={String(k)} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"><p className="text-xs uppercase text-zinc-400">{k}</p><p className="mt-2 text-2xl font-semibold">{String(v)}</p></div>)}</section>
        <SubscriptionTable rows={upcomingBills} />
      </>}

      {tab === "High Value" && <>
        <section className="space-y-3"><h2 className="text-lg font-semibold text-amber-200">High To Low Customer Value</h2><ValueIndex customers={customers} /></section>
        <section className="space-y-3"><h2 className="text-lg font-semibold text-zinc-200">Low Value Paid Customers</h2><ValueIndex customers={lowValueCustomers} /></section>
      </>}

      {tab === "Risk Review" && <>
        <section className="grid gap-3 sm:grid-cols-3">{[
          ["Risk Customers", riskRows.length],
          ["Failed Payments", Number(summary.failedPayments ?? 0)],
          ["Attempted Pipeline", money(Number(summary.attemptedRevenue ?? 0))],
        ].map(([k, v]) => <div key={String(k)} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"><p className="text-xs uppercase text-zinc-400">{k}</p><p className="mt-2 text-2xl font-semibold">{String(v)}</p></div>)}</section>
        <CustomerTable customers={riskRows.length ? riskRows : customers.filter((c) => c.riskLevel === "high" || c.failedPayments > 0 || c.chargebacks > 0)} exportCustomerPdf={exportCustomerPdf} />
      </>}

      {tab === "Sync Center" && <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
        <h2 className="mb-3 text-lg font-semibold text-red-300">Sync Center</h2>
        <p className="mb-4 text-sm text-zinc-400">WooCommerce sync recalculates actual paid revenue, attempted checkout pipeline, customer tier, lead status, payment status, and rule-based summaries.</p>
        <button onClick={syncWooCommerce} className="rounded bg-red-600 px-4 py-2 font-semibold hover:bg-red-500">Run WooCommerce Sync</button>
      </section>}
    </div>
  </main>;
}
