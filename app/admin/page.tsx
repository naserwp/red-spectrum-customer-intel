"use client";

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Customer = {
  _id: string; name: string; email: string; phone: string; totalPaid: number; paidTotal?: number; attemptedTotal?: number;
  paidOrderCount?: number; attemptedOrderCount?: number; leadStatus?: string; paymentStatus?: string; lastPaidDate?: string; lastAttemptDate?: string;
  activeSubscriptions: number; failedPayments: number; chargebacks: number; estimatedCreditLimit: number; tier: string; riskLevel: string;
  score: number; stars: number; aiSummaryPreview: string; aiSummary: string; subscriptionStatus: string; orderCount: number; averageOrderValue: number;
  firstOrderDate: string; lastOrderDate: string; refunds: number; riskExplanation: string; recommendedAction: string;
};

type Subscription = {
  _id?: string; subscriptionId: string; source: string; customerEmail: string; customerName: string; status: string; amount: number;
  monthlyRecurringRevenue?: number; billingInterval?: string; nextBillingDate?: string; lastBillingDate?: string; failedPaymentCount?: number;
  lastPaymentStatus?: string; sourceStatus?: string; recordType?: string;
};

type SalesMetric = {
  period: string; paidRevenue: number; attemptedPipeline: number; paidOrders: number; attemptedOrders: number; failedPayments: number;
  refunds: number; chargebacks: number; newPaidCustomers: number; newLeads: number; averageOrderValue: number;
};

