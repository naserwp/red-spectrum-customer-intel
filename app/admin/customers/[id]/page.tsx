"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  type CustomerDetail = { [key: string]: string | number | null | string[] | undefined; name: string; email: string; phone?: string; totalPaid: number; orderCount: number; averageOrderValue: number; firstOrderDate: string; lastOrderDate: string; failedPayments: number; refunds: number; chargebacks: number; subscriptionStatus: string; score?: number; stars?: number; tier: string; riskLevel: string; estimatedCreditLimit: number; actualCreditLimit: number | null; lastSyncedAt: string; aiSummary: string; riskExplanation: string; recommendedAction: string; notes?: string; tags?: string[] };
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`/api/customers/${params.id}`).then((r) => r.json()).then((d) => {
      setCustomer(d.customer); setNotes(d.customer?.notes ?? ""); setTags((d.customer?.tags ?? []).join(", "));
    });
  }, [params.id]);

  const save = async () => {
    const response = await fetch(`/api/customers/${params.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }) });
    const data = await response.json();
    setMessage(data.message || "Saved");
    setCustomer(data.customer);
  };

  if (!customer) return <main className="min-h-screen bg-black p-8 text-zinc-300">Loading customer details…</main>;
  return <main className="min-h-screen bg-black p-4 md:p-8 text-zinc-100"><div className="mx-auto max-w-5xl space-y-4"><h1 className="text-3xl font-bold text-red-400">{customer.name}</h1><p className="text-zinc-400">{customer.email} • {customer.phone || "N/A"}</p><div className="grid gap-3 md:grid-cols-3">{[["Total Paid",customer.totalPaid],["Order Count",customer.orderCount],["Average Order Value",customer.averageOrderValue],["First Order",new Date(customer.firstOrderDate).toLocaleDateString()],["Last Order",new Date(customer.lastOrderDate).toLocaleDateString()],["Failed Payments",customer.failedPayments],["Refunds",customer.refunds],["Chargebacks",customer.chargebacks],["Subscription",customer.subscriptionStatus],["Score",`${customer.score ?? "-"} (${customer.stars ?? "-"}★)`],["Tier",customer.tier],["Risk",customer.riskLevel],["Estimated Credit",customer.estimatedCreditLimit],["Actual Credit",customer.actualCreditLimit ?? "Not reported"],["Last Synced",new Date(customer.lastSyncedAt).toLocaleString()]].map(([k,v])=><div key={String(k)} className="rounded border border-zinc-800 bg-zinc-900 p-3"><p className="text-xs uppercase text-zinc-400">{k}</p><p className="text-lg font-semibold">{String(v)}</p></div>)}</div><section className="rounded border border-zinc-800 bg-zinc-900 p-4"><h2 className="font-semibold text-red-300">AI Summary</h2><p className="mt-2 text-zinc-300">{customer.aiSummary}</p><p className="mt-2 text-zinc-400">Risk explanation: {customer.riskExplanation}</p><p className="mt-2 text-zinc-200">Recommended next action: {customer.recommendedAction}</p></section><section className="rounded border border-zinc-800 bg-zinc-900 p-4"><h2 className="font-semibold text-red-300">Internal Review</h2><input className="mt-2 w-full rounded bg-zinc-800 p-2" value={tags} onChange={(e)=>setTags(e.target.value)} placeholder="tags, separated, by commas"/><textarea className="mt-2 h-32 w-full rounded bg-zinc-800 p-2" value={notes} onChange={(e)=>setNotes(e.target.value)} placeholder="Internal notes"/><button className="mt-2 rounded bg-red-700 px-4 py-2" onClick={save}>Save Notes</button>{message && <p className="mt-2 text-emerald-300">{message}</p>}</section></div></main>;
}
