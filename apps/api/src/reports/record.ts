import { formatUnits } from "viem";
import type { Db } from "../db/db.js";
import type { PriceSource } from "./service.js";

/**
 * Payment record: one page per payment — who paid whom, how much, when, who asked for it,
 * who approved it, how it reached the recipient, and the transaction. A record of a payment, not a tax form: the
 * title and the footer say so, and the USD value says where it comes from.
 */
export interface PaymentRecord {
  rowId: string;
  payoutId: string;
  payout: string;
  org: string;
  account: string;
  escrow: string;
  network: string;
  recipient: string;
  address: string | null;
  email: string | null;
  amount: string;
  token: string;
  usdValue: string;
  priceSource: string;
  category: string | null;
  executedAt: string | null;
  status: string;
  txHash: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  approvedBy: { who: string; at: string }[];
  threshold: string;
  delivery: string[];
  settleTx: string | null;
}

export interface NetworkInfo {
  /** e.g. "Arbitrum Sepolia"; a demo backend names its demo network */
  name?: string;
  /** EIP-3091 explorer base (https://sepolia.arbiscan.io); none on a demo network, whose transactions no explorer knows */
  explorerUrl?: string;
}

const KNOWN: Record<number, string> = { 42161: "Arbitrum One", 421614: "Arbitrum Sepolia" };
const STATUS: Record<string, string> = { sent: "Paid", in_escrow: "Sent by link — not claimed yet", claimed: "Claimed", refunded: "Returned to the organization" };
const utc = (d: Date | string | null) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : null);

export class RecordService {
  constructor(
    private readonly db: Db,
    private readonly price: PriceSource,
    private readonly decimals: number,
    private readonly network: NetworkInfo = {},
    private readonly tokenSymbol = "USDC",
  ) {}

  /** Records of payments that left the account: one row, one payout, or an organisation's period. */
  async records(orgId: string, f: { payoutId?: string; row?: string; from?: Date; to?: Date } = {}): Promise<PaymentRecord[]> {
    const { rows } = await this.db.query(
      `SELECT r.*, p.id AS payout_id, p.title, o.name AS org_name, o.account, o.escrow, o.token, o.chain_id AS org_chain, o.threshold,
              b.id AS b_id, b.created_at AS requested_at, (SELECT u.email FROM users u WHERE u.did=b.requested_by) AS requested_by,
              (SELECT coalesce(sum(weight),0) FROM approvers a WHERE a.org_id=o.id) AS total_weight
         FROM payout_rows r JOIN payouts p ON p.id=r.payout_id JOIN orgs o ON o.id=p.org_id LEFT JOIN batches b ON b.id=r.batch_id
        WHERE p.org_id=$1 AND r.executed_at IS NOT NULL
          AND ($2::uuid IS NULL OR p.id=$2) AND ($3::text IS NULL OR r.row_key=$3)
          AND ($4::timestamptz IS NULL OR r.executed_at >= $4) AND ($5::timestamptz IS NULL OR r.executed_at < $5)
        ORDER BY r.executed_at, p.title, r.row_key`,
      [orgId, f.payoutId ?? null, f.row ?? null, f.from ?? null, f.to ?? null],
    );
    const out: PaymentRecord[] = [];
    for (const r of rows) {
      const amount = formatUnits(BigInt(r.amount), this.decimals);
      const { price, source } = await this.price.usdPrice(r.token, r.executed_at);
      const approvals = r.b_id
        ? (
            await this.db.query(
              `SELECT x.approver, x.created_at, (SELECT u.email FROM users u WHERE lower(u.wallet)=lower(x.approver) LIMIT 1) AS email
                 FROM approvals x WHERE x.batch_id=$1 ORDER BY x.created_at`,
              [r.b_id],
            )
          ).rows
        : [];
      out.push({
        rowId: r.row_key,
        payoutId: r.payout_id,
        payout: r.title,
        org: r.org_name,
        account: r.account,
        escrow: r.escrow,
        network: this.network.name ?? KNOWN[r.org_chain] ?? `chain ${r.org_chain}`,
        recipient: r.name,
        address: r.address,
        email: r.email,
        amount,
        token: this.tokenSymbol,
        usdValue: (Number(amount) * price).toFixed(2),
        priceSource: source,
        category: r.category,
        executedAt: utc(r.executed_at),
        status: STATUS[r.status] ?? r.status,
        txHash: r.tx_hash,
        requestedBy: r.requested_by ?? null,
        requestedAt: utc(r.requested_at),
        approvedBy: approvals.map((a) => ({ who: a.email ?? a.approver, at: utc(a.created_at)! })),
        threshold: `${r.threshold} of ${r.total_weight}`,
        delivery: delivery(r),
        settleTx: r.settle_tx,
      });
    }
    return out;
  }

  explorer(kind: "tx" | "address", v: string | null) {
    // EIP-3091 routes: <BLOCK_EXPLORER_URL>/tx/<TX_HASH>, <BLOCK_EXPLORER_URL>/address/<ACCOUNT_ADDRESS>
    return v && this.network.explorerUrl ? `${this.network.explorerUrl.replace(/\/$/, "")}/${kind}/${v}` : null;
  }

