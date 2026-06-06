"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminHeader } from "@/app/admin/_components/AdminHeader";
import { AdminLayout } from "@/app/admin/_components/AdminLayout";

const presetLimits = [10, 20, 50, 100, 200, 500] as const;
const columns = ["customerId", "customerName", "email", "businessName", "phoneNumber", "businessAddress", "ein", "state", "city", "businessIndustry", "industryCode", "industryCodeType", "industryDescription", "factiivScore", "stripeTotal", "fundingScore", "fundingCategory", "recommendedFundingProducts", "dataConfidenceStatus"];

type Format = "csv" | "json";
type Filter = "all" | "high_value" | "funding_ready";
type FactiivFilter = "all" | "with" | "without";
type ExportLimit = "10" | "20" | "50" | "100" | "200" | "500" | "custom" | "all";
type DataRow = {
  customerName?: string;
  email?: string;
  businessName?: string;
  businessIndustry?: string;
  industryCode?: string;
  factiivScore?: number | string;
  fundingScore?: number | string;
  lifetimeValue?: number;
  phoneNumber?: string;
  businessAddress?: string;
  ein?: string;
  state?: string;
  city?: string;
  factiivMatchedBusiness?: string;
  factiivTradeLines?: number | string;
  factiivTotalTradeAmount?: number | string;
  factiivVerifiedCreditLimit?: number | string;
  totalAmountPaid?: number;
  wooCommerceTotal?: number;
  authorizeNetTotal?: number;
  stripeTotal?: number;
  nmiTotal?: number;
  successfulPaymentCount?: number;
  lastPaidDate?: string;
  fundingCategory?: string;
  recommendedFundingProducts?: string;
  dataConfidenceStatus?: string;
};

function exportUrl(limit: number | "all", format: Format, filter: Filter, state: string, factiiv: FactiivFilter, useAIIndustry: boolean, includeFullFields: boolean, includeInsights: boolean) {
  const params = new URLSearchParams({
    format,
    limit: String(limit),
    filter,
    state: state.trim().toUpperCase() || "all",
    factiiv,
    useAIIndustry: useAIIndustry ? "true" : "false",
    includeFullFields: includeFullFields ? "true" : "false",
    includeInsights: includeInsights ? "true" : "false",
  });
  return `/api/customers/export-center?${params.toString()}`;
}

