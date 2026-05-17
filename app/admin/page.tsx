"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Customer = Record<string, string | number | null> & { _id: string; name: string; email: string; totalPaid: number; paidTotal: number; attemptedTotal: number; paidOrderCount: number; attemptedOrderCount: number; activeSubscriptions: number; failedPayments: number; chargebacks: number; tier: string; riskLevel: string; score: number; stars: number; aiSummaryPreview: string; paymentStatus: string; leadStatus: string; lastPaidDate: string; lastAttemptDate: string; subscriptionStatus: string; refunds: number; };
const money = (n: number) => `$${n.toFixed(2)}`;
const tabs = ["Overview", "Customers", "Subscriptions", "Credits", "Payments", "Upcoming Bills", "High Value", "Risk Review", "Sync Center"] as const;

export default function AdminPage() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown>>({});
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const load = useCallback(async (nextPage = 1) => {
    const data = await fetch(`/api/customers/table?page=${nextPage}&limit=30`, { cache: "no-store" }).then((r) => r.json());
    setRows(data.rows || []); setTotal(data.total || 0); setPage(data.page || nextPage);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(1).catch(() => setError("Unable to load customers."));
    fetch("/api/analytics/summary", { cache: "no-store" }).then((r)=>r.json()).then(setSummary).catch(()=>setSummary({}));
  }, [load]);

  const vipPaid = useMemo(() => rows.filter((c) => (c.paidTotal ?? 0) >= 2000).slice(0, 5), [rows]);
  const hotLeads = useMemo(() => rows.filter((c) => (c.paidTotal ?? 0) <= 0 && (c.attemptedTotal ?? 0) > 0).slice(0, 5), [rows]);

  const sync = async () => { setMessage("Syncing..."); const res = await fetch('/api/customers/sync',{method:'POST'}); const d = await res.json(); if(!res.ok)return setError(d.error||'Sync failed'); setMessage(d.message||'Sync complete'); await load(1); };

  return <main className="min-h-screen bg-gradient-to-b from-zinc-950 via-black to-zinc-900 p-4 text-zinc-100 md:p-8"><div className="mx-auto max-w-7xl space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-3xl font-bold text-red-400">Red Spectrum Admin</h1><p className="text-zinc-400">Stabilized payment-aware customer intelligence.</p></div><button onClick={sync} className="rounded bg-red-600 px-4 py-2 font-semibold hover:bg-red-500">Sync WooCommerce</button></header>
    <nav className="flex gap-2 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/80 p-2">{tabs.map((t)=><button key={t} onClick={()=>setTab(t)} className={`rounded px-3 py-2 text-sm ${tab===t?"bg-red-600":"bg-zinc-800"}`}>{t}</button>)}</nav>
    {error && <p className="rounded border border-red-800 bg-red-900/40 p-3">{error}</p>}{message && <p className="rounded border border-emerald-800 bg-emerald-900/30 p-3">{message}</p>}
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Total Customers", Number(summary.customerCount ?? 0)],["Total Revenue", money(Number(summary.totalRevenue ?? 0))],["Average Order Value", money(Number(summary.totalRevenue ?? 0) / Math.max(1, Number(summary.customerCount ?? 1)))],["High Value Customers", rows.filter((c)=>(c.paidTotal??0)>=2000).length],["Risk Customers", rows.filter((c)=>(c.failedPayments??0)>1 || (c.chargebacks??0)>0).length],["Failed Payments", Number(summary.failedPayments ?? 0)],["Refunds", rows.reduce((a,c)=>a+Number(c.refunds ?? 0),0)],["Chargebacks", rows.reduce((a,c)=>a+Number(c.chargebacks ?? 0),0)]].map(([k,v])=><div key={String(k)} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"><p className="text-xs uppercase text-zinc-400">{k}</p><p className="mt-2 text-2xl font-semibold">{String(v)}</p></div>)}</section>
    <section className="grid gap-3 md:grid-cols-2"><div className="rounded-xl border border-amber-600/40 bg-amber-900/10 p-4"><h3 className="font-semibold text-amber-200">VIP Paid Customers</h3>{vipPaid.map((c)=><p key={c._id} className="mt-1 text-sm">{c.name} · {money(Number(c.paidTotal ?? 0))}</p>)}</div><div className="rounded-xl border border-rose-600/40 bg-rose-900/10 p-4"><h3 className="font-semibold text-rose-200">Hot Checkout Leads</h3>{hotLeads.map((c)=><p key={c._id} className="mt-1 text-sm">{c.name} · attempted {money(Number(c.attemptedTotal ?? 0))}</p>)}</div></section>
    <div className="overflow-x-auto rounded-xl border border-zinc-800"><table className="min-w-full text-xs"><thead className="bg-zinc-950"><tr>{["Customer","Actual Paid","Attempted Amount","Paid Orders","Checkout Attempts","Last Paid","Last Attempt","Payment Status","Lead Status","Tier","Risk","AI Preview","Actions"].map((h)=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead><tbody>{rows.map((c)=><tr key={c._id} className="border-t border-zinc-800"><td className="px-3 py-2"><p className="font-semibold">{c.name}</p><p className="text-zinc-400">{c.email}</p></td><td className="px-3 py-2">{money(Number(c.paidTotal ?? 0))}</td><td className="px-3 py-2">{money(Number(c.attemptedTotal ?? 0))}</td><td className="px-3 py-2">{Number(c.paidOrderCount ?? 0)}</td><td className="px-3 py-2">{Number(c.attemptedOrderCount ?? 0)}</td><td className="px-3 py-2">{String(c.lastPaidDate || "-")}</td><td className="px-3 py-2">{String(c.lastAttemptDate || "-")}</td><td className="px-3 py-2">{String(c.paymentStatus || "-")}</td><td className="px-3 py-2">{String(c.leadStatus || "-")}</td><td className="px-3 py-2">{c.tier}</td><td className="px-3 py-2">{c.riskLevel}</td><td className="max-w-[260px] truncate px-3 py-2">{c.aiSummaryPreview}</td><td className="px-3 py-2"><div className="flex gap-2"><Link href={`/admin/customers/${c._id}`} className="rounded bg-zinc-700 px-2 py-1">View</Link><a href={`/api/customers/${c._id}/pdf`} target="_blank" className="rounded bg-red-700 px-2 py-1">PDF</a></div></td></tr>)}</tbody></table></div>
    <div className="flex items-center justify-between"><p className="text-sm text-zinc-400">Page {page}. Total: {total}</p><div className="flex gap-2"><button disabled={page<=1} onClick={()=>load(page-1)} className="rounded bg-zinc-800 px-3 py-1 disabled:opacity-50">Prev</button><button onClick={()=>load(page+1)} className="rounded bg-zinc-800 px-3 py-1">Next</button></div></div>
  </div></main>;
}
