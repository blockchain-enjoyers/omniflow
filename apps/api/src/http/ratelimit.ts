import { HttpException } from "@nestjs/common";

/**
 * Fixed-window limiter per key (client IP). In-memory: enough for one API instance; several instances need a shared
 * store. The key is only as good as `req.ip` — behind a proxy, set TRUST_PROXY, or every client looks like the proxy.
 */
export class RateLimit {
  private readonly hits = new Map<string, { n: number; until: number }>();
  private sweepAt = 0;
  constructor(private readonly max: number, private readonly windowMs: number) {}

  hit(key: string) {
    const now = Date.now();
    this.sweep(now);
    const h = this.hits.get(key);
    if (!h || h.until < now) {
      this.hits.set(key, { n: 1, until: now + this.windowMs });
      return;
    }
    if (++h.n > this.max) throw new HttpException("too many requests", 429);
  }

  /** Expired windows are dropped once a window: the map does not grow with every address ever seen. */
  private sweep(now: number) {
    if (now < this.sweepAt) return;
    this.sweepAt = now + this.windowMs;
    for (const [k, h] of this.hits) if (h.until < now) this.hits.delete(k);
  }

  get size() {
    return this.hits.size;
  }
}