export default function ExportCenterPage() {
  const [format, setFormat] = useState<Format>("csv");
  const [filter, setFilter] = useState<Filter>("all");
  const [state, setState] = useState("");
  const [factiiv, setFactiiv] = useState<FactiivFilter>("all");
  const [selectedLimit, setSelectedLimit] = useState<ExportLimit>("20");
  const [customLimit, setCustomLimit] = useState("110");
  const [useAIIndustry, setUseAIIndustry] = useState(true);
  const [includeFullFields, setIncludeFullFields] = useState(true);
  const [includeInsights, setIncludeInsights] = useState(false);
  const [dataRows, setDataRows] = useState<DataRow[]>([]);
  const [dataSearch, setDataSearch] = useState("");
  const [dataPage, setDataPage] = useState(1);
  const [dataPageSize, setDataPageSize] = useState(50);
  const [dataFundingCategory, setDataFundingCategory] = useState("");
  const [dataPaymentStatus, setDataPaymentStatus] = useState("");
  const [dataHasMore, setDataHasMore] = useState(false);
  const [dataTotalMatching, setDataTotalMatching] = useState(0);
  const [dataStatus, setDataStatus] = useState("");
  const [isDataLoading, setIsDataLoading] = useState(false);

  const customExportUrl = useMemo(() => {
    const parsed = Number(customLimit);
    const safeLimit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 110;
    return exportUrl(safeLimit, format, filter, state, factiiv, useAIIndustry, includeFullFields, includeInsights);
  }, [customLimit, factiiv, filter, format, includeFullFields, includeInsights, state, useAIIndustry]);

  const selectedExportLimit = useMemo<number | "all">(() => {
    if (selectedLimit === "all") return "all";
    if (selectedLimit === "custom") {
      const parsed = Number(customLimit);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 110;
    }
    return Number(selectedLimit);
  }, [customLimit, selectedLimit]);

  const selectedExportUrl = useMemo(() => exportUrl(selectedExportLimit, format, filter, state, factiiv, useAIIndustry, includeFullFields, includeInsights), [factiiv, filter, format, includeFullFields, includeInsights, selectedExportLimit, state, useAIIndustry]);

  const dataViewUrl = useMemo(() => {
    const params = new URLSearchParams({
      format: "json",
      limit: String(dataPageSize),
      page: String(dataPage),
      filter,
      state: state.trim().toUpperCase() || "all",
      factiiv,
      search: dataSearch.trim(),
      fundingCategory: dataFundingCategory.trim(),
      paymentStatus: dataPaymentStatus.trim(),
      sortBy: "totalAmountPaid",
      sortDir: "desc",
      useAIIndustry: useAIIndustry ? "true" : "false",
      includeFullFields: includeFullFields ? "true" : "false",
      includeInsights: includeInsights ? "true" : "false",
    });
    return `/api/customers/export-center?${params.toString()}`;
  }, [dataFundingCategory, dataPage, dataPageSize, dataPaymentStatus, dataSearch, factiiv, filter, includeFullFields, includeInsights, state, useAIIndustry]);

  const loadDataView = useCallback(async () => {
    setIsDataLoading(true);
    setDataStatus("Loading data view...");
    try {
      const response = await fetch(dataViewUrl, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Data view failed.");
      setDataRows(data.customers ?? []);
      setDataHasMore(Boolean(data.hasMore));
      setDataTotalMatching(Number(data.totalMatching ?? data.total ?? 0));
      setDataStatus(`Showing page ${Number(data.page ?? dataPage)} with ${Number(data.customers?.length ?? 0)} rows. Data view uses the same export data as CSV.`);
    } catch (error) {
      setDataRows([]);
      setDataHasMore(false);
      setDataStatus(error instanceof Error ? error.message : "Data view failed.");
    } finally {
      setIsDataLoading(false);
    }
  }, [dataPage, dataViewUrl]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadDataView();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDataView]);

  const handlePreviewExport = () => {
    if (dataPage === 1) {
      void loadDataView();
      return;
    }
    setDataPage(1);
  };

  return <AdminLayout
    header={<AdminHeader
      title="Export Center"
      description="Download customer intelligence exports from stored customer, ranking, funding, and enrichment records."
      actions={<Link href="/admin" className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-3 font-semibold text-zinc-200 transition hover:border-red-800 hover:bg-zinc-800">Dashboard</Link>}
    />}
  >
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/85 p-5 shadow-xl shadow-black/20">
      <div className="grid gap-4 md:grid-cols-5">
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
        <label className="space-y-2 text-sm text-zinc-300">
          <span className="font-semibold text-zinc-100">Export Size</span>
          <select value={selectedLimit} onChange={(event) => setSelectedLimit(event.target.value as ExportLimit)} className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100">
            <option value="10">Top 10</option>
            <option value="20">Top 20</option>
            <option value="50">Top 50</option>
            <option value="100">Top 100</option>
            <option value="200">Top 200</option>
            <option value="500">Top 500</option>
            <option value="custom">Custom</option>
            <option value="all">All Customers</option>
          </select>
        </label>
      </div>
      <div className="mt-4 grid gap-3 text-sm text-zinc-300 md:grid-cols-3">
        <label className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-black/40 px-3 py-2">
          <input type="checkbox" checked={useAIIndustry} onChange={(event) => setUseAIIndustry(event.target.checked)} className="h-4 w-4 accent-red-600" />
          <span>Generate missing Industry/NAICS with AI</span>
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-black/40 px-3 py-2">
          <input type="checkbox" checked={includeFullFields} onChange={(event) => setIncludeFullFields(event.target.checked)} className="h-4 w-4 accent-red-600" />
          <span>Include full Factiiv/Funding fields</span>
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-black/40 px-3 py-2">
          <input type="checkbox" checked={includeInsights} onChange={(event) => setIncludeInsights(event.target.checked)} className="h-4 w-4 accent-red-600" />
          <span>Include business/funding insight fields</span>
        </label>
      </div>
      {selectedLimit === "custom" && <div className="mt-4">
        <label className="space-y-2 text-sm text-zinc-300">
          <span className="font-semibold text-zinc-100">Custom Limit</span>
          <input value={customLimit} onChange={(event) => setCustomLimit(event.target.value)} inputMode="numeric" className="w-40 rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100" />
        </label>
      </div>}
      <p className="mt-3 text-xs text-zinc-500">Export Center uses the same full field set as Export Top 110. AI industry generation can take longer for all-customer exports.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button onClick={handlePreviewExport} disabled={isDataLoading} className="cursor-pointer rounded-lg bg-red-700 px-5 py-3 text-sm font-semibold text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-zinc-700">
          {isDataLoading ? "Loading preview..." : "Preview Export"}
        </button>
        <a href={selectedExportUrl} className="cursor-pointer rounded-lg border border-red-800/70 bg-zinc-900 px-5 py-3 text-sm font-semibold text-zinc-100 transition hover:border-red-500 hover:bg-zinc-800">Download Export</a>
      </div>
    </section>

    <section className="rounded-xl border border-zinc-800 bg-zinc-950/85 p-5 shadow-xl shadow-black/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">All Customers Data View</h2>
          <p className="mt-1 text-sm text-zinc-400">Data view uses the same export data as CSV.</p>
        </div>
        <button onClick={loadDataView} disabled={isDataLoading} className="cursor-pointer rounded-lg border border-red-800/70 bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-100 transition hover:border-red-500 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-700">
          {isDataLoading ? "Loading..." : "Refresh"}
        </button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-5">
        <label className="space-y-2 text-sm text-zinc-300 md:col-span-2">
          <span className="font-semibold text-zinc-100">Search</span>
          <input value={dataSearch} onChange={(event) => { setDataSearch(event.target.value); setDataPage(1); }} placeholder="Name, email, business" className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100 placeholder:text-zinc-600" />
        </label>
        <label className="space-y-2 text-sm text-zinc-300">
          <span className="font-semibold text-zinc-100">Funding Category</span>
          <input value={dataFundingCategory} onChange={(event) => { setDataFundingCategory(event.target.value); setDataPage(1); }} placeholder="Any" className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100 placeholder:text-zinc-600" />
        </label>
        <label className="space-y-2 text-sm text-zinc-300">
          <span className="font-semibold text-zinc-100">Payment Status</span>
          <input value={dataPaymentStatus} onChange={(event) => { setDataPaymentStatus(event.target.value); setDataPage(1); }} placeholder="Verified, Review" className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100 placeholder:text-zinc-600" />
        </label>
        <label className="space-y-2 text-sm text-zinc-300">
          <span className="font-semibold text-zinc-100">Rows per page</span>
          <select value={dataPageSize} onChange={(event) => { setDataPageSize(Number(event.target.value)); setDataPage(1); }} className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100">
            {[20, 50, 100, 200].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-zinc-300">
        <button onClick={() => setDataPage((page) => Math.max(1, page - 1))} disabled={dataPage <= 1 || isDataLoading} className="cursor-pointer rounded border border-zinc-800 bg-black px-3 py-2 hover:border-red-900 disabled:cursor-not-allowed disabled:text-zinc-600">Previous</button>
        <span>Page {dataPage}</span>
        <button onClick={() => setDataPage((page) => page + 1)} disabled={!dataHasMore || isDataLoading} className="cursor-pointer rounded border border-zinc-800 bg-black px-3 py-2 hover:border-red-900 disabled:cursor-not-allowed disabled:text-zinc-600">Next</button>
        <span>{dataTotalMatching ? `${dataTotalMatching} matching loaded for current window` : ""}</span>
        {dataStatus && <span className="text-zinc-500">{dataStatus}</span>}
      </div>
      <p className="mt-4 rounded-lg border border-red-950/70 bg-red-950/20 px-3 py-2 text-xs font-medium text-red-200">Scroll horizontally to view all columns.</p>
      <div className="relative mt-3 rounded-lg border border-zinc-800">
        <div className="pointer-events-none absolute inset-y-0 right-0 z-20 w-10 bg-gradient-to-l from-zinc-950 via-zinc-950/80 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-8 bg-gradient-to-t from-black/45 to-transparent" />
        <div className="export-data-scroll overflow-x-auto">
        <table className="min-w-[2800px] border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-black text-zinc-400">
            <tr className="uppercase">
              <th colSpan={3} className="border-b border-zinc-800 px-3 py-3 align-middle leading-none text-red-300">Customer Info</th>
              <th colSpan={7} className="border-b border-zinc-800 px-3 py-3 align-middle leading-none text-red-300">Business Info</th>
              <th colSpan={5} className="border-b border-zinc-800 px-3 py-3 align-middle leading-none text-red-300">Factiiv/Credit Info</th>
              <th colSpan={8} className="border-b border-zinc-800 px-3 py-3 align-middle leading-none text-red-300">Payment Info</th>
              <th colSpan={4} className="border-b border-zinc-800 px-3 py-3 align-middle leading-none text-red-300">Funding Info</th>
            </tr>
            <tr className="uppercase">
              {["customerName", "email", "phoneNumber", "businessName", "businessAddress", "ein", "state", "city", "businessIndustry", "industryCode", "factiivScore", "factiivMatchedBusiness", "factiivTradeLines", "factiivTotalTradeAmount", "factiivVerifiedCreditLimit", "totalAmountPaid", "lifetimeValue", "wooCommerceTotal", "authorizeNetTotal", "stripeTotal", "nmiTotal", "successfulPaymentCount", "lastPaidDate", "fundingScore", "fundingCategory", "recommendedFundingProducts", "dataConfidenceStatus"].map((header) => <th key={header} className="border-b border-zinc-800 px-3 py-4 align-middle font-semibold leading-tight">{header}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900 bg-zinc-950">
            {dataRows.map((row, index) => <tr key={`${row.email ?? "row"}-${index}`} className="cursor-pointer hover:bg-zinc-900/70">
              {[row.customerName, row.email, row.phoneNumber, row.businessName, row.businessAddress, row.ein, row.state, row.city, row.businessIndustry, row.industryCode, row.factiivScore, row.factiivMatchedBusiness, row.factiivTradeLines, row.factiivTotalTradeAmount, row.factiivVerifiedCreditLimit, row.totalAmountPaid, row.lifetimeValue, row.wooCommerceTotal, row.authorizeNetTotal, row.stripeTotal, row.nmiTotal, row.successfulPaymentCount, row.lastPaidDate, row.fundingScore, row.fundingCategory, row.recommendedFundingProducts, row.dataConfidenceStatus].map((value, valueIndex) => <td key={valueIndex} className="max-w-64 truncate px-3 py-3 text-zinc-300" title={String(value ?? "Missing")}>{value ?? "Missing"}</td>)}
            </tr>)}
            {isDataLoading && <tr><td colSpan={27} className="px-3 py-6 text-center text-zinc-400">Loading data view...</td></tr>}
            {!isDataLoading && dataRows.length === 0 && <tr><td colSpan={27} className="px-3 py-6 text-center text-zinc-500">No customer export rows found.</td></tr>}
          </tbody>
        </table>
        </div>
      </div>
    </section>

    <section className="rounded-xl border border-zinc-800 bg-zinc-950/85 p-5 shadow-xl shadow-black/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Quick Exports</h2>
          <p className="mt-1 text-sm text-zinc-400">Exports are sorted by highest lifetime value.</p>
        </div>
        <a href={exportUrl("all", format, filter, state, factiiv, useAIIndustry, includeFullFields, includeInsights)} className="cursor-pointer rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-600">Export All Customers</a>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {presetLimits.map((limit) => <a key={limit} href={exportUrl(limit, format, filter, state, factiiv, limit <= 200 ? useAIIndustry : false, includeFullFields, includeInsights)} className="cursor-pointer rounded-lg border border-zinc-800 bg-black/50 p-4 transition hover:border-red-800 hover:bg-zinc-900">
          <span className="block text-sm text-zinc-400">Export</span>
          <span className="mt-1 block text-lg font-semibold text-white">Top {limit} Customers</span>
        </a>)}
      </div>
    </section>

    <section className="rounded-xl border border-zinc-800 bg-zinc-950/85 p-5 shadow-xl shadow-black/20">
      <h2 className="text-xl font-semibold text-white">Custom Limit</h2>
      <div className="mt-4 flex flex-wrap gap-3">
        <input value={customLimit} onChange={(event) => setCustomLimit(event.target.value)} inputMode="numeric" className="w-40 rounded-lg border border-zinc-800 bg-black px-3 py-2 text-zinc-100" />
        <a href={customExportUrl} className="cursor-pointer rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-600">Export Custom Limit</a>
      </div>
    </section>

    <section className="rounded-xl border border-zinc-800 bg-zinc-950/85 p-5 shadow-xl shadow-black/20">
      <h2 className="text-xl font-semibold text-white">Columns</h2>
      <div className="mt-4 flex flex-wrap gap-2">
        {columns.map((column) => <span key={column} className="rounded border border-zinc-800 bg-black/50 px-3 py-1 text-xs font-medium text-zinc-300">{column}</span>)}
      </div>
    </section>
    <style jsx global>{`
      .export-data-scroll {
        scrollbar-color: #dc2626 #09090b;
        scrollbar-width: thin;
      }
      .export-data-scroll::-webkit-scrollbar {
        height: 14px;
      }
      .export-data-scroll::-webkit-scrollbar-track {
        background: #09090b;
        border-top: 1px solid #27272a;
      }
      .export-data-scroll::-webkit-scrollbar-thumb {
        background: linear-gradient(90deg, #7f1d1d, #dc2626);
        border: 3px solid #09090b;
        border-radius: 999px;
      }
      .export-data-scroll::-webkit-scrollbar-thumb:hover {
        background: #ef4444;
      }
    `}</style>
  </AdminLayout>;
}
