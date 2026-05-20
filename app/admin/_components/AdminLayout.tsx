import type { ReactNode } from "react";

type AdminLayoutProps = {
  children: ReactNode;
  header?: ReactNode;
  maxWidthClass?: string;
};

export function AdminLayout({ children, header, maxWidthClass = "max-w-7xl" }: AdminLayoutProps) {
  return <main className="min-h-screen bg-[radial-gradient(circle_at_top,#22070b_0,#09090b_34%,#000_100%)] p-4 text-base text-zinc-100 md:p-8">
    <div className={`mx-auto ${maxWidthClass} space-y-5`}>
      {header}
      {children}
    </div>
  </main>;
}

export function AdminLoadingState({ title, subtext }: { title: string; subtext: string }) {
  return <section className="flex min-h-[420px] items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/80 p-6 shadow-lg shadow-black/20">
    <div className="w-full max-w-xl text-center">
      <div className="mx-auto h-12 w-12 animate-spin rounded-full border-2 border-zinc-700 border-t-red-500" />
      <h2 className="mt-5 text-xl font-semibold text-zinc-100">{title}</h2>
      <p className="mt-2 text-sm text-zinc-400">{subtext}</p>
      <div className="mx-auto mt-6 max-w-md space-y-3">
        <div className="h-4 animate-pulse rounded bg-zinc-800" />
        <div className="h-4 animate-pulse rounded bg-zinc-800/80" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-zinc-800/60" />
      </div>
    </div>
  </section>;
}
