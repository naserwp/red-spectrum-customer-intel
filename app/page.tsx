import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="max-w-2xl rounded-xl border border-red-700 bg-zinc-950 p-8 shadow-2xl">
        <h1 className="text-4xl font-bold text-red-500">Red Spectrum Customer Intelligence</h1>
        <p className="mt-4 text-zinc-300">
          Internal dashboard MVP for identifying high-value WooCommerce customers, scoring loyalty and risk, and exporting actionable customer reports.
        </p>
        <Link
          href="/admin"
          className="mt-8 inline-block rounded-md bg-red-600 px-6 py-3 font-semibold text-white hover:bg-red-500"
        >
          Open Admin Dashboard
        </Link>
      </div>
    </main>
  );
}
