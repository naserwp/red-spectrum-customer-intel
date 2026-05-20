"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

type AdminHeaderProps = {
  title: string;
  eyebrow?: string;
  description?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  showDashboardActions?: boolean;
  onOpenSyncCenter?: () => void;
};

export function AdminHeader({
  title,
  eyebrow = "Red Spectrum",
  description,
  meta,
  actions,
  showDashboardActions = false,
  onOpenSyncCenter,
}: AdminHeaderProps) {
  const router = useRouter();

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  };

  return <header className="rounded-2xl border border-red-950/60 bg-zinc-950/90 p-5 shadow-xl shadow-black/30">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        <Image src="/Images/the-red-spectrum-full-logo-1.svg" alt="Red Spectrum" width={180} height={48} className="h-12 w-auto" style={{ width: "auto", height: "auto" }} priority />
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-red-400">{eyebrow}</p>
          <h1 className="mt-2 text-3xl font-bold text-white md:text-4xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-zinc-400">{description}</p>}
          {meta && <div className="mt-2 text-xs text-zinc-500">{meta}</div>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {showDashboardActions && <button onClick={onOpenSyncCenter} className="rounded-lg bg-red-600 px-5 py-3 font-semibold text-white shadow-lg shadow-red-950/30 transition hover:bg-red-500">Sync Center</button>}
        {actions}
        {showDashboardActions && <button onClick={logout} className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-3 font-semibold text-zinc-200 transition hover:border-red-800 hover:bg-zinc-800">Logout</button>}
      </div>
    </div>
  </header>;
}
