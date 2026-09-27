import { formatEther, type Address } from "viem";
import type { Db } from "../db/db.js";
import type { ChainClient } from "../chain/chain.js";

/**
 * What an operator of Omniflow needs to know without looking: is the API able to move money, and is
 * anything waiting that should not be. Serves /health and raises alerts from the scheduler.
 */
export interface MonitorConfig {
  /** below this the submitter cannot create accounts, relay claims or auto-refund. Default 0.005 ETH */
  minSubmitterWei?: bigint;
  /** a batch "submitted" longer than this did not land. Default 15 min */
  stuckAfterMinutes?: number;
  /** blocks the escrow indexer may trail the head. Default 5000 */
  maxIndexerLag?: bigint;
  /** POST {"text": …} here (Slack-style incoming webhooks accept it); without it alerts only go to the log */
  webhookUrl?: string;
  /** the same alert is repeated at most this often. Default 1 h */
  repeatMs?: number;
}

export interface Health {
  ok: boolean;
  checks: { db: boolean; rpc: boolean; bundler: boolean | null };
  headBlock: string | null;
  submitter: { address: Address; balanceEth: string | null; low: boolean };
  stuckBatches: number;
  indexerLag: string | null;
  warnings: { kind: string; text: string }[];
}

export class Monitor {
  private readonly last = new Map<string, number>();
  private readonly active = new Set<string>();

  constructor(private readonly db: Db, private readonly chain: ChainClient, private readonly cfg: MonitorConfig = {}) {}

  async status(): Promise<Health> {
    const warnings: Health["warnings"] = [];
    const db = await this.db.query("SELECT 1").then(() => true, () => false);
    const head = await this.chain.blockNumber().catch(() => null);
    const bundler = this.chain.bundler ? await this.chain.bundler.supported().then(() => true, () => false) : null;
    const balance = await this.chain.pub.getBalance({ address: this.chain.submitter }).catch(() => null);
    const min = this.cfg.minSubmitterWei ?? 5_000_000_000_000_000n;
    const low = balance !== null && balance < min;
    if (low) warnings.push({ kind: "submitter-eth", text: `API submitter ${this.chain.submitter} has ${formatEther(balance!)} ETH (minimum ${formatEther(min)}): it cannot create accounts, relay claims or auto-refund when empty` });
    if (balance === null && head !== null) warnings.push({ kind: "submitter-eth", text: "cannot read the API submitter balance" });

    let stuck = 0;
    let lag: bigint | null = null;
    if (db) {
      stuck = Number((await this.db.query(`SELECT count(*) FROM batches WHERE status='submitted' AND submitted_at < now() - make_interval(mins => $1)`, [this.cfg.stuckAfterMinutes ?? 15])).rows[0].count);
      if (stuck) warnings.push({ kind: "stuck-batches", text: `${stuck} batch(es) submitted more than ${this.cfg.stuckAfterMinutes ?? 15} min ago and still not on chain` });
      const cur = (await this.db.query(`SELECT min(last_block) AS b FROM indexer_cursor WHERE chain_id=$1`, [this.chain.cfg.chainId])).rows[0]?.b;
      if (head !== null && cur !== null && cur !== undefined) {
        lag = head - BigInt(cur);
        if (lag > (this.cfg.maxIndexerLag ?? 5000n)) warnings.push({ kind: "indexer-lag", text: `escrow indexer is ${lag} blocks behind the chain: claims and refunds show late` });
      }
    }
    if (!db) warnings.push({ kind: "db", text: "database unreachable" });
    if (head === null) warnings.push({ kind: "rpc", text: "chain RPC unreachable" });
    if (bundler === false) warnings.push({ kind: "bundler", text: "bundler RPC unreachable: approved batches cannot be sent" });
    return {
      ok: db && head !== null && bundler !== false,
      checks: { db, rpc: head !== null, bundler },
      headBlock: head?.toString() ?? null,
      submitter: { address: this.chain.submitter, balanceEth: balance === null ? null : formatEther(balance), low },
      stuckBatches: stuck,
      indexerLag: lag?.toString() ?? null,
      warnings,
    };
  }

  /** One scheduler pass: alert on new or repeated problems (throttled), and once when a problem clears. */
  async run(now = Date.now()): Promise<Health> {
    const h = await this.status();
    const kinds = new Set(h.warnings.map((w) => w.kind));
    for (const w of h.warnings) {
      const prev = this.last.get(w.kind);
      if (prev === undefined || now - prev >= (this.cfg.repeatMs ?? 3_600_000)) {
        this.last.set(w.kind, now);
        await this.alert(w.kind, `⚠ Omniflow: ${w.text}`);
      }
      this.active.add(w.kind);
    }
    for (const k of [...this.active]) {
      if (kinds.has(k)) continue;
      this.active.delete(k);
      this.last.delete(k);
      await this.alert(k, `✓ Omniflow: resolved — ${k}`);
    }
    return h;
  }

  private async alert(kind: string, text: string) {
    console.warn(JSON.stringify({ level: "warn", alert: kind, text, at: new Date().toISOString() }));
    if (!this.cfg.webhookUrl) return;
    try {
      await fetch(this.cfg.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    } catch (e) {
      console.error(JSON.stringify({ level: "error", alert: "webhook", text: (e as Error).message }));
    }
  }
}