  /** A self-contained page for printing or saving as PDF; one payment per printed page. */
  html(records: PaymentRecord[], title: string): string {
    const e = esc;
    const link = (kind: "tx" | "address", v: string | null) => {
      if (!v) return "—";
      const u = this.explorer(kind, v);
      return u ? `<a href="${e(u)}">${e(v)}</a>` : `<span>${e(v)}</span>`;
    };
    const page = (r: PaymentRecord) => `
<section class="rec">
  <header><div class="brand">Omniflow</div><div class="kind">Payment record</div></header>
  <h1>${e(r.amount)} ${e(r.token)} to ${e(r.recipient)}</h1>
  <p class="sub">${e(r.status)} · ${e(r.executedAt ?? "")}</p>
  <table>
    <tr><th>Paid by</th><td>${e(r.org)}<br><span class="mono">${link("address", r.account)}</span></td></tr>
    <tr><th>Paid to</th><td>${e(r.recipient)}${r.address ? `<br><span class="mono">${link("address", r.address)}</span>` : ""}${r.email ? `<br>${e(r.email)}` : ""}</td></tr>
    <tr><th>Amount</th><td><b>${e(r.amount)} ${e(r.token)}</b></td></tr>
    <tr><th>Value in USD</th><td>${e(r.usdValue)} USD <span class="note">— ${e(r.priceSource)}</span></td></tr>
    <tr><th>Date</th><td>${e(r.executedAt ?? "—")}</td></tr>
    <tr><th>Category</th><td>${e(r.category ?? "—")}</td></tr>
    <tr><th>Payout</th><td>${e(r.payout)}</td></tr>
    <tr><th>Requested by</th><td>${e(r.requestedBy ?? "not recorded")}${r.requestedAt ? ` <span class="note">· ${e(r.requestedAt)}</span>` : ""}</td></tr>
    <tr><th>Approved by</th><td>${r.approvedBy.length ? r.approvedBy.map((a) => `${e(a.who)} <span class="note">· ${e(a.at)}</span>`).join("<br>") : "not recorded"}<br><span class="note">${e(r.threshold)} approvals required</span></td></tr>
    <tr><th>How it reached the recipient</th><td>${r.delivery.map(e).join("<br>")}</td></tr>
    <tr><th>Network</th><td>${e(r.network)}</td></tr>
    <tr><th>Transaction</th><td class="mono">${link("tx", r.txHash)}</td></tr>
    ${r.settleTx ? `<tr><th>${r.status.startsWith("Returned") ? "Return" : "Claim"} transaction</th><td class="mono">${link("tx", r.settleTx)}</td></tr>` : ""}
  </table>
  <footer>This is a record of a payment from the organization's account, generated by Omniflow on ${e(utc(new Date())!)}. It is not a tax form and not tax advice. Record ${e(r.payoutId)} / ${e(r.rowId)}.</footer>
</section>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; background: #f3f4f6; margin: 0; padding: 24px 16px; }
  .rec { background: #fff; max-width: 720px; margin: 0 auto 24px; padding: 32px; border: 1px solid #e5e7eb; border-radius: 10px; }
  header { display: flex; justify-content: space-between; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  .brand { font-weight: 700; color: #3a57e8; }
  h1 { font-size: 22px; margin: 16px 0 2px; }
  .sub { color: #6b7280; margin: 0 0 18px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; vertical-align: top; width: 34%; color: #4b5563; font-weight: 600; padding: 8px 12px 8px 0; border-top: 1px solid #f0f1f3; }
  td { padding: 8px 0; border-top: 1px solid #f0f1f3; overflow-wrap: anywhere; }
  .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  .note { color: #6b7280; font-size: 12px; }
  a { color: #2d47cc; }
  footer { margin-top: 20px; color: #6b7280; font-size: 11px; }
  @media print { body { background: #fff; padding: 0; } .rec { border: 0; margin: 0; padding: 0; max-width: none; break-after: page; } .rec:last-child { break-after: auto; } }
</style></head><body>
${records.length ? records.map(page).join("\n") : `<section class="rec"><h1>No payments</h1><p class="sub">Nothing left the account in this period.</p></section>`}
</body></html>
`;
  }
}

/** How the money reached the recipient — what they were given, and what happened to it. */
function delivery(r: Record<string, unknown>): string[] {
  const at = (d: unknown) => utc(d as string) ?? "a date not recorded";
  if (r.status === "sent") return [`Paid directly to the recipient's wallet ${r.address}.`];
  const out = [`A claim link was emailed to ${r.email ?? "the recipient"}; until claimed, the money was held by the escrow contract ${r.escrow}.`];
  if (r.status === "in_escrow") out.push(r.auto_refund_at ? `Not claimed yet. If it is not claimed by ${at(r.auto_refund_at)}, it returns to the organization.` : "Not claimed yet.");
  if (r.status === "claimed") out.push(`Claimed on ${at(r.claimed_at)}${r.claimed_to ? ` to the wallet ${r.claimed_to}` : ""}.`);
  if (r.status === "refunded") {
    const why = r.refund_by_expiry === true ? "the link expired unclaimed" : r.refund_by_expiry === false ? "the organization revoked it" : "it was not claimed";
    out.push(`Returned to the organization's account on ${at(r.refunded_at)}: ${why}.`);
  }
  return out;
}

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
