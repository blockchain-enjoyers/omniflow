import {
  getAddress,
  hashMessage,
  recoverAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import {
  approveTypedData,
  batchExecutions,
  buildBatchCallData,
  callDataAndNonceHash,
  depositId,
  executionIndexToRow,
  formatClaimLink,
  generateClaimKey,
  reviewPayout,
  type BatchManifest,
  type FrozenRow,
  type PayoutRow,
} from "@omniflow/shared";
import { tx, type Db } from "../db/db.js";
import type { ChainClient } from "../chain/chain.js";
import { opFromJson, opToJson, type PackedOp } from "../chain/chain.js";
import type { ClaimKeyVault } from "../claimkeys/vault.js";
import type { Mailer } from "../mail/mailer.js";
import { parsePayoutCsv } from "./csv.js";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ServiceConfig {
  tokenDecimals: number;
  /** tip for whoever relays a claim, token base units, paid by the sender on top */
  claimTip: bigint;
  maxRowsPerBatch: number;
  claimBaseUrl: string;
  senderDisplayName: (orgName: string) => string;
}

type RowStatus =
  | "waiting_details" // no address and no email: waits in the same payout
  | "other_chain" // only the payout chain is paid
  | "ready"
  | "in_batch"
  | "sent" // direct transfer done
  | "in_escrow"
  | "claimed"
  | "refunded"
  | "failed";

const TERMINAL: RowStatus[] = ["sent", "claimed", "refunded"];

export class PayoutService {
  constructor(
    private readonly db: Db,
    private readonly chain: ChainClient,
    private readonly vault: ClaimKeyVault,
    private readonly mailer: Mailer,
    private readonly cfg: ServiceConfig,
  ) {}

  // ------------------------------------------------------------------ orgs

  /** Registers an organisation only if its approver set matches the validator on chain. */
  async createOrg(input: {
    name: string;
    account: Address;
    validator: Address;
    escrow: Address;
    token: Address;
    approvers: { address: Address; weight: number }[];
    autoRefundDays?: number | null;
  }) {
    const onChain = await this.chain.readApprovers(input.validator, input.account, input.approvers.map((a) => a.address));
    if (onChain.threshold === 0) throw new HttpError(400, "account has no weighted validator installed");
    for (const a of input.approvers) {
      const w = onChain.weights.find((x) => x.address === a.address)?.weight ?? 0;
      if (w !== a.weight) throw new HttpError(400, `approver ${a.address}: weight ${a.weight} differs from chain (${w})`);
    }
    return tx(this.db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO orgs (name, chain_id, account, validator, escrow, token, threshold, auto_refund_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [input.name, this.chain.cfg.chainId, getAddress(input.account), getAddress(input.validator), getAddress(input.escrow), getAddress(input.token), onChain.threshold, input.autoRefundDays ?? null],
      );
      const orgId = rows[0].id as string;
      for (const a of input.approvers) {
        await c.query(`INSERT INTO approvers (org_id, address, weight) VALUES ($1,$2,$3)`, [orgId, getAddress(a.address), a.weight]);
      }
      return { id: orgId, threshold: onChain.threshold };
    });
  }

  private async org(orgId: string) {
    const { rows } = await this.db.query(`SELECT * FROM orgs WHERE id = $1`, [orgId]);
    if (!rows[0]) throw new HttpError(404, "org not found");
    const approvers = await this.db.query(`SELECT address, weight FROM approvers WHERE org_id = $1`, [orgId]);
    const o = rows[0];
    return {
      id: o.id as string,
      name: o.name as string,
      chain_id: o.chain_id as number,
      account: o.account as Address,
      validator: o.validator as Address,
      escrow: o.escrow as Address,
      token: o.token as Address,
      threshold: o.threshold as number,
      auto_refund_days: o.auto_refund_days as number | null,
      approvers: approvers.rows as { address: Address; weight: number }[],
    };
  }

  // --------------------------------------------------------------- payouts

  async createPayout(orgId: string, input: { title: string; csv: string; autoRefundDays?: number | null }) {
    const org = await this.org(orgId);
    const { rows, errors } = parsePayoutCsv(input.csv, this.cfg.tokenDecimals);
    if (errors.length) throw new HttpError(400, JSON.stringify(errors));
    return tx(this.db, async (c) => {
      const p = await c.query(`INSERT INTO payouts (org_id, title, auto_refund_days) VALUES ($1,$2,$3) RETURNING id`, [
        orgId,
        input.title,
        input.autoRefundDays === undefined ? null : input.autoRefundDays,
      ]);
      const payoutId = p.rows[0].id as string;
      for (const r of rows) {
        const status: RowStatus =
          r.chainId !== org.chain_id ? "other_chain" : !r.address && !r.email ? "waiting_details" : "ready";
        await c.query(
          `INSERT INTO payout_rows (payout_id, row_key, name, email, address, chain_id, amount, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [payoutId, r.rowId, r.name, r.email ?? null, r.address ?? null, r.chainId, r.amount.toString(), status],
        );
      }
      return { id: payoutId, rows: rows.length };
    });
  }

  /** Summary and diff for the review screen. History = what this org already sent to each address. */
  async review(payoutId: string) {
    const p = await this.payout(payoutId);
    const org = await this.org(p.org_id);
    const rows = await this.rows(payoutId);
    const hist = await this.db.query(
      `SELECT DISTINCT ON (lower(r.address)) lower(r.address) AS a, r.amount
         FROM payout_rows r JOIN payouts p ON p.id = r.payout_id
        WHERE p.org_id = $1 AND p.id <> $2 AND r.address IS NOT NULL AND r.status IN ('sent')
        ORDER BY lower(r.address), p.created_at DESC`,
      [p.org_id, payoutId],
    );
    const prev = new Map<string, bigint>(hist.rows.map((h) => [h.a as string, BigInt(h.amount)]));
    const balance = (await this.chain.pub.readContract({
      address: org.token,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf",
      args: [org.account],
    })) as bigint;
    const pending = rows.filter((r) => ["ready", "other_chain", "waiting_details"].includes(r.status));
    const autoRefundDays = p.auto_refund_days ?? org.auto_refund_days;
    return { summary: reviewPayout({ rows: pending.map(toPayoutRow), payoutChainId: org.chain_id, previousAmountByAddress: prev, balance }), autoRefundDays };
  }

  /**
   * Freezes the next batch: up to maxRowsPerBatch ready rows become a manifest with fixed calldata and nonce.
   * One open batch per organisation — its nonce must not collide with another (double-send guard, layer 3).
   */
  async freezeBatch(payoutId: string) {
    const p = await this.payout(payoutId);
    const org = await this.org(p.org_id);
    const open = await this.db.query(
      `SELECT b.id FROM batches b JOIN payouts p ON p.id = b.payout_id
        WHERE p.org_id = $1 AND b.status IN ('collecting','ready_to_submit','submitted')`,
      [p.org_id],
    );
    if (open.rows.length) throw new HttpError(409, "another batch of this organisation is still open");
    const ready = (await this.rows(payoutId)).filter((r) => r.status === "ready").slice(0, this.cfg.maxRowsPerBatch);
    if (!ready.length) throw new HttpError(409, "no rows ready to pay");

    const nonce = await this.chain.getNonce(org.account);
    const days = p.auto_refund_days ?? org.auto_refund_days;
    const autoRefundAt = days ? Math.floor(Date.now() / 1000) + days * 86_400 : 0;
    const keys = new Map<string, Hex>();
    const frozen: FrozenRow[] = ready.map((r) => {
      if (r.address) return { kind: "transfer", rowId: r.row_key, to: getAddress(r.address), amount: BigInt(r.amount) };
      const k = generateClaimKey();
      keys.set(r.row_key, k.privateKey);
      return {
        kind: "escrow",
        rowId: r.row_key,
        depositId: depositId(org.account, payoutId, r.row_key),
        claimSigner: k.address,
        amount: BigInt(r.amount),
        tip: this.cfg.claimTip,
        autoRefundAt,
      };
    });
    const batchNo = Number((await this.db.query(`SELECT count(*) FROM batches WHERE payout_id = $1`, [payoutId])).rows[0].count);
    return this.insertBatch(org, payoutId, batchNo, nonce, frozen, "pay", ready, keys, autoRefundAt);
  }

  /** revoking unclaimed escrow deposits is a batch of escrow.refund calls under the same N-of-M. */
  async freezeRevoke(payoutId: string, rowKeys: string[]) {
    const p = await this.payout(payoutId);
    const org = await this.org(p.org_id);
    const rows = (await this.rows(payoutId)).filter((r) => rowKeys.includes(r.row_key) && r.status === "in_escrow");
    if (!rows.length) throw new HttpError(409, "no unclaimed escrow rows to revoke");
    const nonce = await this.chain.getNonce(org.account);
    const frozen: FrozenRow[] = rows.map((r) => ({ kind: "refund", rowId: r.row_key, depositId: r.deposit_id as Hex, amount: BigInt(r.amount) }));
    const batchNo = Number((await this.db.query(`SELECT count(*) FROM batches WHERE payout_id = $1`, [payoutId])).rows[0].count);
    return this.insertBatch(org, payoutId, batchNo, nonce, frozen, "revoke", [], new Map(), 0);
  }

  private async insertBatch(
    org: Awaited<ReturnType<PayoutService["org"]>>,
    payoutId: string,
    batchNo: number,
    nonce: bigint,
    frozen: FrozenRow[],
    kind: "pay" | "revoke",
    rowsToLock: DbRow[],
    keys: Map<string, Hex>,
    autoRefundAt: number,
  ) {
    const manifest: BatchManifest = {
      version: 1,
      chainId: org.chain_id,
      account: org.account,
      escrow: org.escrow,
      token: org.token,
      payoutId,
      batchNo,
      nonce,
      rows: frozen,
    };
    const callData = buildBatchCallData(manifest);
    const hash = callDataAndNonceHash(org.account, callData, nonce);
    return tx(this.db, async (c) => {
      const b = await c.query(
        `INSERT INTO batches (payout_id, batch_no, kind, nonce, manifest, call_data, approve_hash, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'collecting') RETURNING id`,
        [payoutId, batchNo, kind, nonce.toString(), manifestToJson(manifest), callData, hash],
      );
      const batchId = b.rows[0].id as string;
      for (const r of rowsToLock) {
        const fr = frozen.find((f) => f.rowId === r.row_key)!;
        await c.query(
          `UPDATE payout_rows SET status='in_batch', batch_id=$2, deposit_id=$3, claim_signer=$4, auto_refund_at=$5 WHERE id=$1 AND status='ready'`,
          [r.id, batchId, fr.kind === "escrow" ? fr.depositId : null, fr.kind === "escrow" ? fr.claimSigner : null, fr.kind === "escrow" && autoRefundAt ? new Date(autoRefundAt * 1000) : null],
        );
        const key = keys.get(r.row_key);
        if (key) {
          const s = this.vault.seal(key);
          await c.query(`INSERT INTO claim_keys (row_id, iv, ciphertext, tag) VALUES ($1,$2,$3,$4)`, [r.id, s.iv, s.ciphertext, s.tag]);
        }
      }
      await c.query(`UPDATE payouts SET status='confirming' WHERE id=$1 AND status IN ('draft','partially_executed')`, [payoutId]);
      return { id: batchId, approveHash: hash, manifest: manifestToJson(manifest) };
    });
  }

  // ------------------------------------------------------------- approvals

  /**
   * What this approver signs next: Approve(hash) typed data, or — if their weight completes the threshold —
   * the userOpHash of the op to submit (the last signature must be over userOpHash).
   */
  async nextStep(batchId: string, approver: Address) {
    const { batch, org } = await this.batchCtx(batchId);
    const me = org.approvers.find((a) => a.address === getAddress(approver));
    if (!me) throw new HttpError(403, "not an approver of this organisation");
    // A batch that is no longer collecting must not get a new op draft — that would overwrite the record.
    if (batch.status !== "collecting") return { step: "closed" as const, status: batch.status as string };
    const signed = await this.approvals(batchId);
    if (signed.some((s) => s.approver === me.address)) return { step: "done" as const };
    const weight = signed.reduce((s, a) => s + (org.approvers.find((x) => x.address === a.approver)?.weight ?? 0), 0);
    if (weight + me.weight < org.threshold) {
      return { step: "approve" as const, typedData: approveTypedData(org.validator, org.chain_id, batch.approve_hash), manifest: batch.manifest };
    }
    const m = manifestFromJson(batch.manifest);
    const op = await this.chain.draftOp(org.account, batch.call_data, BigInt(batch.nonce), batchExecutions(m).length);
    const userOpHash = await this.chain.getUserOpHash(op);
    await this.db.query(`UPDATE batches SET final_op=$2, user_op_hash=$3 WHERE id=$1`, [batchId, opToJson(op), userOpHash]);
    return { step: "final" as const, userOpHash, manifest: batch.manifest };
  }

  /** Stores an Approve(hash) signature after checking it recovers to an approver of the org. */
  async addApproval(batchId: string, signature: Hex) {
    const { batch, org } = await this.batchCtx(batchId);
    if (batch.status !== "collecting") throw new HttpError(409, `batch is ${batch.status}`);
    const signer = await recoverTypedDataAddress({ ...approveTypedData(org.validator, org.chain_id, batch.approve_hash), signature });
    if (!org.approvers.some((a) => a.address === signer)) throw new HttpError(403, "signature is not from an approver");
    const res = await this.db.query(
      `INSERT INTO approvals (batch_id, approver, kind, signature) VALUES ($1,$2,'approve',$3) ON CONFLICT DO NOTHING`,
      [batchId, signer, signature],
    );
    if (!res.rowCount) throw new HttpError(409, "this approver already signed");
    return { approver: signer };
  }

  /** Final signature over userOpHash: assemble approve signatures + this one, relay to EntryPoint. */
  async submitFinal(batchId: string, signature: Hex) {
    const { batch, org } = await this.batchCtx(batchId);
    if (batch.status !== "collecting") throw new HttpError(409, `batch is ${batch.status}`);
    if (!batch.final_op || !batch.user_op_hash) throw new HttpError(409, "no op prepared — call next-step first");
    const signer = getAddress(await recoverAddress({ hash: hashMessage({ raw: batch.user_op_hash }), signature }));
    const me = org.approvers.find((a) => a.address === signer);
    if (!me) throw new HttpError(403, "signature is not from an approver");
    const approvals = (await this.approvals(batchId)).filter((a) => a.kind === "approve" && a.approver !== signer);
    const weight = approvals.reduce((s, a) => s + (org.approvers.find((x) => x.address === a.approver)?.weight ?? 0), 0);
    if (weight + me.weight < org.threshold) throw new HttpError(409, "threshold not reached");

    const op: PackedOp = opFromJson(batch.final_op);
    op.signature = `0x${[...approvals.map((a) => a.signature), signature].map((s) => s.slice(2)).join("")}`;
    await this.db.query(`INSERT INTO approvals (batch_id, approver, kind, signature) VALUES ($1,$2,'final',$3) ON CONFLICT DO NOTHING`, [batchId, signer, signature]);
    const txHash = await this.chain.submitOp(op);
    await this.db.query(`UPDATE batches SET status='submitted', tx_hash=$2 WHERE id=$1`, [batchId, txHash]);
    return { txHash };
  }

  // --------------------------------------------------------------- indexer

  /** Applies the result of a submitted batch: row statuses, then claim emails for new escrow rows. */
  async settleBatch(batchId: string) {
    const { batch, org } = await this.batchCtx(batchId);
    if (batch.status !== "submitted") return;
    const r = await this.chain.waitOp(batch.tx_hash, org.account);
    const m = manifestFromJson(batch.manifest);
    const idx = executionIndexToRow(m);
    const failedRows = new Set(r.failedExecutions.map((i) => idx[i]));
    await tx(this.db, async (c) => {
      if (!r.success) {
        await c.query(`UPDATE batches SET status='failed' WHERE id=$1`, [batchId]);
        if (batch.kind === "pay") await c.query(`UPDATE payout_rows SET status='ready', batch_id=NULL WHERE batch_id=$1`, [batchId]);
        return;
      }
      await c.query(`UPDATE batches SET status='mined' WHERE id=$1`, [batchId]);
      for (const fr of m.rows) {
        if (fr.kind === "refund") continue; // applied from the Refunded event
        const failed = failedRows.has(fr.rowId);
        await c.query(
          `UPDATE payout_rows SET status=$3, fail_reason=$4, tx_hash=$5 WHERE payout_id=$1 AND row_key=$2`,
          [m.payoutId, fr.rowId, failed ? "failed" : fr.kind === "transfer" ? "sent" : "in_escrow", failed ? "execution reverted in batch" : null, r.txHash],
        );
      }
      await this.refreshPayoutStatus(c, m.payoutId);
    });
    await this.applyEscrowEvents(org, r.blockNumber, r.blockNumber);
    await this.sendClaimEmails(m.payoutId);
  }

  /** Scans escrow events (claims, refunds, expiries) from the cursor; idempotent per log. */
  async pollEscrow(orgId: string) {
    const org = await this.org(orgId);
    const cur = await this.db.query(`SELECT last_block FROM indexer_cursor WHERE chain_id=$1`, [org.chain_id]);
    const from = cur.rows[0] ? BigInt(cur.rows[0].last_block) + 1n : 0n;
    const to = await this.chain.blockNumber();
    if (from > to) return;
    await this.applyEscrowEvents(org, from, to);
    await this.db.query(
      `INSERT INTO indexer_cursor (chain_id, last_block) VALUES ($1,$2) ON CONFLICT (chain_id) DO UPDATE SET last_block=EXCLUDED.last_block`,
      [org.chain_id, to.toString()],
    );
  }

  private async applyEscrowEvents(org: { chain_id: number; escrow: Address }, from: bigint, to: bigint) {
    const events = await this.chain.escrowEvents(org.escrow, from, to);
    for (const { log, ev } of events) {
      if (ev.eventName !== "Claimed" && ev.eventName !== "Refunded") continue;
      await tx(this.db, async (c) => {
        const ins = await c.query(`INSERT INTO applied_logs VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [org.chain_id, log.transactionHash, log.logIndex]);
        if (!ins.rowCount) return;
        const status: RowStatus = ev.eventName === "Claimed" ? "claimed" : "refunded";
        const upd = await c.query(`UPDATE payout_rows SET status=$2 WHERE deposit_id=$1 RETURNING payout_id`, [ev.args.id, status]);
        for (const u of upd.rows) await this.refreshPayoutStatus(c, u.payout_id);
      });
    }
  }

  /** Sends claim links for rows whose deposit is on chain, then deletes the key. */
  async sendClaimEmails(payoutId: string) {
    const p = await this.payout(payoutId);
    const org = await this.org(p.org_id);
    const { rows } = await this.db.query(
      `SELECT r.*, k.iv, k.ciphertext, k.tag FROM payout_rows r JOIN claim_keys k ON k.row_id = r.id
        WHERE r.payout_id=$1 AND r.status IN ('in_escrow','claimed','refunded')`,
      [payoutId],
    );
    for (const r of rows) {
      const key = this.vault.open(r);
      const link = formatClaimLink(this.cfg.claimBaseUrl, { chainId: org.chain_id, escrow: org.escrow, depositId: r.deposit_id, key });
      await tx(this.db, async (c) => {
        const ins = await c.query(`INSERT INTO emails (row_id, kind) VALUES ($1,'claim') ON CONFLICT DO NOTHING`, [r.id]);
        if (ins.rowCount) {
          await this.mailer.send({
            to: r.email,
            subject: `${this.cfg.senderDisplayName(org.name)}: вам отправлен платёж`,
            text: `Здравствуйте, ${r.name}.\n\n${org.name} отправил(а) вам платёж. Чтобы получить деньги, откройте ссылку:\n${link}\n\nСсылка — единственный ключ к платежу. Не пересылайте её никому.`,
          });
        }
        await c.query(`DELETE FROM claim_keys WHERE row_id=$1`, [r.id]);
      });
    }
  }

  /** Keeper: permissionless refundExpired for due deposits. Anyone could do it; we do it for convenience. */
  async runKeeper(orgId: string, now = new Date()) {
    const org = await this.org(orgId);
    const { rows } = await this.db.query(
      `SELECT r.deposit_id FROM payout_rows r JOIN payouts p ON p.id=r.payout_id
        WHERE p.org_id=$1 AND r.status='in_escrow' AND r.auto_refund_at IS NOT NULL AND r.auto_refund_at <= $2`,
      [orgId, now],
    );
    for (const r of rows) {
      const h = await this.chain.refundExpired(org.escrow, r.deposit_id);
      await this.chain.waitTx(h);
    }
    await this.pollEscrow(orgId);
    return { refunded: rows.length };
  }

  // --------------------------------------------------------- close, receipt

  /** closes by hand; unexecuted rows stay in reports as not executed. */
  async closePayout(payoutId: string) {
    await this.db.query(`UPDATE payouts SET status='closed', closed_at=now() WHERE id=$1 AND status <> 'closed'`, [payoutId]);
  }

  async receipt(payoutId: string) {
    const p = await this.payout(payoutId);
    const rows = await this.rows(payoutId);
    return {
      payout: { id: p.id, title: p.title, status: p.status, closedAt: p.closed_at },
      rows: rows.map((r) => ({
        row: r.row_key,
        name: r.name,
        email: r.email,
        address: r.address,
        amount: r.amount,
        status: r.status,
        executed: TERMINAL.includes(r.status as RowStatus) || r.status === "in_escrow",
        failReason: r.fail_reason,
        txHash: r.tx_hash,
        depositId: r.deposit_id,
      })),
    };
  }

  // ----------------------------------------------------------------- utils

  private async refreshPayoutStatus(c: { query: Db["query"] }, payoutId: string) {
    const { rows } = await c.query(`SELECT status FROM payout_rows WHERE payout_id=$1`, [payoutId]);
    const all = rows.map((r: { status: RowStatus }) => r.status);
    const status = all.every((s: RowStatus) => TERMINAL.includes(s))
      ? "closed"
      : all.some((s: RowStatus) => s !== "ready" && s !== "waiting_details" && s !== "other_chain")
        ? "partially_executed"
        : "draft";
    await c.query(
      `UPDATE payouts SET status=$2, closed_at=CASE WHEN $2='closed' THEN now() ELSE closed_at END WHERE id=$1 AND status <> 'closed'`,
      [payoutId, status],
    );
  }

  private async payout(id: string) {
    const { rows } = await this.db.query(`SELECT * FROM payouts WHERE id=$1`, [id]);
    if (!rows[0]) throw new HttpError(404, "payout not found");
    return rows[0];
  }

  private async rows(payoutId: string): Promise<DbRow[]> {
    return (await this.db.query(`SELECT * FROM payout_rows WHERE payout_id=$1 ORDER BY row_key`, [payoutId])).rows;
  }

  private async approvals(batchId: string): Promise<{ approver: Address; kind: string; signature: Hex }[]> {
    return (await this.db.query(`SELECT approver, kind, signature FROM approvals WHERE batch_id=$1 ORDER BY created_at`, [batchId])).rows;
  }

  private async batchCtx(batchId: string) {
    const { rows } = await this.db.query(`SELECT * FROM batches WHERE id=$1`, [batchId]);
    if (!rows[0]) throw new HttpError(404, "batch not found");
    const p = await this.payout(rows[0].payout_id);
    return { batch: rows[0], org: await this.org(p.org_id) };
  }

  /**
   * One scheduler pass: settle batches left 'submitted' (e.g. after a restart), index escrow events,
   * run the auto-refund keeper. Every step is idempotent.
   */
  async tick() {
    const stuck = await this.db.query(`SELECT id FROM batches WHERE status='submitted'`);
    for (const b of stuck.rows) await this.settleBatch(b.id).catch((e) => console.error("settle", b.id, e));
    const orgs = await this.db.query(`SELECT id FROM orgs`);
    for (const o of orgs.rows) {
      await this.pollEscrow(o.id).catch((e) => console.error("poll", o.id, e));
      await this.runKeeper(o.id).catch((e) => console.error("keeper", o.id, e));
    }
  }

  async batchesOf(payoutId: string) {
    return (await this.db.query(`SELECT id, batch_no, kind, status, approve_hash, tx_hash FROM batches WHERE payout_id=$1 ORDER BY batch_no`, [payoutId])).rows;
  }
}

interface DbRow {
  id: string;
  row_key: string;
  name: string;
  email: string | null;
  address: string | null;
  chain_id: number;
  amount: string;
  status: RowStatus;
  deposit_id: string | null;
  fail_reason: string | null;
  tx_hash: string | null;
}

const toPayoutRow = (r: DbRow): PayoutRow => ({
  rowId: r.row_key,
  name: r.name,
  email: r.email ?? undefined,
  address: r.address ? (getAddress(r.address) as Address) : undefined,
  chainId: r.chain_id,
  amount: BigInt(r.amount),
});

export function manifestToJson(m: BatchManifest) {
  return JSON.parse(JSON.stringify(m, (_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v)));
}

export function manifestFromJson(j: unknown): BatchManifest {
  return JSON.parse(JSON.stringify(j), (_k, v) => (v && typeof v === "object" && "$big" in v ? BigInt(v.$big) : v));
}
