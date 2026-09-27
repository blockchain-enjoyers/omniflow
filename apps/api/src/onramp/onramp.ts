import type { Address } from "viem";

/** buying crypto for fiat onto the organisation's own account. Partner not chosen. */
export interface OnrampProvider {
  /** The destination is always the organisation account, taken from the database — never from the request. */
  createSession(input: { account: Address; fiatAmount: number; currency: string; returnUrl?: string }): Promise<{ id: string; url: string }>;
  name: string;
}

export class EmulatedOnramp implements OnrampProvider {
  name = "On-ramp emulator";
  constructor(private readonly url: string) {}

  async createSession(input: { account: Address; fiatAmount: number; currency: string; returnUrl?: string }) {
    const r = await fetch(`${this.url.replace(/\/$/, "")}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: input.account, fiatAmount: input.fiatAmount, currency: input.currency, returnUrl: input.returnUrl }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "on-ramp session failed");
    return j as { id: string; url: string };
  }
}
