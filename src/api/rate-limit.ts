/**
 * In-memory fixed window rate limiter.
 *
 * Single instance only: the counters live in this process, so horizontally scaled
 * deployments would need shared storage (documented limitation, see docs/05-BACKEND.md).
 * The map is bounded twice over: expired windows are swept periodically and the
 * number of tracked keys is capped, evicting the entries closest to expiry first.
 */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Maximum number of tracked keys; must be > 0. */
  readonly maxEntries?: number | undefined;
  /** Identifier namespace, useful when several limiters share the same keys. */
  readonly scope?: string | undefined;
}

interface Entry {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const SWEEP_INTERVAL = 512;

export class RateLimiter {
  readonly rule: RateLimitRule;
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #scope: string;
  #operations = 0;

  constructor(rule: RateLimitRule,options: RateLimiterOptions = {}) {
    if (!Number.isInteger(rule.limit) || rule.limit < 1) throw new Error('Rate limit must be a positive integer');
    if (!Number.isInteger(rule.windowMs) || rule.windowMs < 1) throw new Error('Rate limit window must be a positive integer');
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('maxEntries must be a positive integer');
    this.rule = rule;
    this.#maxEntries = maxEntries;
    this.#scope = options.scope ?? 'default';
  }

  get size(): number {
    return this.#entries.size;
  }

  check(key: string,now = Date.now()): RateLimitDecision {
    this.#operations += 1;
    if (this.#operations % SWEEP_INTERVAL === 0) this.sweep(now);
    const scopedKey = `${this.#scope}:${key}`;
    const current = this.#entries.get(scopedKey);
    if (current === undefined || current.resetAt <= now) {
      this.#entries.set(scopedKey,{count:1,resetAt:now + this.rule.windowMs});
      this.#enforceCapacity(now);
      return {allowed:true,remaining:this.rule.limit - 1,retryAfterSeconds:Math.ceil(this.rule.windowMs / 1000)};
    }
    if (current.count >= this.rule.limit) {
      return {allowed:false,remaining:0,retryAfterSeconds:Math.max(1,Math.ceil((current.resetAt - now) / 1000))};
    }
    current.count += 1;
    return {allowed:true,remaining:this.rule.limit - current.count,retryAfterSeconds:Math.ceil((current.resetAt - now) / 1000)};
  }

  /** Drops windows that already expired. */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [key,entry] of this.#entries) {
      if (entry.resetAt <= now) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  reset(): void {
    this.#entries.clear();
  }

  #enforceCapacity(now: number): void {
    if (this.#entries.size <= this.#maxEntries) return;
    if (this.sweep(now) > 0 && this.#entries.size <= this.#maxEntries) return;
    // Still over capacity: evict the entries that expire first.
    const ordered = [...this.#entries.entries()].sort((left,right) => left[1].resetAt - right[1].resetAt);
    const excess = this.#entries.size - this.#maxEntries;
    for (let index = 0; index < excess; index += 1) {
      const candidate = ordered[index];
      if (candidate !== undefined) this.#entries.delete(candidate[0]);
    }
  }
}

export type RateLimitScope = 'auth' | 'write' | 'read';

export interface RateLimitPolicy {
  readonly auth: RateLimitRule;
  readonly write: RateLimitRule;
  readonly read: RateLimitRule;
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = Object.freeze({
  auth: Object.freeze({limit:10,windowMs:60_000}),
  write: Object.freeze({limit:60,windowMs:60_000}),
  read: Object.freeze({limit:300,windowMs:60_000}),
});

export interface RateLimiterSet {
  check(scope: RateLimitScope,key: string,now?: number): RateLimitDecision;
  readonly limiters: Readonly<Record<RateLimitScope,RateLimiter>>;
}

export const createRateLimiterSet = (policy: RateLimitPolicy = DEFAULT_RATE_LIMITS): RateLimiterSet => ({
  limiters:{
    auth:new RateLimiter(policy.auth,{scope:'auth'}),
    write:new RateLimiter(policy.write,{scope:'write'}),
    read:new RateLimiter(policy.read,{scope:'read'}),
  },
  check(scope,key,now) {
    return this.limiters[scope].check(key,now);
  },
});
