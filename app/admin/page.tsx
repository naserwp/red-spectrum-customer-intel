"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type Customer = Record<string, string | number | null> & { _id: string; name: string; email: string; phone: string; totalPaid: number; activeSubscriptions: number; failedPayments: number; chargebacks: number; estimatedCreditLimit: number; tier: string; riskLevel: string; score: number; stars: number; aiSummaryPreview: string; subscriptionStatus: string; orderCount: number; averageOrderValue: number; refunds: number; };
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
  const [filters, setFilters] = useState({ min: "", max: "", q: "", stars: "", status: "", tier: "", risk: "", failed: false, refunds: false, chargebacks: false });

  const load = useCallback(async (nextPage = 1) => {
    const data = await fetch(`/api/customers/table?page=${nextPage}&limit=30&q=${encodeURIComponent(filters.q)}&risk=${encodeURIComponent(filters.risk)}`, { cache: "no-store" }).then((r) => r.json());
    setRows(data.rows || []); setTotal(data.total || 0); setPage(data.page || nextPage);
  }, [filters.q, filters.risk]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(1).catch(() => setError("Unable to load customers."));
    fetch("/api/analytics/summary", { cache: "no-store" }).then((r)=>r.json()).then(setSummary).catch(()=>setSummary({}));
  }, [load]);

  const filtered = useMemo(() => rows.filter((c) => (!filters.min || c.totalPaid >= Number(filters.min)) && (!filters.max || c.totalPaid <= Number(filters.max)) && (!filters.stars || c.stars === Number(filters.stars)) && (!filters.status || c.subscriptionStatus === filters.status) && (!filters.tier || c.tier === filters.tier) && (!filters.risk || c.riskLevel === filters.risk) && (!filters.failed || c.failedPayments > 0) && (!filters.refunds || c.refunds > 0) && (!filters.chargebacks || c.chargebacks > 0)), [rows, filters]);

  const sync = async () => { setMessage("Syncing..."); const res = await fetch('/api/customers/sync',{method:'POST'}); const d = await res.json(); if(!res.ok)return setError(d.error||'Sync failed'); setMessage(d.message||'Sync complete'); await load(1); };
  const highValueCount = filtered.filter((c) => c.totalPaid >= 2000 || c.estimatedCreditLimit >= 10000 || c.activeSubscriptions >= 2).length;
  const riskCount = filtered.filter((c) => c.failedPayments > 1 || c.chargebacks > 0).length;

  return <main className="min-h-screen bg-gradient-to-b from-zinc-950 via-black to-zinc-900 p-4 text-zinc-100 md:p-8"><div className="mx-auto max-w-7xl space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-3xl font-bold text-red-400">Red Spectrum Admin</h1><p className="text-zinc-400">Customer intelligence and webhook-driven risk monitoring.</p></div><button onClick={sync} className="rounded bg-red-600 px-4 py-2 font-semibold hover:bg-red-500">Sync WooCommerce</button></header>
    <nav className="flex gap-2 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/80 p-2">{tabs.map((t)=><button key={t} onClick={()=>setTab(t)} className={`rounded px-3 py-2 text-sm ${tab===t?"bg-red-600":"bg-zinc-800"}`}>{t}</button>)}</nav>
    {error && <p className="rounded border border-red-800 bg-red-900/40 p-3">{error}</p>}{message && <p className="rounded border border-emerald-800 bg-emerald-900/30 p-3">{message}</p>}
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Total Customers", Number(summary.customerCount ?? 0)],["Total Revenue", money(Number(summary.totalRevenue ?? 0))],["Average Order Value", money(Number(summary.totalRevenue ?? 0) / Math.max(1, Number(summary.customerCount ?? 1)))],["High Value Customers", highValueCount],["Risk Customers", riskCount],["Failed Payments", Number(summary.failedPayments ?? 0)],["Refunds", filtered.reduce((a,c)=>a+c.refunds,0)],["Chargebacks", filtered.reduce((a,c)=>a+c.chargebacks,0)]].map(([k,v])=><div key={String(k)} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"><p className="text-xs uppercase text-zinc-400">{k}</p><p className="mt-2 text-2xl font-semibold">{String(v)}</p></div>)}</section>
    <section className="grid gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 md:grid-cols-5"><input className="rounded bg-zinc-800 p-2" placeholder="Search" value={filters.q} onChange={(e)=>setFilters({...filters,q:e.target.value})}/><input className="rounded bg-zinc-800 p-2" placeholder="Min amount" value={filters.min} onChange={(e)=>setFilters({...filters,min:e.target.value})}/><input className="rounded bg-zinc-800 p-2" placeholder="Max amount" value={filters.max} onChange={(e)=>setFilters({...filters,max:e.target.value})}/><select className="rounded bg-zinc-800 p-2" value={filters.stars} onChange={(e)=>setFilters({...filters,stars:e.target.value})}><option value="">All stars</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select><select className="rounded bg-zinc-800 p-2" value={filters.status} onChange={(e)=>setFilters({...filters,status:e.target.value})}><option value="">All status</option><option value="active">active</option><option value="inactive">inactive</option><option value="canceled">canceled</option><option value="past_due">past_due</option><option value="unknown">unknown</option></select><select className="rounded bg-zinc-800 p-2" value={filters.tier} onChange={(e)=>setFilters({...filters,tier:e.target.value})}><option value="">All tiers</option><option>Platinum</option><option>Gold</option><option>Silver</option><option>Bronze</option></select><select className="rounded bg-zinc-800 p-2" value={filters.risk} onChange={(e)=>setFilters({...filters,risk:e.target.value})}><option value="">All risk</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.failed} onChange={(e)=>setFilters({...filters,failed:e.target.checked})}/>failed</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.refunds} onChange={(e)=>setFilters({...filters,refunds:e.target.checked})}/>refunds</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={filters.chargebacks} onChange={(e)=>setFilters({...filters,chargebacks:e.target.checked})}/>chargebacks</label></section>
    <div className="overflow-x-auto rounded-xl border border-zinc-800"><table className="min-w-full text-xs"><thead className="bg-zinc-950"><tr>{["Customer","Tier","Risk","Total Paid","Order Count","Status","Score","AI Preview","Actions"].map((h)=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead><tbody>{filtered.map((c)=><tr key={c._id} className="border-t border-zinc-800"><td className="px-3 py-2"><p className="font-semibold">{c.name}</p><p className="text-zinc-400">{c.email}</p></td><td className="px-3 py-2">{c.tier}</td><td className="px-3 py-2">{c.riskLevel}</td><td className="px-3 py-2">{money(c.totalPaid)}</td><td className="px-3 py-2">{c.orderCount}</td><td className="px-3 py-2">{c.subscriptionStatus}</td><td className="px-3 py-2">{c.score}/{c.stars}★</td><td className="max-w-[260px] truncate px-3 py-2">{c.aiSummaryPreview}</td><td className="px-3 py-2"><div className="flex gap-2"><Link href={`/admin/customers/${c._id}`} className="rounded bg-zinc-700 px-2 py-1">View Details</Link><a href={`/api/customers/${c._id}/pdf`} target="_blank" className="rounded bg-red-700 px-2 py-1">Export PDF</a></div></td></tr>)}</tbody></table></div>
    <div className="flex items-center justify-between"><p className="text-sm text-zinc-400">Page {page}. Total: {total}</p><div className="flex gap-2"><button disabled={page<=1} onClick={()=>load(page-1)} className="rounded bg-zinc-800 px-3 py-1 disabled:opacity-50">Prev</button><button onClick={()=>load(page+1)} className="rounded bg-zinc-800 px-3 py-1">Next</button></div></div>
  </div></main>;
}
