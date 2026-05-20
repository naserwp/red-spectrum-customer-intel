"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminHeader } from "@/app/admin/_components/AdminHeader";
import { AdminLayout, AdminLoadingState } from "@/app/admin/_components/AdminLayout";

type FundingRow = {
  _id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  industry: string;
  industryClassification: string;
  naicsCode: string;
  sicCode: string;
  fundingReadinessScore: number;
  fundingReadinessTier: string;
  vipTier: string;
  lifetimeSpent: number;
  estimatedMRR: number;
  paidMonths: number;
  activeRecurring: number;
  creditLimit: number;
  potentialCreditLimit: number;
  net30Status: string;
  profileCompleteness: number;
  riskLevel: string;
  fundingInsight: string;
  riskInsight: string;
  recommendedAction: string;
};

type FundingResponse = {
  rows: FundingRow[];
  total: number;
  page: number;
  limit: number;
  summary: {
    totalCandidates: number;
    fundingReady: number;
    vipReady: number;
    averageScore: number;
    totalLifetimeValue: number;
  };
};

const money = (value: number) => `$${Number(value ?? 0).toFixed(2)}`;
const scoreClass = (score: number) => score >= 75 ? "text-emerald-300" : score >= 55 ? "text-amber-300" : "text-red-300";

function Card({ label, value, helper }: { label: string; value: string | number; helper?: string }) {
  return <div className="rounded-xl border border-zinc-800 bg-zinc-900/85 p-4 shadow-lg shadow-black/20">
    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{label}</p>
    <p className="mt-2 text-2xl font-bold text-white">{value}</p>
    {helper && <p className="mt-1 text-xs text-zinc-500">{helper}</p>}
  </div>;
}

