import { HttpException } from "@nestjs/common";

/** Fixed-window limiter per key (IP). In-memory: enough for one API instance; a shared store is needed for several. */
export class RateLimit {
  private readonly hits = new Map<string, { n: number; until: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  hit(key: string) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.until < now) {
      this.hits.set(key, { n: 1, until: now + this.windowMs });
      return;
    }
    if (++h.n > this.max) throw new HttpException("too many requests", 429);
  }
}
