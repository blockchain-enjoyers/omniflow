import { describe, expect, it } from "vitest";
import { RecordService, type PaymentRecord } from "../src/reports/record.js";
import { StablecoinParity } from "../src/reports/service.js";

const rec = (p: Partial<PaymentRecord> = {}): PaymentRecord => ({
  rowId: "row-2",
  payoutId: "p1",
  payout: "September",
  org: "Acme",
  account: "0x1111111111111111111111111111111111111111",
  escrow: "0x2222222222222222222222222222222222222222",
  network: "Arbitrum Sepolia",
  recipient: "Alice",
  address: "0x3333333333333333333333333333333333333333",
  email: null,
  amount: "10",
  token: "USDC",
  usdValue: "10.00",
  priceSource: "stablecoin at par (1 USDC = 1 USD), not a market quote",
  category: null,
  executedAt: "2026-10-04 09:00 UTC",
  status: "Paid",
  txHash: `0x${"ab".repeat(32)}`,
  requestedBy: "ops@acme.test",
  requestedAt: null,
  approvedBy: [],
  threshold: "2 of 3",
  delivery: ["Paid directly."],
  settleTx: null,
  ...p,
});
// the records query is not used here: html() works on records already read
const svc = (explorerUrl?: string) => new RecordService(null as never, new StablecoinParity(), 6, { explorerUrl });

describe("payment record page", () => {
  it("names from uploaded files cannot inject markup", () => {
    const html = svc().html([rec({ recipient: `<img src=x onerror=alert(1)>`, payout: `</title><script>x()</script>` })], "t");
    expect(html).not.toMatch(/<img src=x|<script>x/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`); // and nothing could run anyway
  });

  it("with an explorer, the transaction and the addresses link to it (EIP-3091 routes); without one, they are text", () => {
    const r = rec();
    const linked = svc("https://sepolia.arbiscan.io/").html([r], "t");
    expect(linked).toContain(`<a href="https://sepolia.arbiscan.io/tx/${r.txHash}">`);
    expect(linked).toContain(`<a href="https://sepolia.arbiscan.io/address/${r.account}">`);
    expect(svc().html([r], "t")).not.toContain("<a href");
  });

  it("one printed page per payment", () => {
    const html = svc().html([rec(), rec({ rowId: "row-3" })], "t");
    expect(html.match(/<section class="rec">/g)).toHaveLength(2);
    expect(html).toContain("break-after: page");
  });
});