export default function FundingReadyPage() {
  const [rows, setRows] = useState<FundingRow[]>([]);
  const [summary, setSummary] = useState<FundingResponse["summary"] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [minSpent, setMinSpent] = useState("2000");
  const [readiness, setReadiness] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    setError("");
    const params = new URLSearchParams({ limit: "100", minSpent });
    if (query.trim()) params.set("q", query.trim());
    if (readiness) params.set("readiness", readiness);
    try {
      const response = await fetch(`/api/funding-ready?${params.toString()}`, { cache: "no-store" });
      const data = await response.json() as FundingResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "Funding readiness request failed.");
      setRows(data.rows ?? []);
      setSummary(data.summary ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load funding readiness data.");
    } finally {
      setIsLoading(false);
    }
  }, [minSpent, query, readiness]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const topIndustries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.industry, (counts.get(row.industry) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [rows]);

  return <AdminLayout header={<AdminHeader
    title="Funding Readiness Intelligence"
    description="Ranks customers for funding, Net 30, and credit-line outreach using stored revenue, subscription, gateway, and business profile data."
    actions={<Link href="/admin" className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-3 font-semibold text-zinc-200 transition hover:border-red-800 hover:bg-zinc-800">Back to Dashboard</Link>}
  />}>
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Card label="Candidates" value={summary?.totalCandidates ?? 0} />
      <Card label="Funding Ready" value={summary?.fundingReady ?? 0} helper="Score 65+" />
      <Card label="VIP Ready" value={summary?.vipReady ?? 0} helper="Score 75+ and high spend" />
      <Card label="Average Score" value={summary?.averageScore ?? 0} />
      <Card label="Filtered CLV" value={money(summary?.totalLifetimeValue ?? 0)} />
    </section>

    <section className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm text-zinc-300">
          <span className="block text-xs uppercase text-zinc-500">Search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-64 rounded bg-zinc-950 px-3 py-2 ring-1 ring-zinc-800" placeholder="Email, name, company" />
        </label>
        <label className="space-y-1 text-sm text-zinc-300">
          <span className="block text-xs uppercase text-zinc-500">Minimum Spend</span>
          <select value={minSpent} onChange={(event) => setMinSpent(event.target.value)} className="rounded bg-zinc-950 px-3 py-2 ring-1 ring-zinc-800">
            <option value="0">All customers</option>
            <option value="1000">$1,000+</option>
            <option value="2000">$2,000+</option>
            <option value="5000">$5,000+</option>
            <option value="10000">$10,000+</option>
          </select>
        </label>
        <label className="space-y-1 text-sm text-zinc-300">
          <span className="block text-xs uppercase text-zinc-500">Readiness</span>
          <select value={readiness} onChange={(event) => setReadiness(event.target.value)} className="rounded bg-zinc-950 px-3 py-2 ring-1 ring-zinc-800">
            <option value="">All tiers</option>
            <option value="Funding VIP Elite">Funding VIP Elite</option>
            <option value="Funding VIP">Funding VIP</option>
            <option value="Funding Ready">Funding Ready</option>
            <option value="Needs Enrichment">Needs Enrichment</option>
            <option value="Not Ready">Not Ready</option>
          </select>
        </label>
        <button onClick={load} className="rounded bg-red-700 px-5 py-2 font-semibold text-white hover:bg-red-600">Apply</button>
      </div>
      {topIndustries.length > 0 && <p className="mt-3 text-sm text-zinc-400">Top industries: {topIndustries.map(([industry, count]) => `${industry} (${count})`).join(", ")}</p>}
    </section>

    {error && <p className="rounded border border-red-800 bg-red-950/40 p-3 text-red-100">{error}</p>}
    {isLoading ? <AdminLoadingState title="Loading funding readiness..." subtext="Scoring customer value, profile quality, recurring revenue, and risk signals..." /> : <section className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="min-w-[1850px] text-sm">
        <thead className="sticky top-0 bg-zinc-950">
          <tr>{["Customer", "Score", "Funding Tier", "VIP Tier", "Industry", "NAICS/SIC", "Lifetime", "MRR", "Paid Months", "Credit Limit", "Profile", "Risk", "AI Funding Insight", "Action"].map((heading) => <th key={heading} className="px-3 py-3 text-left text-xs uppercase text-zinc-300">{heading}</th>)}</tr>
        </thead>
        <tbody>{rows.map((row) => <tr key={row._id} className="border-t border-zinc-800">
          <td className="px-3 py-3"><p className="font-semibold">{row.name}</p><p className="text-xs text-zinc-400">{row.email}</p><p className="text-xs text-zinc-500">{row.company || row.phone || "-"}</p></td>
          <td className={`px-3 py-3 text-xl font-bold ${scoreClass(row.fundingReadinessScore)}`}>{row.fundingReadinessScore}</td>
          <td className="px-3 py-3">{row.fundingReadinessTier}</td>
          <td className="px-3 py-3">{row.vipTier}</td>
          <td className="px-3 py-3"><p>{row.industry}</p><p className="text-xs text-zinc-500">{row.industryClassification}</p></td>
          <td className="px-3 py-3">NAICS {row.naicsCode || "-"}<br />SIC {row.sicCode || "-"}</td>
          <td className="px-3 py-3 font-semibold">{money(row.lifetimeSpent)}</td>
          <td className="px-3 py-3">{money(row.estimatedMRR)}</td>
          <td className="px-3 py-3">{row.paidMonths}</td>
          <td className="px-3 py-3"><p>{money(row.creditLimit)}</p><p className="text-xs text-zinc-500">Potential {money(row.potentialCreditLimit)}</p></td>
          <td className="px-3 py-3">{row.profileCompleteness}%</td>
          <td className="px-3 py-3">{row.riskLevel}</td>
          <td className="max-w-md px-3 py-3 text-zinc-300"><p>{row.fundingInsight}</p><p className="mt-1 text-xs text-zinc-500">{row.riskInsight}</p></td>
          <td className="px-3 py-3"><div className="flex flex-col gap-2"><span>{row.recommendedAction}</span><Link href={`/admin/customers/${encodeURIComponent(row.email || row._id)}`} className="w-fit rounded bg-zinc-700 px-2 py-1">View</Link></div></td>
        </tr>)}</tbody>
      </table>
      {rows.length === 0 && <p className="p-4 text-zinc-400">No funding-ready customers match the current filters.</p>}
    </section>}
  </AdminLayout>;
}
