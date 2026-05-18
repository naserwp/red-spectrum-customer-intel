"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

type CustomerDetail = {
  [key: string]: string | number | null | string[] | undefined;
  name: string; email: string; phone?: string; totalPaid: number; paidTotal?: number; attemptedTotal?: number;
  paidOrderCount?: number; attemptedOrderCount?: number; leadStatus?: string; paymentStatus?: string; lastPaidDate?: string; lastAttemptDate?: string;
  orderCount: number; averageOrderValue: number; firstOrderDate: string; lastOrderDate: string; failedPayments: number; refunds: number;
  chargebacks: number; subscriptionStatus: string; score?: number; stars?: number; tier: string; riskLevel: string; estimatedCreditLimit: number;
  actualCreditLimit: number | null; lastSyncedAt: string; aiSummary: string; riskExplanation: string; recommendedAction: string; notes?: string; tags?: string[];
};

const displayDate = (value?: string) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString();
};

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

  if (!customer) return <main className="min-h-screen bg-black p-8 text-zinc-300">Loading customer details...</main>;
  const actualPaid = Number(customer.paidTotal ?? customer.totalPaid ?? 0);
  const attempted = Number(customer.attemptedTotal ?? 0);

  return <main className="min-h-screen bg-black p-4 text-zinc-100 md:p-8">
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-3xl font-bold text-red-400">{customer.name}</h1>
      <p className="text-zinc-400">{customer.email} - {customer.phone || "N/A"}</p>
      <div className="grid gap-3 md:grid-cols-3">{[
        ["Actual Paid", `$${actualPaid.toFixed(2)}`],
        ["Attempted Amount", `$${attempted.toFixed(2)}`],
        ["Paid Orders", customer.paidOrderCount ?? 0],
        ["Attempted Orders", customer.attemptedOrderCount ?? 0],
        ["Lead Status", customer.leadStatus ?? "-"],
        ["Payment Status", customer.paymentStatus ?? "-"],
        ["Last Paid", displayDate(customer.lastPaidDate)],
        ["Last Attempt", displayDate(customer.lastAttemptDate)],
        ["Order Count", customer.orderCount],
        ["Average Order Value", `$${Number(customer.averageOrderValue ?? 0).toFixed(2)}`],
        ["First Order", displayDate(customer.firstOrderDate)],
        ["Last Order", displayDate(customer.lastOrderDate)],
        ["Failed Payments", customer.failedPayments],
        ["Refunds", customer.refunds],
        ["Chargebacks", customer.chargebacks],
        ["Subscription", customer.subscriptionStatus],
        ["Score", `${customer.score ?? "-"} (${customer.stars ?? "-"} stars)`],
        ["Tier", actualPaid > 0 ? customer.tier : "Lead"],
        ["Risk", customer.riskLevel],
        ["Estimated Credit", `$${Number(customer.estimatedCreditLimit ?? 0).toFixed(2)}`],
        ["Actual Credit", customer.actualCreditLimit ?? "Not reported"],
        ["Last Synced", new Date(customer.lastSyncedAt).toLocaleString()],
      ].map(([k, v]) => <div key={String(k)} className="rounded border border-zinc-800 bg-zinc-900 p-3"><p className="text-xs uppercase text-zinc-400">{k}</p><p className="text-lg font-semibold">{String(v)}</p></div>)}</div>
      <section className="rounded border border-zinc-800 bg-zinc-900 p-4"><h2 className="font-semibold text-red-300">AI Summary</h2><p className="mt-2 text-zinc-300">{customer.aiSummary}</p><p className="mt-2 text-zinc-400">Risk explanation: {customer.riskExplanation}</p><p className="mt-2 text-zinc-200">Recommended next action: {customer.recommendedAction}</p></section>
      <section className="rounded border border-zinc-800 bg-zinc-900 p-4"><h2 className="font-semibold text-red-300">Internal Review</h2><input className="mt-2 w-full rounded bg-zinc-800 p-2" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags, separated, by commas" /><textarea className="mt-2 h-32 w-full rounded bg-zinc-800 p-2" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes" /><button className="mt-2 rounded bg-red-700 px-4 py-2" onClick={save}>Save Notes</button>{message && <p className="mt-2 text-emerald-300">{message}</p>}</section>
      <section className="rounded border border-zinc-800 bg-zinc-900 p-4"><h2 className="font-semibold text-amber-300">Subscriptions and Candidates</h2><div className="mt-2 space-y-2">{subscriptions.length === 0 ? <p className="text-zinc-400">No linked subscription or recurring product candidate records.</p> : subscriptions.map((sub) => <div key={String(sub.subscriptionId)} className="rounded border border-zinc-700 p-2 text-sm"><p className="font-semibold">{String(sub.source)} - {String(sub.subscriptionId)}</p><p>Status: {String(sub.status)} | Amount: {String(sub.amount)} | Next Bill: {String(sub.nextBillingDate || "N/A")}</p></div>)}</div></section>
    </div>
  </main>;
}
