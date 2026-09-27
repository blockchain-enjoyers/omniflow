import { describe, expect, it, vi } from "vitest";
import { RateLimit } from "../src/http/ratelimit.js";

describe("rate limit", () => {
  it("limits per key within a window and forgets expired windows", () => {
    vi.useFakeTimers();
    const l = new RateLimit(2, 1000);
    l.hit("a");
    l.hit("a");
    expect(() => l.hit("a")).toThrow(/too many/);
    l.hit("b"); // another client
    for (let i = 0; i < 500; i++) l.hit(`ip-${i}`);
    expect(l.size).toBe(502);
    vi.advanceTimersByTime(1500);
    l.hit("a"); // new window
    expect(l.size).toBe(1); // everything expired was swept
    vi.useRealTimers();
  });
});
