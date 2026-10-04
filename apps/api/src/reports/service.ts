import { formatUnits, type Address } from "viem";
import type { Db } from "../db/db.js";
import { RecordService, type NetworkInfo } from "./record.js";
import { documentLabel } from "../documents/irs.js";

/** USD value at the time of the operation. Where the number comes from is always part of the report. */
export interface PriceSource {
  usdPrice(token: Address, at: Date): Promise<{ price: number; source: string }>;
}

/**
 * Stablecoin at face value. An oracle (e.g. a Chainlink feed) is a separate decision; until then every report line
 * says "номинал", so an accountant knows the number is not a market quote.
 */
export class StablecoinParity implements PriceSource {
  async usdPrice(): Promise<{ price: number; source: string }> {
    return { price: 1, source: "stablecoin at par (1 USDC = 1 USD), not a market quote" };
  }
}

export interface ReportLine {
  date: string;
  payout: string;
  recipient: string;
  address: string | null;
  email: string | null;
  amount: string;
  token: string;
  usdValue: string;
  priceSource: string;
  category: string | null;
  status: string;
  txHash: string | null;
  claimedAt: string | null;
  /** DOCUMENT column: empty, "requested", or the form received (W-9, W-8BEN, W-8BEN-E) */
  document: string;
}

const STATUS_LABEL: Record<string, string> = { sent: "sent", in_escrow: "claim link sent, not yet claimed", claimed: "claimed via link", refunded: "returned to sender" };

export class ReportService {
  /** one page per payment (record.ts) */
  readonly records: RecordService;
  constructor(private readonly db: Db, private readonly price: PriceSource, private readonly decimals: number, private readonly tokenSymbol = "USDC", network: NetworkInfo = {}) {
    this.records = new RecordService(db, price, decimals, network, tokenSymbol);
  }

  /** Every row that left the account in the period: direct transfers and escrow deposits (claimed or not). */
  async payments(orgId: string, from?: Date, to?: Date): Promise<ReportLine[]> {
    const { rows } = await this.db.query(
      `SELECT r.*, p.title, o.token FROM payout_rows r JOIN payouts p ON p.id=r.payout_id JOIN orgs o ON o.id=p.org_id
        WHERE p.org_id=$1 AND r.executed_at IS NOT NULL
          AND ($2::timestamptz IS NULL OR r.executed_at >= $2) AND ($3::timestamptz IS NULL OR r.executed_at < $3)
        ORDER BY r.executed_at, p.title, r.row_key`,
      [orgId, from ?? null, to ?? null],
    );
    const out: ReportLine[] = [];
    for (const r of rows) {
      const amount = formatUnits(BigInt(r.amount), this.decimals);
      const { price, source } = await this.price.usdPrice(r.token, r.executed_at);
      out.push({
        date: new Date(r.executed_at).toISOString(),
        payout: r.title,
        recipient: r.name,
        address: r.address,
        email: r.email,
        amount,
        token: this.tokenSymbol,
        usdValue: (Number(amount) * price).toFixed(2),
        priceSource: source,
        category: r.category,
        status: r.status,
        txHash: r.tx_hash,
        claimedAt: r.claimed_at ? new Date(r.claimed_at).toISOString() : null,
        document: documentLabel(r.doc_required, r.doc_status),
      });
    }
    return out;
  }

  static toCsv(lines: ReportLine[]): string {
    const head = ["Date (UTC)", "Payout", "Recipient", "Address", "Email", "Amount", "Token", "USD value", "Price source", "Category", "Status", "Transaction hash", "Claimed at"];
    const esc = (v: unknown) => {
      let s = v === null || v === undefined ? "" : String(v);
      // CSV/formula injection: names come from uploaded files. Quoting alone does not stop spreadsheets from
      // evaluating "=...", so a leading apostrophe neutralises it.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = lines.map((l) => [l.date, l.payout, l.recipient, l.address, l.email, l.amount, l.token, l.usdValue, l.priceSource, l.category, STATUS_LABEL[l.status] ?? l.status, l.txHash, l.claimedAt].map(esc).join(","));
    return `﻿${[head.join(","), ...body].join("\n")}\n`;
  }
}
