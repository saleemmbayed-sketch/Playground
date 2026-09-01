/**
 * Tiny in-memory rate limiter (fixed window per key).
 * No Redis, no dependency — a single-box service does not need distributed state,
 * and this is enough to stop form spam and signup abuse.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.count += 1;
  if (b.count > max) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

/** Periodic sweep so the map cannot grow unbounded on a long-running process. */
export function startRateLimitSweeper(intervalMs = 10 * 60 * 1000): NodeJS.Timeout {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }, intervalMs);
  t.unref?.();
  return t;
}

export function resetRateLimits(): void {
  buckets.clear();
}
