"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    setLoading(false);
    if (!response.ok) {
      setError(data.error || "Unable to sign in.");
      return;
    }
    router.replace("/admin");
  };

  return <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top,#3b0b12_0,#09090b_42%,#000_100%)] p-6 text-zinc-100">
    <section className="w-full max-w-md rounded-xl border border-red-900/70 bg-zinc-950/95 p-7 shadow-2xl shadow-black/40">
      <div className="mb-7">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-red-400">Red Spectrum</p>
        <h1 className="mt-3 text-3xl font-bold text-white">Red Spectrum Customer Intelligence</h1>
        <p className="mt-2 text-sm text-zinc-400">Internal admin access only</p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm font-medium text-zinc-300">
          Email
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            autoComplete="email"
            className="mt-2 w-full rounded-lg border border-zinc-800 bg-black px-3 py-3 text-zinc-100 outline-none transition focus:border-red-600 focus:ring-2 focus:ring-red-950"
            required
          />
        </label>
        <label className="block text-sm font-medium text-zinc-300">
          Password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
            className="mt-2 w-full rounded-lg border border-zinc-800 bg-black px-3 py-3 text-zinc-100 outline-none transition focus:border-red-600 focus:ring-2 focus:ring-red-950"
            required
          />
        </label>
        {error && <p className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-100">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-red-600 px-4 py-3 font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </section>
  </main>;
}
