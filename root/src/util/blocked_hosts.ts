// Simple in-memory blocked-host TTL cache (session/process scoped)
// AI-first: logic is infrastructure-level, not heuristic content processing.

const store = new Map<string, number>();

function ttlMs(): number {
  const v = Number(process.env.CRAWLEE_BLOCK_TTL_MS || 900000);
  return Number.isFinite(v) && v > 0 ? v : 900000;
}

export function blockHost(host: string, ms?: number) {
  if (!host) return;
  const exp = Date.now() + (ms ?? ttlMs());
  store.set(host.toLowerCase(), exp);
}

export function isHostBlocked(host: string): boolean {
  if (!host) return false;
  const key = host.toLowerCase();
  const exp = store.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    store.delete(key);
    return false;
  }
  return true;
}

export function getBlockedHosts(): string[] {
  const now = Date.now();
  for (const [h, exp] of store.entries()) {
    if (now > exp) store.delete(h);
  }
  return Array.from(store.keys());
}

