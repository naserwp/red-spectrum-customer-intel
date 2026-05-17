"use client";

import { useEffect, useMemo, useState } from "react";

type Customer = {
  _id: string;
  name: string;
  email: string;
  phone: string;
  totalPaid: number;
  orderCount: number;
  lastOrderDate: string;
  lastOrderAmount: number;
  subscriptionStatus: string;
  activeSubscriptions: number;
  failedPayments: number;
  refunds: number;
  chargebacks: number;
  creditLimit: number;
  tier: string;
  score: number;
  stars: number;
  aiSummary: string;
  recommendedAction: string;
};

async function fetchCustomersData() {
  const response = await fetch("/api/customers");
  return response.json();
}

export default function AdminPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [filters, setFilters] = useState({ min: "", max: "", stars: "", status: "", q: "" });

  useEffect(() => {
    fetchCustomersData()
      .then((data) => {
        if (data.error) {
          setError(data.error);
          return;
        }

        setError("");
        setCustomers(data.customers || []);
      })
      .catch(() => setError("Unable to load customers."));
  }, []);

  const syncWooCommerce = async () => {
    setIsSyncing(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/customers/sync", { method: "POST" });
      const data = await response.json();

      if (!response.ok || data.error) {
        setError(data.error || "Unable to sync WooCommerce data.");
        return;
      }

      setMessage(data.message || "WooCommerce sync completed.");
      const customersData = await fetchCustomersData();
      if (customersData.error) {
        setError(customersData.error);
        return;
      }
      setCustomers(customersData.customers || []);
    } catch {
      setError("Unable to sync WooCommerce data.");
    } finally {
      setIsSyncing(false);
    }
  };

  const filtered = useMemo(() => customers.filter((c) => {
    const minOk = !filters.min || c.totalPaid >= Number(filters.min);
    const maxOk = !filters.max || c.totalPaid <= Number(filters.max);
    const starOk = !filters.stars || c.stars === Number(filters.stars);
    const statusOk = !filters.status || c.subscriptionStatus === filters.status;
    const q = filters.q.toLowerCase();
    const qOk = !q || [c.name, c.email, c.phone].some((v) => v.toLowerCase().includes(q));
    return minOk && maxOk && starOk && statusOk && qOk;
  }), [customers, filters]);

  const exportCsv = () => {
    const headers = ["Customer Name","Email","Phone","Total Paid","Order Count","Last Order Date","Last Order Amount","Subscription Status","Active Subscriptions","Failed Payments","Refunds","Chargebacks","Credit Limit","Tier","Score","Stars","AI Summary","Recommended Action"];
    const rows = filtered.map((c) => [c.name,c.email,c.phone,c.totalPaid,c.orderCount,c.lastOrderDate,c.lastOrderAmount,c.subscriptionStatus,c.activeSubscriptions,c.failedPayments,c.refunds,c.chargebacks,c.creditLimit,c.tier,c.score,c.stars,c.aiSummary,c.recommendedAction]);
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "red-spectrum-customers.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-white p-4 md:p-8">
      <h1 className="text-3xl font-bold text-red-500">Admin Dashboard</h1>
      <p className="mt-2 text-zinc-300">Customer intelligence overview and export.</p>
      {error && <p className="mt-4 rounded bg-red-900/60 p-3">{error}</p>}
      {message && <p className="mt-4 rounded bg-emerald-900/60 p-3">{message}</p>}

      <div className="mt-6 grid gap-3 md:grid-cols-5">
        {['min','max','q'].map(()=>null)}
        <input placeholder="Min amount" className="rounded bg-zinc-800 p-2" value={filters.min} onChange={(e)=>setFilters({...filters,min:e.target.value})}/>
        <input placeholder="Max amount" className="rounded bg-zinc-800 p-2" value={filters.max} onChange={(e)=>setFilters({...filters,max:e.target.value})}/>
        <input placeholder="Search name/email/phone" className="rounded bg-zinc-800 p-2 md:col-span-2" value={filters.q} onChange={(e)=>setFilters({...filters,q:e.target.value})}/>
        <select className="rounded bg-zinc-800 p-2" value={filters.stars} onChange={(e)=>setFilters({...filters,stars:e.target.value})}><option value="">All stars</option><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select>
        <select className="rounded bg-zinc-800 p-2" value={filters.status} onChange={(e)=>setFilters({...filters,status:e.target.value})}><option value="">All subscription status</option><option value="active">active</option><option value="inactive">inactive</option><option value="canceled">canceled</option><option value="past_due">past_due</option><option value="unknown">unknown</option></select>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button onClick={syncWooCommerce} disabled={isSyncing} className="rounded bg-red-600 px-4 py-2 font-semibold hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-zinc-700">{isSyncing ? "Syncing..." : "Sync WooCommerce Data"}</button>
        <button onClick={exportCsv} className="rounded bg-zinc-800 px-4 py-2 font-semibold hover:bg-zinc-700">Export CSV</button>
      </div>

      <div className="mt-6 overflow-x-auto rounded border border-zinc-700">
        <table className="min-w-full text-sm">
          <thead className="bg-black text-red-400"><tr>{["Customer Name","Email","Phone","Total Paid","Order Count","Last Order Date","Last Order Amount","Subscription Status","Active Subscriptions","Failed Payments","Refunds","Chargebacks","Credit Limit","Tier","Score","Stars","AI Summary","Recommended Action"].map((h)=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr></thead>
          <tbody>{filtered.map((c)=><tr key={c._id} className="border-t border-zinc-800 align-top"><td className="px-3 py-2">{c.name}</td><td className="px-3 py-2">{c.email}</td><td className="px-3 py-2">{c.phone}</td><td className="px-3 py-2">${c.totalPaid.toFixed(2)}</td><td className="px-3 py-2">{c.orderCount}</td><td className="px-3 py-2">{new Date(c.lastOrderDate).toLocaleDateString()}</td><td className="px-3 py-2">${c.lastOrderAmount.toFixed(2)}</td><td className="px-3 py-2">{c.subscriptionStatus}</td><td className="px-3 py-2">{c.activeSubscriptions}</td><td className="px-3 py-2">{c.failedPayments}</td><td className="px-3 py-2">{c.refunds}</td><td className="px-3 py-2">{c.chargebacks}</td><td className="px-3 py-2">${c.creditLimit.toFixed(2)}</td><td className="px-3 py-2">{c.tier}</td><td className="px-3 py-2">{c.score}</td><td className="px-3 py-2">{"★".repeat(c.stars)}</td><td className="px-3 py-2">{c.aiSummary}</td><td className="px-3 py-2">{c.recommendedAction}</td></tr>)}</tbody>
        </table>
      </div>

      <p className="mt-6 text-xs text-zinc-400">TODO: Integrate WooCommerce, Stripe, Authorize.net, NMI, Gmail API, and WordPress email logs.</p>
    </main>
  );
}
