// A small fixed-window rate limiter, held in memory.
//
// In-memory is the right scope here: there is exactly one app container
// (docker-compose.yml), so there is nothing to share state with. If that ever
// changes, this is the file that has to move to Postgres or Redis.
//
// Like password.ts, this imports nothing at all, which is what lets
// scripts/rate-limit-check.mjs exercise it without a real npm ci.

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets. 0 when allowed. Sent as Retry-After. */
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

// Expired entries are cleared during an ordinary check rather than on a timer,
// so an idle server does no work. The sweep is amortised over this many checks.
const SWEEP_EVERY_CHECKS = 500;
// Hard ceiling on tracked keys. Reaching it means something is cycling keys to
// exhaust memory - see the comment in #sweep() for why the response is to drop
// everything rather than to start refusing.
const MAX_TRACKED_KEYS = 50_000;

export class RateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #limit: number;
  readonly #windowMs: number;
  #checksSinceSweep = 0;

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Records one attempt against `key` and says whether it is allowed. */
  check(key: string): RateLimitDecision {
    const now = Date.now();
    if (++this.#checksSinceSweep >= SWEEP_EVERY_CHECKS) this.#sweep(now);

    const existing = this.#windows.get(key);
    if (!existing || existing.resetAt <= now) {
      this.#windows.set(key, { count: 1, resetAt: now + this.#windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    existing.count++;
    if (existing.count <= this.#limit) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }

  /** Forgets a key's window. Called after a successful login so someone who
   * mistyped their password five times doesn't stay near the limit for the rest
   * of the window. */
  reset(key: string): void {
    this.#windows.delete(key);
  }

  /** Test seam: how many keys are currently tracked. */
  get size(): number {
    return this.#windows.size;
  }

  #sweep(now: number): void {
    this.#checksSinceSweep = 0;
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
    // Still over the ceiling after dropping everything expired: the map is full
    // of live windows for keys someone is generating (a different username per
    // attempt, say). Clearing hands them a fresh window, which is the lesser
    // problem - refusing new keys instead would let anyone lock every other
    // player out by flooding the table.
    if (this.#windows.size > MAX_TRACKED_KEYS) this.#windows.clear();
  }
}