const tabs = ["Overview", "Customers", "Subscriptions", "Upcoming Bills", "High Value", "Hot Leads", "Risk Review", "5-Year Sales", "Sync Center"] as const;
const pageSizes = [25, 50, 100] as const;
const highValueThreshold = 2000;
const money = (n: number) => `$${n.toFixed(2)}`;
const paidAmount = (c: Customer) => Number(c.paidTotal ?? c.totalPaid ?? 0);
const attemptedAmount = (c: Customer) => Number(c.attemptedTotal ?? 0);
const displayStatus = (value?: string) => value ? value.replaceAll("_", " ") : "-";
const displayDate = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
};
const monthSpan = (start?: string) => {
  const startDate = start ? new Date(start) : null;
  if (!startDate || Number.isNaN(startDate.getTime())) return 0;
  const now = new Date();
  return Math.max(0, (now.getFullYear() - startDate.getFullYear()) * 12 + now.getMonth() - startDate.getMonth() + 1);
};

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
  return <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-lg shadow-black/20">
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
          <td className="px-3 py-3"><div className="flex gap-2"><Link className="rounded bg-zinc-700 px-2 py-1" href={`/admin/customers/${c._id}`}>View</Link><button onClick={() => exportCustomerPdf(c)} className="rounded bg-red-700 px-2 py-1">PDF</button></div></td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function SubscriptionTable({ rows }: { rows: Subscription[] }) {
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[1200px] text-sm">
      <thead className="sticky top-0 bg-zinc-950"><tr>{["Customer", "Type", "Source", "Status", "Amount", "MRR", "Next Bill", "Last Bill", "Failed", "Last Payment"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
      <tbody>{rows.map((s) => {
        const isCandidate = s.recordType === "subscription_candidate" || s.sourceStatus === "candidate";
        return <tr key={s._id ?? s.subscriptionId} className="border-t border-zinc-800">
          <td className="px-3 py-3"><p className="font-semibold">{s.customerName || "-"}</p><p className="text-xs text-zinc-400">{s.customerEmail}</p></td>
          <td className="px-3 py-3">{isCandidate ? "Subscription Candidate" : "Active Subscription"}</td>
          <td className="px-3 py-3">{s.source}</td>
          <td className="px-3 py-3">{displayStatus(s.status)}</td>
          <td className="px-3 py-3">{money(Number(s.amount ?? 0))}</td>
          <td className="px-3 py-3">{money(Number(s.monthlyRecurringRevenue ?? 0))}</td>
          <td className="px-3 py-3">{displayDate(s.nextBillingDate)}</td>
          <td className="px-3 py-3">{displayDate(s.lastBillingDate)}</td>
          <td className="px-3 py-3">{s.failedPaymentCount ?? 0}</td>
          <td className="px-3 py-3">{displayStatus(s.lastPaymentStatus)}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function ValueIndex({ rows }: { rows: Customer[] }) {
  return <div className="overflow-x-auto rounded-xl border border-zinc-800">
    <table className="min-w-[1150px] text-sm">
      <thead className="sticky top-0 bg-zinc-950"><tr>{["Rank", "Customer", "Customer Lifetime Value", "Start", "Paid Months", "Stay With Us", "Last Paid", "Attempted Pipeline", "Category", "Action"].map((h) => <th key={h} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{h}</th>)}</tr></thead>
      <tbody>{rows.map((c, index) => {
        const cat = getCustomerCategory(c);
        return <tr key={c._id} className="border-t border-zinc-800">
          <td className="px-3 py-3 font-semibold">#{index + 1}</td>
          <td className="px-3 py-3"><p className="font-semibold">{c.name}</p><p className="text-xs text-zinc-400">{c.email}</p></td>
          <td className="px-3 py-3 font-semibold">{money(paidAmount(c))}</td>
          <td className="px-3 py-3">{displayDate(c.firstOrderDate)}</td>
          <td className="px-3 py-3">{c.paidOrderCount ?? 0}</td>
          <td className="px-3 py-3">{monthSpan(c.firstOrderDate)} months</td>
          <td className="px-3 py-3">{displayDate(c.lastPaidDate || c.lastOrderDate)}</td>
          <td className="px-3 py-3">{money(attemptedAmount(c))}</td>
          <td className="px-3 py-3"><span className={`inline-flex rounded border px-2 py-1 text-xs ${badgeClass[cat]}`}>{categoryLabel[cat]}</span></td>
          <td className="px-3 py-3"><Link className="rounded bg-zinc-700 px-2 py-1" href={`/admin/customers/${c._id}`}>View</Link></td>
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

export default function AdminPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown>>({});
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [subscriptionCandidates, setSubscriptionCandidates] = useState<Subscription[]>([]);
  const [upcomingBills, setUpcomingBills] = useState<Subscription[]>([]);
  const [riskRows, setRiskRows] = useState<Customer[]>([]);
  const [salesHistory, setSalesHistory] = useState<SalesMetric[]>([]);
  const [upcomingMeta, setUpcomingMeta] = useState<Record<string, unknown>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof pageSizes)[number]>(25);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");

  const loadCustomers = useCallback(async (nextPage = page) => {
    const params = new URLSearchParams({ page: String(nextPage), limit: String(pageSize) });
    if (search.trim()) params.set("q", search.trim());
    const data = await fetch(`/api/customers/table?${params.toString()}`, { cache: "no-store" }).then((r) => r.json());
    setCustomers(data.rows || []);
    setTotal(data.total || 0);
    setPage(data.page || nextPage);
  }, [page, pageSize, search]);

  const loadDashboardData = useCallback(async () => {
    const [summaryData, subscriptionData, candidateData, upcomingData, riskData, salesData] = await Promise.all([
      fetch("/api/analytics/summary", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/subscriptions?kind=real&limit=100", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/subscriptions?kind=candidates&limit=100", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/upcoming-bills", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/risk-customers", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/analytics/sales-history?years=5", { cache: "no-store" }).then((r) => r.json()),
    ]);
    setSummary(summaryData || {});
    setSubscriptions(subscriptionData.rows || []);
    setSubscriptionCandidates(candidateData.rows || []);
    setUpcomingBills(upcomingData.rows || []);
    setUpcomingMeta(upcomingData || {});
    setRiskRows(riskData.rows || []);
    setSalesHistory(salesData.yearly || []);
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
    const data = await res.json();
    if (!res.ok) return setError(data.error || "Sync failed");
    const warning = data.warning ? ` ${data.warning}` : "";
    setMessage(`${data.message || "Sync completed"} Orders fetched: ${data.totalOrdersFetched ?? 0}. Paid orders: ${data.paidOrders ?? 0}. Unpaid orders: ${data.unpaidOrders ?? 0}.${warning}`);
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
  const hotLeadRows = useMemo(() => customers.filter((c) => paidAmount(c) === 0 && attemptedAmount(c) > 0).sort((a, b) => attemptedAmount(b) - attemptedAmount(a)), [customers]);
  const riskDisplayRows = riskRows.length ? riskRows : customers.filter((c) => c.riskLevel === "high" || c.failedPayments > 0 || c.chargebacks > 0);
  const highValuePage = usePagedRows(highValueRows, pageSize);
  const hotLeadPage = usePagedRows(hotLeadRows, pageSize);
  const riskPage = usePagedRows(riskDisplayRows, pageSize);
  const subPage = usePagedRows(subscriptions, pageSize);
  const candidatePage = usePagedRows(subscriptionCandidates, pageSize);
  const upcomingPage = usePagedRows(upcomingBills, pageSize);
  const salesPage = usePagedRows(salesHistory, pageSize);

  return <main className="min-h-screen bg-gradient-to-b from-zinc-950 to-black p-4 text-base text-zinc-100 md:p-8">
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-3xl font-bold text-red-400">Red Spectrum Intelligence</h1><p className="text-zinc-400">Paid revenue, subscription status, checkout pipeline, and customer risk.</p></div><button onClick={syncWooCommerce} className="rounded bg-red-600 px-5 py-3 font-semibold hover:bg-red-500">Sync Center</button></header>
      <nav className="sticky top-0 z-10 flex gap-2 overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/90 p-3 backdrop-blur">{tabs.map((t) => <button key={t} onClick={() => setTab(t)} className={`whitespace-nowrap rounded px-4 py-2 text-sm font-semibold ${tab === t ? "bg-red-600 text-white shadow-lg shadow-red-950/40" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}>{t}</button>)}</nav>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") loadCustomers(1); }} className="min-w-64 rounded bg-zinc-950 px-3 py-2 text-sm outline-none ring-1 ring-zinc-800" placeholder="Search customers by name, email, phone" />
        <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value) as (typeof pageSizes)[number]); setPage(1); }} className="rounded bg-zinc-950 px-3 py-2 text-sm ring-1 ring-zinc-800">{pageSizes.map((size) => <option key={size} value={size}>{size} rows</option>)}</select>
        <button onClick={() => loadCustomers(1)} className="rounded bg-zinc-700 px-4 py-2 text-sm font-semibold">Apply</button>
      </div>
      {error && <p className="rounded border border-red-800 bg-red-950/50 p-3">{error}</p>}
      {message && <p className="rounded border border-emerald-800 bg-emerald-950/50 p-3">{message}</p>}

      {tab === "Overview" && <>
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="Paid Revenue" value={money(Number(summary.paidRevenue ?? 0))} helper="Actual completed/processing/paid orders only" />
          <Card label="Attempted Pipeline" value={money(Number(summary.attemptedRevenue ?? 0))} helper="Unpaid checkout/payment attempts" />
          <Card label="Active Subscriptions" value={Number(summary.activeSubscriptions ?? 0)} helper={String(summary.subscriptionNote || "Real active subscription records only")} />
          <Card label="Failed Payments This Month" value={Number(summary.failedPaymentsThisMonth ?? 0)} helper="Real subscription failures this month" />
        </section>
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card label="New Customers This Month" value={Number(summary.newCustomersThisMonth ?? 0)} />
          <Card label="New Paid Customers This Month" value={Number(summary.newPaidCustomersThisMonth ?? 0)} />
          <Card label="New Hot Leads This Month" value={Number(summary.newHotLeadsThisMonth ?? 0)} />
          <Card label="High Value This Month" value={Number(summary.highValueCustomersThisMonth ?? 0)} helper={`Paid customers at or above ${money(highValueThreshold)}`} />
        </section>
        <section className="space-y-3"><h2 className="text-xl font-semibold text-zinc-100">High-To-Low Customer Value</h2><ValueIndex rows={highValueRows.length ? highValueRows.slice(0, 10) : customers.slice(0, 10)} /></section>
      </>}

      {tab === "Customers" && <><CustomerTable rows={customers} exportCustomerPdf={exportCustomerPdf} /><Pager start={customerStart} end={customerEnd} total={total} page={page} maxPage={customerMaxPage} setPage={loadCustomers} /></>}

      {tab === "Subscriptions" && <>
        <section className="grid gap-3 sm:grid-cols-3"><Card label="Total Subscriptions" value={Number(summary.totalSubscriptions ?? 0)} helper="Excludes placeholders and candidates" /><Card label="MRR" value={money(Number(summary.monthlyRecurringRevenue ?? 0))} helper="Active real subscriptions only" /><Card label="Subscription Candidates" value={Number(summary.subscriptionCandidates ?? 0)} helper="Recurring-like WooCommerce orders, not active subscriptions" /></section>
        <h2 className="text-xl font-semibold text-zinc-100">Active Subscriptions</h2><SubscriptionTable rows={subPage.rows} /><Pager {...subPage} />
        <h2 className="text-xl font-semibold text-zinc-100">Subscription Candidates</h2><SubscriptionTable rows={candidatePage.rows} /><Pager {...candidatePage} />
      </>}

      {tab === "Upcoming Bills" && <>
        <section className="grid gap-3 sm:grid-cols-3"><Card label="Upcoming 30D" value={Number(summary.upcomingBills30d ?? 0)} helper="Active subscriptions with real next billing date" /><Card label="Est. Upcoming Revenue" value={money(Number(summary.estimatedUpcomingRevenue30d ?? 0))} /><Card label="High Risk Upcoming" value={Number(upcomingMeta.highRiskCount ?? 0)} /></section>
        {upcomingMeta.message && <p className="rounded border border-zinc-800 bg-zinc-900 p-3 text-zinc-400">{String(upcomingMeta.message)}</p>}
        <SubscriptionTable rows={upcomingPage.rows} /><Pager {...upcomingPage} />
      </>}

      {tab === "High Value" && <><Card label="High Value Paid Customers" value={Number(summary.highValueCustomers ?? 0)} helper="Unpaid leads excluded" /><ValueIndex rows={highValuePage.rows} /><Pager {...highValuePage} /></>}

      {tab === "Hot Leads" && <><Card label="Hot Checkout Leads" value={hotLeadRows.length} helper="paidTotal = 0 and attemptedTotal > 0" /><CustomerTable rows={hotLeadPage.rows} exportCustomerPdf={exportCustomerPdf} /><Pager {...hotLeadPage} /></>}

      {tab === "Risk Review" && <><section className="grid gap-3 sm:grid-cols-4"><Card label="Risk Customers" value={riskDisplayRows.length} /><Card label="Failed Payments Total" value={Number(summary.failedPaymentsTotal ?? 0)} /><Card label="Failed Payments Last 30D" value={Number(summary.failedPaymentsLast30Days ?? 0)} /><Card label="Failed Checkout Attempts This Month" value={Number(summary.failedCheckoutAttemptsThisMonth ?? 0)} /></section><CustomerTable rows={riskPage.rows} exportCustomerPdf={exportCustomerPdf} /><Pager {...riskPage} /></>}

      {tab === "5-Year Sales" && <><section className="grid gap-3 sm:grid-cols-3"><Card label="Paid Revenue This Month" value={money(Number(summary.paidRevenueThisMonth ?? 0))} /><Card label="Attempted Pipeline This Month" value={money(Number(summary.attemptedPipelineThisMonth ?? 0))} /><Card label="Checkout Attempts This Month" value={Number(summary.checkoutAttemptsThisMonth ?? 0)} /></section><SalesHistoryTable rows={salesPage.rows} /><Pager {...salesPage} /></>}

      {tab === "Sync Center" && <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-5"><h2 className="mb-3 text-xl font-semibold text-red-300">Sync Center</h2><p className="mb-4 text-sm text-zinc-400">WooCommerce sync fetches paginated orders, recalculates paid revenue, attempted pipeline, subscription candidates, and 5-year sales status.</p><button onClick={syncWooCommerce} className="rounded bg-red-600 px-5 py-3 font-semibold hover:bg-red-500">Run WooCommerce Sync</button></section>}
    </div>
  </main>;
}
