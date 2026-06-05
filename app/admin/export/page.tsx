"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AdminHeader } from "@/app/admin/_components/AdminHeader";
import { AdminLayout } from "@/app/admin/_components/AdminLayout";

const presetLimits = [10, 20, 50, 100, 200, 500] as const;
const columns = ["Name", "Email", "Phone", "Business Name", "EIN", "Address", "City", "State", "Zip", "Industry", "NAICS", "Lifetime Value", "Funding Score", "Credit Limit", "Last Paid Date"];

type Format = "csv" | "json";
type Filter = "all" | "high_value" | "funding_ready";
type FactiivFilter = "all" | "with" | "without";

function exportUrl(limit: number | "all", format: Format, filter: Filter, state: string, factiiv: FactiivFilter) {
  const params = new URLSearchParams({
    format,
    limit: String(limit),
    filter,
    state: state.trim().toUpperCase() || "all",
    factiiv,
  });
  return `/api/customers/export-center?${params.toString()}`;
}

export default function ExportCenterPage() {
  const [format, setFormat] = useState<Format>("csv");
  const [filter, setFilter] = useState<Filter>("all");
  const [state, setState] = useState("");
  const [factiiv, setFactiiv] = useState<FactiivFilter>("all");
  const [customLimit, setCustomLimit] = useState("110");

  const customExportUrl = useMemo(() => {
    const parsed = Number(customLimit);
    const safeLimit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 110;
    return exportUrl(safeLimit, format, filter, state, factiiv);
  }, [customLimit, factiiv, filter, format, state]);

  return <AdminLayout
    header={<AdminHeader
      title="Export Center"
      description="Download customer intelligence exports from stored customer, ranking, funding, and enrichment records."
      actions={<Link href="/admin" className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-3 font-semibold text-zinc-200 transition hover:border-red-800 hover:bg-zinc-800">Dashboard</Link>}
    />}
  >
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/85 p-5 shadow-xl shadow-black/20">
      <div className="grid gap-4 md:grid-cols-4">
        <label className="space-y-2 text-sm text-zinc-300">
          <span className="font-semibold text-zinc-100">Format</span>
          <select value={format} onChange={(event) => setFormat(event.target.value as Format)} className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100">
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <label className="space-y-2 text-sm text-zinc-300">
          <span className="font-semibold text-zinc-100">Customers</span>
          <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)} className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100">
            <option value="all">All Customers</option>
            <option value="high_value">High Value</option>
            <option value="funding_ready">Funding Ready</option>
          </select>
        </label>
        <label className="space-y-2 text-sm text-zinc-300">
          <span className="font-semibold text-zinc-100">State</span>
          <input value={state} onChange={(event) => setState(event.target.value)} maxLength={2} placeholder="All" className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 uppercase text-zinc-100 placeholder:text-zinc-600" />
        </label>
        <label className="space-y-2 text-sm text-zinc-300">
          <span className="font-semibold text-zinc-100">Factiiv Profile</span>
          <select value={factiiv} onChange={(event) => setFactiiv(event.target.value as FactiivFilter)} className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100">
            <option value="all">All Customers</option>
            <option value="with">With Factiiv Profile</option>
            <option value="without">Without Factiiv Profile</option>
          </select>
        </label>
      </div>
    </section>

    <section className="rounded-xl border border-zinc-800 bg-zinc-950/85 p-5 shadow-xl shadow-black/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Quick Exports</h2>
          <p className="mt-1 text-sm text-zinc-400">Exports are sorted by highest lifetime value.</p>
        </div>
        <a href={exportUrl("all", format, filter, state, factiiv)} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-600">Export All Customers</a>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {presetLimits.map((limit) => <a key={limit} href={exportUrl(limit, format, filter, state, factiiv)} className="rounded-lg border border-zinc-800 bg-black/50 p-4 transition hover:border-red-800 hover:bg-zinc-900">
          <span className="block text-sm text-zinc-400">Export</span>
          <span className="mt-1 block text-lg font-semibold text-white">Top {limit} Customers</span>
        </a>)}
      </div>
    </section>

    <section className="rounded-xl border border-zinc-800 bg-zinc-950/85 p-5 shadow-xl shadow-black/20">
      <h2 className="text-xl font-semibold text-white">Custom Limit</h2>
      <div className="mt-4 flex flex-wrap gap-3">
        <input value={customLimit} onChange={(event) => setCustomLimit(event.target.value)} inputMode="numeric" className="w-40 rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100" />
        <a href={customExportUrl} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-600">Export Custom Limit</a>
      </div>
    </section>

    <section className="rounded-xl border border-zinc-800 bg-zinc-950/85 p-5 shadow-xl shadow-black/20">
      <h2 className="text-xl font-semibold text-white">Columns</h2>
      <div className="mt-4 flex flex-wrap gap-2">
        {columns.map((column) => <span key={column} className="rounded border border-zinc-800 bg-black/50 px-3 py-1 text-xs font-medium text-zinc-300">{column}</span>)}
      </div>
    </section>
  </AdminLayout>;
}
