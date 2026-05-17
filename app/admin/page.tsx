"use client";

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Customer = {
  _id: string; name: string; email: string; phone: string; totalPaid: number; orderCount: number;
  firstOrderDate: string; lastOrderDate: string; averageOrderValue: number; subscriptionStatus: string;
  failedPayments: number; refunds: number; chargebacks: number; tier: string; riskLevel: string;
  score: number; stars: number; aiSummary: string; aiSummaryPreview: string; riskExplanation: string;
  recommendedAction: string; estimatedCreditLimit: number; actualCreditLimit: number | null; lastSyncedAt: string;
};

async function fetchCustomersData() {
  const response = await fetch("/api/customers", { cache: "no-store" });
  return response.json();
}

const money = (n: number) => `$${n.toFixed(2)}`;
const riskBadge: Record<string, string> = { low: "bg-emerald-900/50 text-emerald-300", medium: "bg-amber-900/50 text-amber-300", high: "bg-rose-900/50 text-rose-300" };

export default function AdminPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [filters, setFilters] = useState({ min: "", max: "", stars: "", status: "", tier: "", risk: "", q: "", failedOnly: false, refundsOnly: false, chargebacksOnly: false });

  useEffect(() => { fetchCustomersData().then((d) => setCustomers(d.customers || [])).catch(() => setError("Unable to load customers.")); }, []);

  const syncWooCommerce = async () => {
    setIsSyncing(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/customers/sync", { method: "POST" });
      const data = await response.json();
      if (!response.ok || data.error) return setError(data.error || "Unable to sync WooCommerce data.");
      setMessage(data.message || "WooCommerce sync completed.");
      const fresh = await fetchCustomersData();
      setCustomers(fresh.customers || []);
    } catch { setError("Unable to sync WooCommerce data."); }
    finally { setIsSyncing(false); }
  };

  const filtered = useMemo(() => customers.filter((c) => {
    const q = filters.q.toLowerCase();
    return (!filters.min || c.totalPaid >= Number(filters.min)) && (!filters.max || c.totalPaid <= Number(filters.max)) && (!filters.stars || c.stars === Number(filters.stars)) && (!filters.status || c.subscriptionStatus === filters.status) && (!filters.tier || c.tier === filters.tier) && (!filters.risk || c.riskLevel === filters.risk) && (!filters.failedOnly || c.failedPayments > 0) && (!filters.refundsOnly || c.refunds > 0) && (!filters.chargebacksOnly || c.chargebacks > 0) && (!q || [c.name, c.email, c.phone].some((v) => String(v ?? "").toLowerCase().includes(q)));
  }), [customers, filters]);

  const totals = useMemo(() => {
    const totalRevenue = filtered.reduce((a, c) => a + c.totalPaid, 0);
    const totalOrders = filtered.reduce((a, c) => a + c.orderCount, 0);
    return {
      totalCustomers: filtered.length,
      totalRevenue,
      avgOrderValue: totalOrders ? totalRevenue / totalOrders : 0,
      highValue: filtered.filter((c) => c.totalPaid >= 1000 || c.tier === "Platinum").length,
      failedPayments: filtered.reduce((a, c) => a + c.failedPayments, 0),
      refundsChargebacks: filtered.reduce((a, c) => a + c.refunds + c.chargebacks, 0),
    };
  }, [filtered]);

  const exportCsv = () => { /* existing behavior */
    const headers = ["Customer Name","Email","Phone","Total Paid","Order Count","Last Order Date","Average Order Value","Subscription Status","Risk","Tier","Score","AI Summary","Recommended Action"];
    const rows = filtered.map((c) => [c.name,c.email,c.phone,c.totalPaid,c.orderCount,c.lastOrderDate,c.averageOrderValue,c.subscriptionStatus,c.riskLevel,c.tier,c.score,c.aiSummary,c.recommendedAction]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "red-spectrum-customers.csv"; a.click(); URL.revokeObjectURL(url);
  };

  const exportCustomerPdf = (c: Customer) => {
    const doc = new jsPDF();
    doc.setFontSize(16); doc.text(`Customer Intelligence Report - ${c.name}`, 14, 16);
    doc.setFontSize(10);
    doc.text(`Email: ${c.email} | Phone: ${c.phone || "N/A"}`, 14, 24);
    autoTable(doc, { startY: 30, head: [["Metric", "Value"]], body: [
      ["Total Paid", money(c.totalPaid)], ["Order Count", String(c.orderCount)], ["Avg Order Value", money(c.averageOrderValue || 0)], ["First Order", new Date(c.firstOrderDate).toLocaleDateString()], ["Last Order", new Date(c.lastOrderDate).toLocaleDateString()], ["Failed Payments", String(c.failedPayments)], ["Refunds", String(c.refunds)], ["Chargebacks", String(c.chargebacks)], ["Tier", c.tier], ["Risk", c.riskLevel], ["Score", `${c.score} (${c.stars}★)`], ["Estimated Credit", money(c.estimatedCreditLimit || 0)], ["Actual Credit", c.actualCreditLimit == null ? "Not reported" : money(c.actualCreditLimit)], ["Subscription", c.subscriptionStatus], ["Recommended Action", c.recommendedAction], ["Risk Explanation", c.riskExplanation], ["AI Summary", c.aiSummary],
    ] });
    doc.save(`customer-${c.email}.pdf`);
  };

  return <main className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-black text-zinc-100 p-4 md:p-8">
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap justify-between gap-3"><div><h1 className="text-3xl font-bold text-red-400">Red Spectrum Customer Intelligence</h1><p className="text-zinc-400">Operational review, risk scoring, and AI-assisted account actions.</p></div><div className="flex gap-2"><button onClick={syncWooCommerce} disabled={isSyncing} className="rounded bg-red-600 px-4 py-2 font-semibold hover:bg-red-500 disabled:bg-zinc-700">{isSyncing ? "Syncing..." : "Sync WooCommerce"}</button><button onClick={exportCsv} className="rounded bg-zinc-800 px-4 py-2 font-semibold hover:bg-zinc-700">Export CSV</button></div></header>
      {error && <p className="rounded border border-red-800 bg-red-950/60 p-3 text-red-300">{error}</p>}
      {message && <p className="rounded border border-emerald-800 bg-emerald-950/60 p-3 text-emerald-300">{message}</p>}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">{[["Total Customers",totals.totalCustomers],["Total Revenue",money(totals.totalRevenue)],["Average Order Value",money(totals.avgOrderValue)],["Active/High Value",totals.highValue],["Failed Payments",totals.failedPayments],["Refunds/Chargebacks",totals.refundsChargebacks]].map(([k,v])=><div key={String(k)} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"><p className="text-xs uppercase tracking-wider text-zinc-400">{k}</p><p className="mt-2 text-2xl font-semibold text-white">{v}</p></div>)}</section>
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 grid gap-2 md:grid-cols-5"><input placeholder="Search" className="rounded bg-zinc-800 p-2" value={filters.q} onChange={(e)=>setFilters({...filters,q:e.target.value})}/><input placeholder="Min amount" className="rounded bg-zinc-800 p-2" value={filters.min} onChange={(e)=>setFilters({...filters,min:e.target.value})}/><input placeholder="Max amount" className="rounded bg-zinc-800 p-2" value={filters.max} onChange={(e)=>setFilters({...filters,max:e.target.value})}/><select className="rounded bg-zinc-800 p-2" value={filters.tier} onChange={(e)=>setFilters({...filters,tier:e.target.value})}><option value="">All tiers</option><option>Platinum</option><option>Gold</option><option>Silver</option><option>Bronze</option></select><select className="rounded bg-zinc-800 p-2" value={filters.risk} onChange={(e)=>setFilters({...filters,risk:e.target.value})}><option value="">All risk levels</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></section>
      <div className="overflow-x-auto rounded-xl border border-zinc-800"><table className="min-w-full text-xs"><thead className="bg-zinc-950 text-zinc-300"><tr>{["Name","Tier","Risk","Total Paid","Orders","Status","Score","AI Preview","Actions"].map((h)=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead><tbody>{filtered.length===0?<tr><td className="px-3 py-8 text-center text-zinc-400" colSpan={9}>No customers match current filters.</td></tr>:filtered.map((c)=><tr key={c._id} className="border-t border-zinc-800 hover:bg-zinc-900/60"><td className="px-3 py-2"><p className="font-medium">{c.name}</p><p className="text-zinc-400">{c.email}</p></td><td className="px-3 py-2">{c.tier}</td><td className="px-3 py-2"><span className={`rounded px-2 py-1 text-[10px] uppercase ${riskBadge[c.riskLevel] ?? riskBadge.low}`}>{c.riskLevel}</span></td><td className="px-3 py-2">{money(c.totalPaid)}</td><td className="px-3 py-2">{c.orderCount}</td><td className="px-3 py-2">{c.subscriptionStatus}</td><td className="px-3 py-2">{c.score} / {c.stars}★</td><td className="max-w-[280px] truncate px-3 py-2 text-zinc-300">{c.aiSummaryPreview || c.aiSummary}</td><td className="px-3 py-2"><div className="flex gap-2"><Link className="rounded bg-zinc-700 px-2 py-1 hover:bg-zinc-600" href={`/admin/customers/${c._id}`}>View Details</Link><button onClick={()=>exportCustomerPdf(c)} className="rounded bg-red-700 px-2 py-1 hover:bg-red-600">Export PDF</button></div></td></tr>)}</tbody></table></div>
    </div>
  </main>;
}
