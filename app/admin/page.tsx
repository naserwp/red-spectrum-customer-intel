"use client";

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Customer = Record<string, string | number | null> & { _id: string; name: string; email: string; phone: string; totalPaid: number; activeSubscriptions: number; failedPayments: number; chargebacks: number; estimatedCreditLimit: number; tier: string; riskLevel: string; score: number; stars: number; aiSummaryPreview: string; aiSummary: string; subscriptionStatus: string; orderCount: number; averageOrderValue: number; firstOrderDate: string; lastOrderDate: string; refunds: number; riskExplanation: string; recommendedAction: string; };

const money = (n: number) => `$${n.toFixed(2)}`;
const tabs = ["Overview", "Customers", "Subscriptions", "Upcoming Bills", "High Value", "Risk Review", "Sync Center"] as const;

function getCustomerCategory(c: Customer) {
  if (c.totalPaid >= 2000 || c.estimatedCreditLimit >= 10000 || c.activeSubscriptions >= 2) return "vip";
  if (c.totalPaid >= 1000 || c.estimatedCreditLimit >= 5000) return "gold";
  if (c.totalPaid >= 500) return "silver";
  if (c.failedPayments > 1 || c.chargebacks > 0) return "risk";
  return "bronze";
}

const badgeClass: Record<string, string> = {
  vip: "bg-amber-500/20 text-amber-200 border-amber-500/50",
  gold: "bg-yellow-500/20 text-yellow-200 border-yellow-500/50",
  silver: "bg-slate-400/20 text-slate-200 border-slate-400/50",
  bronze: "bg-orange-700/20 text-orange-200 border-orange-700/50",
  risk: "bg-red-600/20 text-red-200 border-red-600/50",
};

export default function AdminPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const loadCustomers = useCallback(async (nextPage = page) => {
    const data = await fetch(`/api/customers/table?page=${nextPage}&limit=25`, { cache: "no-store" }).then((r) => r.json());
    setCustomers(data.rows || []); setTotal(data.total || 0); setPage(data.page || nextPage);
  }, [page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCustomers(1).catch(() => setError("Unable to load customers."));
    fetch("/api/analytics/summary", { cache: "no-store" }).then((r) => r.json()).then(setSummary).catch(() => setSummary({}));
  }, [loadCustomers]);

  const syncWooCommerce = async () => {
    setMessage("Sync in progress...");
    const res = await fetch("/api/customers/sync", { method: "POST" });
    const d = await res.json();
    if (!res.ok) return setError(d.error || "Sync failed");
    setMessage(d.message || "Sync completed");
    await loadCustomers(1);
    const s = await fetch("/api/analytics/summary", { cache: "no-store" }).then((r) => r.json());
    setSummary(s);
  };

  const exportCustomerPdf = (c: Customer) => {
    const doc = new jsPDF();
    doc.text(`Customer - ${c.name}`, 14, 16);
    autoTable(doc, { startY: 24, head: [["Metric", "Value"]], body: [["Email", c.email], ["Total Paid", money(c.totalPaid)], ["Active Subscriptions", String(c.activeSubscriptions)], ["Tier", c.tier], ["Risk", c.riskLevel], ["AI", c.aiSummary]] });
    doc.save(`customer-${c.email}.pdf`);
  };

  const vipWatch = useMemo(() => [...customers].sort((a, b) => b.totalPaid - a.totalPaid).slice(0, 5), [customers]);

  return <main className="min-h-screen bg-gradient-to-b from-zinc-950 to-black p-4 text-zinc-100 md:p-8">
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-3xl font-bold text-red-400">Red Spectrum Intelligence</h1><p className="text-zinc-400">Multi-source subscriptions, risk review, and recurring revenue analytics.</p></div><button onClick={syncWooCommerce} className="rounded bg-red-600 px-4 py-2 font-semibold hover:bg-red-500">Sync Center</button></header>
      <nav className="sticky top-0 z-10 flex gap-2 overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/80 p-2 backdrop-blur">{tabs.map((t)=><button key={t} onClick={()=>setTab(t)} className={`rounded px-3 py-2 text-sm ${tab===t?"bg-red-600 text-white":"bg-zinc-800 text-zinc-300"}`}>{t}</button>)}</nav>
      {error && <p className="rounded border border-red-800 bg-red-950/50 p-3">{error}</p>}
      {message && <p className="rounded border border-emerald-800 bg-emerald-950/50 p-3">{message}</p>}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
        ["Total Subscriptions", Number(summary.totalSubscriptions ?? 0)],
        ["Active Subscriptions", Number(summary.activeSubscriptions ?? 0)],
        ["MRR", money(Number(summary.monthlyRecurringRevenue ?? 0))],
        ["Upcoming 30d", Number(summary.upcomingBills30d ?? 0)],
        ["Failed Payments", Number(summary.failedPayments ?? 0)],
        ["Est. Upcoming Revenue", money(Number(summary.estimatedUpcomingRevenue30d ?? 0))],
      ].map(([k,v])=><div key={String(k)} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"><p className="text-xs uppercase text-zinc-400">{k}</p><p className="mt-2 text-2xl font-semibold">{String(v)}</p></div>)}</section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"><h2 className="mb-3 text-lg font-semibold text-amber-200">VIP Watchlist</h2><div className="grid gap-2 md:grid-cols-5">{vipWatch.map((c)=><div key={c._id} className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-sm"><p className="font-semibold">{c.name}</p><p>{money(c.totalPaid)}</p><p>{c.activeSubscriptions} active subs</p></div>)}</div></section>

      <div className="overflow-auto rounded-xl border border-zinc-800"><table className="min-w-full text-xs"><thead className="bg-zinc-950"><tr>{["Customer","Category","Tier","Paid","Active Subs","Risk","Score","Preview","Actions"].map((h)=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead><tbody>{customers.map((c)=>{const cat=getCustomerCategory(c);return <tr key={c._id} className={`border-t border-zinc-800 ${cat==="vip"?"bg-amber-500/5":cat==="risk"?"bg-red-500/5":""}`}><td className="px-3 py-2"><p className="font-semibold">{c.name}</p><p className="text-zinc-400">{c.email}</p></td><td className="px-3 py-2"><span className={`rounded border px-2 py-1 uppercase ${badgeClass[cat]}`}>{cat}</span></td><td className="px-3 py-2">{c.tier}</td><td className="px-3 py-2">{money(c.totalPaid)}</td><td className="px-3 py-2">{c.activeSubscriptions}</td><td className="px-3 py-2">{c.riskLevel}</td><td className="px-3 py-2">{c.score}/{c.stars}★</td><td className="max-w-[240px] truncate px-3 py-2">{c.aiSummaryPreview}</td><td className="px-3 py-2"><div className="flex gap-2"><Link className="rounded bg-zinc-700 px-2 py-1" href={`/admin/customers/${c._id}`}>View</Link><button onClick={()=>exportCustomerPdf(c)} className="rounded bg-red-700 px-2 py-1">PDF</button></div></td></tr>;})}</tbody></table></div>
      <div className="flex items-center justify-between"><p className="text-sm text-zinc-400">Showing page {page}. Total rows: {total}</p><div className="flex gap-2"><button disabled={page<=1} onClick={()=>loadCustomers(page-1)} className="rounded bg-zinc-800 px-3 py-1 disabled:opacity-50">Prev</button><button onClick={()=>loadCustomers(page+1)} className="rounded bg-zinc-800 px-3 py-1">Next</button></div></div>
    </div>
  </main>;
}
