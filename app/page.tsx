import Link from "next/link";
import { cookies } from "next/headers";
import { adminSessionCookieName, verifyAdminSession } from "@/lib/adminAuth";

export default async function Home() {
  const cookieStore = await cookies();
  const isLoggedIn = await verifyAdminSession(cookieStore.get(adminSessionCookieName)?.value);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,#3b0b12_0,#09090b_42%,#000_100%)] p-6 text-white">
      <div className="max-w-2xl rounded-xl border border-red-900/70 bg-zinc-950/95 p-8 shadow-2xl shadow-black/40">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-red-400">Red Spectrum</p>
        <h1 className="mt-3 text-4xl font-bold text-red-500">Red Spectrum Customer Intelligence</h1>
        <p className="mt-4 text-zinc-300 leading-7">
          Internal dashboard MVP for identifying high-value WooCommerce customers, scoring loyalty and risk, and exporting actionable customer reports.
        </p>
        <Link
          href={isLoggedIn ? "/admin" : "/login"}
          className="mt-8 inline-block rounded-lg bg-red-600 px-6 py-3 font-semibold text-white shadow-lg shadow-red-950/30 transition hover:bg-red-500"
        >
          Open Admin Dashboard
        </Link>
      </div>
    </main>
  );
}
