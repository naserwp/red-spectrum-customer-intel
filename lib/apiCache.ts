import { NextResponse } from "next/server";

type CacheEntry<T> = {
  expiresAt: number;
  data: T;
};

const cache = new Map<string, CacheEntry<unknown>>();
const ttlMs = 60_000;

export async function cachedJson<T>(key: string, compute: () => Promise<T>) {
  const started = Date.now();
  const cached = cache.get(key) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > started) {
    const body = JSON.stringify(cached.data);
    console.log(`[api] ${key} durationMs=${Date.now() - started} mongoMs=0 cache=hit responseBytes=${body.length}`);
    return new NextResponse(body, { headers: { "Content-Type": "application/json", "x-cache": "hit" } });
  }

  const mongoStarted = Date.now();
  const data = await compute();
  const mongoMs = Date.now() - mongoStarted;
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  const body = JSON.stringify(data);
  console.log(`[api] ${key} durationMs=${Date.now() - started} mongoMs=${mongoMs} cache=miss responseBytes=${body.length}`);
  return new NextResponse(body, { headers: { "Content-Type": "application/json", "x-cache": "miss" } });
}
