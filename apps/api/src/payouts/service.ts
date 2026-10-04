import {
  concatHex,
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
import { minCallGas, opFromJson, opToJson, type PackedOp } from "../chain/chain.js";
import type { ClaimKeyVault } from "../claimkeys/vault.js";
import type { Sponsor } from "../chain/paymaster.js";
import { withGas } from "../chain/bundler.js";

/** Dummy last signature for simulation — the value @zerodev/weighted-ecdsa-validator 5.4.4 uses in getStubSignature. */
const STUB_FINAL_SIGNATURE: Hex =
  "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c";
import type { Mailer } from "../mail/mailer.js";
import { parsePayoutCsv, validateRow, type CsvProblem, type RowInput } from "./csv.js";
import { documentLabel } from "../documents/irs.js";

export class HttpError extends Error {
  /** details: machine-readable problems the UI shows next to the fields (e.g. CSV lines) */
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

export interface ServiceConfig {
  tokenDecimals: number;
  /** tip for whoever relays a claim, token base units, paid by the sender on top */
  claimTip: bigint;
  maxRowsPerBatch: number;
  claimBaseUrl: string;
  /** cabinet URL for links in emails */
  appUrl: string;
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
    private readonly sponsor?: Sponsor,
  ) {}

  // ------------------------------------------------------------------ orgs

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

  /** Rows from a file or pasted cells, or typed by hand — checked the same way; nothing is saved (the import preview). */
  async parseRows(orgId: string, input: { csv?: string; rows?: RowInput[] }) {
    const org = await this.org(orgId);
    if (input.rows) {
      const errors: CsvProblem[] = [];
      const rows: PayoutRow[] = [];
      input.rows.forEach((r, i) => {
        const v = validateRow(r, i + 1, this.cfg.tokenDecimals, org.chain_id);
        errors.push(...v.errors);
        if (v.row) rows.push({ ...v.row, rowId: `row-${i + 2}` });
      });
      return { rows, errors, warnings: [] as CsvProblem[], chainId: org.chain_id };
    }
    const r = parsePayoutCsv(input.csv ?? "", this.cfg.tokenDecimals, org.chain_id);
    return { rows: r.rows as PayoutRow[], errors: r.errors, warnings: r.warnings, chainId: org.chain_id };
  }

  async createPayout(orgId: string, input: { title: string; csv?: string; rows?: RowInput[]; autoRefundDays?: number | null }) {
    const { rows, errors } = await this.parseRows(orgId, input);
    if (errors.length) throw new HttpError(400, `${errors.length} problem(s) in the rows — fix them and try again`, { problems: errors });
    return this.createPayoutFromRows(orgId, { title: input.title, autoRefundDays: input.autoRefundDays, rows, source: input.rows ? "manual" : "csv" });
  }

  async createPayoutFromRows(orgId: string, input: { title: string; rows: PayoutRow[]; autoRefundDays?: number | null; source: string; scheduleId?: string }) {
    const org = await this.org(orgId);
    const rows = input.rows;
    const title = (input.title ?? "").trim();
    if (!title) throw new HttpError(400, "give the payout a title");
    if (title.length > 120) throw new HttpError(400, "the title is too long (120 characters at most)");
    if (!rows.length) throw new HttpError(400, "add at least one row");
    input = { ...input, title };
    return tx(this.db, async (c) => {
      const p = await c.query(`INSERT INTO payouts (org_id, title, auto_refund_days, schedule_id) VALUES ($1,$2,$3,$4) RETURNING id`, [
        orgId,
        input.title,
        input.autoRefundDays === undefined ? null : input.autoRefundDays,
        input.scheduleId ?? null,
      ]);
      const payoutId = p.rows[0].id as string;
      for (const r of rows) {
        const status: RowStatus =
          r.chainId !== org.chain_id ? "other_chain" : !r.address && !r.email ? "waiting_details" : "ready";
        await c.query(
          `INSERT INTO payout_rows (payout_id, row_key, name, email, address, chain_id, amount, status, category, details_source, doc_required)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [payoutId, r.rowId, r.name, r.email ?? null, r.address ?? null, r.chainId, r.amount.toString(), status, r.category ?? null, input.source, r.docRequired ?? "none"],
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
  async freezeBatch(payoutId: string, requestedBy?: string) {
    const p = await this.payout(payoutId);
    const org = await this.org(p.org_id);
    const open = await this.db.query(
      `SELECT b.id FROM batches b JOIN payouts p ON p.id = b.payout_id
        WHERE p.org_id = $1 AND b.status IN ('collecting','ready_to_submit','submitted')`,
      [p.org_id],
    );
    if (open.rows.length) throw new HttpError(409, "another batch of this organisation is still open");
    // A row that failed inside an earlier batch is retried by the next one.
    const ready = (await this.rows(payoutId)).filter((r) => r.status === "ready" || r.status === "failed").slice(0, this.cfg.maxRowsPerBatch);
    if (!ready.length) throw new HttpError(409, "no rows ready to pay");

    const nonce = await this.chain.getNonce(org.account);
    const days = p.auto_refund_days ?? org.auto_refund_days;
    // Chain time, not the server clock: the escrow rejects autoRefundAt <= block.timestamp.
    const chainNow = Number((await this.chain.pub.getBlock({ blockTag: "latest" })).timestamp);
    const autoRefundAt = days ? chainNow + days * 86_400 : 0;
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
    return this.insertBatch(org, payoutId, batchNo, nonce, frozen, "pay", ready, keys, autoRefundAt, requestedBy);
  }

  /** revoking unclaimed escrow deposits is a batch of escrow.refund calls under the same N-of-M. */
  async freezeRevoke(payoutId: string, rowKeys: string[], requestedBy?: string) {
    const p = await this.payout(payoutId);
    const org = await this.org(p.org_id);
    const rows = (await this.rows(payoutId)).filter((r) => rowKeys.includes(r.row_key) && r.status === "in_escrow");
    if (!rows.length) throw new HttpError(409, "no unclaimed escrow rows to revoke");
    const nonce = await this.chain.getNonce(org.account);
    const frozen: FrozenRow[] = rows.map((r) => ({ kind: "refund", rowId: r.row_key, depositId: r.deposit_id as Hex, amount: BigInt(r.amount) }));
    const batchNo = Number((await this.db.query(`SELECT count(*) FROM batches WHERE payout_id = $1`, [payoutId])).rows[0].count);
    return this.insertBatch(org, payoutId, batchNo, nonce, frozen, "revoke", [], new Map(), 0, requestedBy);
  }

  /**
   * a new claim link for unclaimed deposits (email in spam, link leaked). escrow.rekey under the same N-of-M;
   * the new key is emailed only after the rekey is on chain — until then the old link keeps working.
   */
  async freezeRekey(payoutId: string, rowKeys: string[], requestedBy?: string) {
    const p = await this.payout(payoutId);
    const org = await this.org(p.org_id);
    const rows = (await this.rows(payoutId)).filter((r) => rowKeys.includes(r.row_key) && r.status === "in_escrow" && r.email);
    if (!rows.length) throw new HttpError(409, "no unclaimed escrow rows with an email to re-issue");
    const nonce = await this.chain.getNonce(org.account);
    const keys = rows.map((r) => ({ r, k: generateClaimKey() }));
    const frozen: FrozenRow[] = keys.map(({ r, k }) => ({ kind: "rekey", rowId: r.row_key, depositId: r.deposit_id as Hex, newClaimSigner: k.address, amount: 0n }));
    const batchNo = Number((await this.db.query(`SELECT count(*) FROM batches WHERE payout_id = $1`, [payoutId])).rows[0].count);
    const b = await this.insertBatch(org, payoutId, batchNo, nonce, frozen, "rekey", [], new Map(), 0, requestedBy);
    for (const { r, k } of keys) {
      const sealed = this.vault.seal(k.privateKey);
      await this.db.query(
        `INSERT INTO claim_keys (row_id, iv, ciphertext, tag) VALUES ($1,$2,$3,$4) ON CONFLICT (row_id) DO UPDATE SET iv=EXCLUDED.iv, ciphertext=EXCLUDED.ciphertext, tag=EXCLUDED.tag`,
        [r.id, sealed.iv, sealed.ciphertext, sealed.tag],
      );
      await this.db.query(`UPDATE payout_rows SET rekey_pending=true WHERE id=$1`, [r.id]);
    }
    return b;
  }

  private async insertBatch(
    org: Awaited<ReturnType<PayoutService["org"]>>,
    payoutId: string,
    batchNo: number,
    nonce: bigint,
    frozen: FrozenRow[],
    kind: "pay" | "revoke" | "rekey",
    rowsToLock: DbRow[],
    keys: Map<string, Hex>,
    autoRefundAt: number,
    requestedBy?: string,
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
        `INSERT INTO batches (payout_id, batch_no, kind, nonce, manifest, call_data, approve_hash, status, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'collecting',$8) RETURNING id`,
        [payoutId, batchNo, kind, nonce.toString(), manifestToJson(manifest), callData, hash, requestedBy ?? null],
      );
      const batchId = b.rows[0].id as string;
      for (const r of rowsToLock) {
        const fr = frozen.find((f) => f.rowId === r.row_key)!;
        await c.query(
          `UPDATE payout_rows SET status='in_batch', batch_id=$2, deposit_id=$3, claim_signer=$4, auto_refund_at=$5, fail_reason=NULL WHERE id=$1 AND status IN ('ready','failed')`,
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
    const payoutId = (batch.manifest as { payoutId: string }).payoutId;
    if (batch.status !== "collecting") return { step: "closed" as const, status: batch.status as string, payoutId };
    const signed = await this.approvals(batchId);
    if (signed.some((s) => s.approver === me.address)) return { step: "done" as const, payoutId };
    const weight = signed.reduce((s, a) => s + (org.approvers.find((x) => x.address === a.approver)?.weight ?? 0), 0);
    if (weight + me.weight < org.threshold) {
      return { step: "approve" as const, typedData: approveTypedData(org.validator, org.chain_id, batch.approve_hash), manifest: batch.manifest };
    }
    const m = manifestFromJson(batch.manifest);
    let op = await this.chain.draftOp(org.account, batch.call_data, BigInt(batch.nonce), batchExecutions(m).length);
    // Simulation (sponsor, bundler estimate) needs a signature that passes validation: the real Approve signatures
    // plus a dummy last one — what ZeroDev's WeightedECDSAValidator plugin does in getStubSignature.
    op.signature = concatHex([...signed.filter((a) => a.kind === "approve").map((a) => a.signature as Hex), STUB_FINAL_SIGNATURE]);
    // Omniflow pays gas when a paymaster is configured; paymasterAndData and the gas fields are part of
    // userOpHash, so they must be final before the last approver signs.
    const floor = minCallGas(batchExecutions(m).length);
    if (this.sponsor) op = await this.sponsor.sponsor(op);
    else if (this.chain.bundler) {
      const est = await this.chain.bundler.estimate(op);
      op = withGas(op, { ...est, callGasLimit: BigInt(est.callGasLimit) > floor ? BigInt(est.callGasLimit) : floor });
    }
    // Fail closed: with TRY batches a low callGasLimit drops rows silently. The sponsor's signature covers the gas
    // fields, so they cannot be raised afterwards — refuse to put such an op in front of an approver.
    const callGas = BigInt(op.accountGasLimits) & ((1n << 128n) - 1n);
    if (callGas < floor) throw new HttpError(502, `gas sponsor set callGasLimit ${callGas}, below the minimum ${floor} for ${batchExecutions(m).length} calls — not sending an operation that would execute partially`);
    op.signature = "0x";
    const userOpHash = await this.chain.getUserOpHash(op);
    await this.db.query(`UPDATE batches SET final_op=$2, user_op_hash=$3 WHERE id=$1`, [batchId, opToJson(op), userOpHash]);
    return { step: "final" as const, userOpHash, manifest: batch.manifest };
  }

  /** Stores an Approve(hash) signature after checking it recovers to an approver of the org. */
  async addApproval(batchId: string, signature: Hex, expectedSigner?: Address) {
    const { batch, org } = await this.batchCtx(batchId);
    if (batch.status !== "collecting") throw new HttpError(409, `batch is ${batch.status}`);
    const signer = await recoverTypedDataAddress({ ...approveTypedData(org.validator, org.chain_id, batch.approve_hash), signature });
    if (!org.approvers.some((a) => a.address === signer)) throw new HttpError(403, "signature is not from an approver");
    // Checked BEFORE storing: a caller must not be able to file someone else's (genuine) signature.
    if (expectedSigner && getAddress(expectedSigner) !== signer) throw new HttpError(403, "signature is not from your wallet");
    const res = await this.db.query(
      `INSERT INTO approvals (batch_id, approver, kind, signature) VALUES ($1,$2,'approve',$3) ON CONFLICT DO NOTHING`,
      [batchId, signer, signature],
    );
    if (!res.rowCount) throw new HttpError(409, "this approver already signed");
    return { approver: signer };
  }

  /** Final signature over userOpHash: assemble approve signatures + this one, relay to EntryPoint. */
  async submitFinal(batchId: string, signature: Hex, expectedSigner?: Address) {
    const { batch, org } = await this.batchCtx(batchId);
    if (batch.status !== "collecting") throw new HttpError(409, `batch is ${batch.status}`);
    if (!batch.final_op || !batch.user_op_hash) throw new HttpError(409, "no op prepared — call next-step first");
    const signer = getAddress(await recoverAddress({ hash: hashMessage({ raw: batch.user_op_hash }), signature }));
    const me = org.approvers.find((a) => a.address === signer);
    if (!me) throw new HttpError(403, "signature is not from an approver");
    if (expectedSigner && getAddress(expectedSigner) !== signer) throw new HttpError(403, "signature is not from your wallet");
    const approvals = (await this.approvals(batchId)).filter((a) => a.kind === "approve" && a.approver !== signer);
    const weight = approvals.reduce((s, a) => s + (org.approvers.find((x) => x.address === a.approver)?.weight ?? 0), 0);
    if (weight + me.weight < org.threshold) throw new HttpError(409, "threshold not reached");

    const op: PackedOp = opFromJson(batch.final_op);
    op.signature = `0x${[...approvals.map((a) => a.signature), signature].map((s) => s.slice(2)).join("")}`;
    await this.db.query(`INSERT INTO approvals (batch_id, approver, kind, signature) VALUES ($1,$2,'final',$3) ON CONFLICT DO NOTHING`, [batchId, signer, signature]);
    // With a hosted bundler the transaction hash is known only after inclusion; settleBatch records it.
    const sent = await this.chain.submitOp(op);
    await this.db.query(`UPDATE batches SET status='submitted', tx_hash=$2, submitted_at=now() WHERE id=$1`, [batchId, sent.txHash]);
    return sent;
  }

  // --------------------------------------------------------------- indexer

  /** Applies the result of a submitted batch: row statuses, then claim emails for new escrow rows. */
  /** Callers in this process that settle the same batch wait for one and the same pass. */
  private readonly settling = new Map<string, Promise<void>>();
  settleBatch(batchId: string): Promise<void> {
    let p = this.settling.get(batchId);
    if (!p) {
      p = this.settleOnce(batchId).finally(() => this.settling.delete(batchId));
      this.settling.set(batchId, p);
    }
    return p;
  }

  private async settleOnce(batchId: string) {
    const { batch, org } = await this.batchCtx(batchId);
    if (batch.status !== "submitted") return;
    const r = await this.chain.waitOp({ userOpHash: batch.user_op_hash as Hex, txHash: batch.tx_hash as Hex | null }, org.account);
    const m = manifestFromJson(batch.manifest);
    const idx = executionIndexToRow(m);
    const failedRows = new Set(r.failedExecutions.map((i) => idx[i]));
    // Two callers can settle the same batch (right after the last signature, and the scheduler's stuck-batch pass).
    // Only the one that moves the batch out of 'submitted' applies it: a late second pass must not write row statuses
    // over what happened since (a claim, a refund), nor send the emails twice.
    let applied = false;
    await tx(this.db, async (c) => {
      const own = await c.query(`UPDATE batches SET status=$2, tx_hash=$3 WHERE id=$1 AND status='submitted'`, [batchId, r.success ? "mined" : "failed", r.txHash]);
      if (!own.rowCount) return;
      applied = true;
      if (!r.success) {
        if (batch.kind === "pay") await c.query(`UPDATE payout_rows SET status='ready', batch_id=NULL WHERE batch_id=$1`, [batchId]);
        if (batch.kind === "rekey") {
          for (const fr of m.rows) await c.query(`UPDATE payout_rows SET rekey_pending=false WHERE payout_id=$1 AND row_key=$2`, [m.payoutId, fr.rowId]);
          await c.query(`DELETE FROM claim_keys k USING payout_rows r WHERE k.row_id=r.id AND r.payout_id=$1 AND r.row_key = ANY($2)`, [m.payoutId, m.rows.map((x) => x.rowId)]);
        }
        return;
      }
      for (const fr of m.rows) {
        if (fr.kind === "refund") continue; // applied from the Refunded event
        const failed = failedRows.has(fr.rowId);
        if (fr.kind === "rekey") {
          if (failed) {
            await c.query(`UPDATE payout_rows SET rekey_pending=false WHERE payout_id=$1 AND row_key=$2`, [m.payoutId, fr.rowId]);
            await c.query(`DELETE FROM claim_keys k USING payout_rows r WHERE k.row_id=r.id AND r.payout_id=$1 AND r.row_key=$2`, [m.payoutId, fr.rowId]);
          } else {
            await c.query(`UPDATE payout_rows SET rekey_pending=false, claim_signer=$3 WHERE payout_id=$1 AND row_key=$2`, [m.payoutId, fr.rowId, fr.newClaimSigner]);
          }
          continue;
        }
        // a failed escrow row never created a deposit: its claim key must not linger
        if (failed && fr.kind === "escrow") {
          await c.query(`DELETE FROM claim_keys k USING payout_rows r WHERE k.row_id=r.id AND r.payout_id=$1 AND r.row_key=$2`, [m.payoutId, fr.rowId]);
        }
        await c.query(
          // a claim indexed before this write already moved the row on: keep that status
          `UPDATE payout_rows SET status=CASE WHEN status='in_batch' THEN $3 ELSE status END, fail_reason=$4, tx_hash=$5, executed_at=$6 WHERE payout_id=$1 AND row_key=$2`,
          [m.payoutId, fr.rowId, failed ? "failed" : fr.kind === "transfer" ? "sent" : "in_escrow", failed ? "execution reverted in batch" : null, r.txHash, failed ? null : r.blockTime],
        );
      }
      await this.refreshPayoutStatus(c, m.payoutId);
    });
    if (!applied) return;
    await this.applyEscrowEvents(org, r.blockNumber, r.blockNumber);
    await this.sendClaimEmails(m.payoutId);
    if (r.success) {
      await this.notifyApprovers(batchId, "sent");
      await this.afterSettle?.(m.payoutId);
    }
  }

  /** Hook for the address book (ListService.rememberPaid). */
  afterSettle?: (payoutId: string) => Promise<void>;

  /** Scans escrow events (claims, refunds, expiries) from the cursor; idempotent per log. */
  async pollEscrow(orgId: string) {
    const org = await this.org(orgId);
    const cur = await this.db.query(`SELECT last_block FROM indexer_cursor WHERE chain_id=$1`, [org.chain_id]);
    const from = cur.rows[0] ? BigInt(cur.rows[0].last_block) + 1n : 0n;
    const to = await this.chain.blockNumber();
    if (from > to) return;
    // In bounded ranges, saving the cursor after each: a restart resumes where it stopped, not from the start of a gap.
    for (const [a, b] of this.chain.chunks(from, to)) {
      await this.applyEscrowEvents(org, a, b);
      await this.db.query(
        `INSERT INTO indexer_cursor (chain_id, last_block) VALUES ($1,$2) ON CONFLICT (chain_id) DO UPDATE SET last_block=EXCLUDED.last_block`,
        [org.chain_id, b.toString()],
      );
    }
  }

  private async applyEscrowEvents(org: { chain_id: number; escrow: Address }, from: bigint, to: bigint) {
    const events = await this.chain.escrowEvents(org.escrow, from, to);
    for (const { log, ev } of events) {
      if (ev.eventName !== "Claimed" && ev.eventName !== "Refunded") continue;
      await tx(this.db, async (c) => {
        const ins = await c.query(`INSERT INTO applied_logs VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [org.chain_id, log.transactionHash, log.logIndex]);
        if (!ins.rowCount) return;
        const status: RowStatus = ev.eventName === "Claimed" ? "claimed" : "refunded";
        const at = new Date(Number((await this.chain.pub.getBlock({ blockNumber: log.blockNumber! })).timestamp) * 1000);
        const upd =
          ev.eventName === "Claimed"
            ? await c.query(`UPDATE payout_rows SET status=$2, claimed_at=$3, claimed_to=$4, settle_tx=$5 WHERE deposit_id=$1 RETURNING payout_id`, [ev.args.id, status, at, ev.args.recipient, log.transactionHash])
            : await c.query(`UPDATE payout_rows SET status=$2, refunded_at=$3, refund_by_expiry=$4, settle_tx=$5 WHERE deposit_id=$1 RETURNING payout_id`, [ev.args.id, status, at, ev.args.byExpiry, log.transactionHash]);
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
        WHERE r.payout_id=$1 AND r.status IN ('in_escrow','claimed','refunded') AND NOT r.rekey_pending`,
      [payoutId],
    );
    for (const r of rows) {
      const key = this.vault.open(r);
      const link = formatClaimLink(this.cfg.claimBaseUrl, { chainId: org.chain_id, escrow: org.escrow, depositId: r.deposit_id, key });
      await tx(this.db, async (c) => {
        // one email per claim key: a re-issued link (rekey) is a new key and a new email
        const ins = await c.query(`INSERT INTO emails (row_id, kind) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [r.id, `claim:${r.claim_signer}`]);
        if (ins.rowCount && r.status === "in_escrow") {
          await this.mailer.send({
            to: r.email,
            subject: `${this.cfg.senderDisplayName(org.name)}: ${r.claim_signer && (await c.query(`SELECT count(*) FROM emails WHERE row_id=$1`, [r.id])).rows[0].count > 1 ? "a new link to your payment" : "you have been sent a payment"}`,
            text: `Hello ${r.name},\n\n${org.name} has sent you a payment. To receive the money, open this link:\n${link}\n\nThe link is the only key to the payment. Do not forward it to anyone.`,
          });
        }
        await c.query(`DELETE FROM claim_keys WHERE row_id=$1`, [r.id]);
      });
    }
  }

  /**
   * Keeper: permissionless refundExpired for due deposits. Anyone could do it; we do it for convenience.
   * "Due" is judged by chain time, as the escrow judges it (block.timestamp), not by this server's clock.
   */
  async runKeeper(orgId: string, now?: Date) {
    now ??= new Date(Number((await this.chain.pub.getBlock({ blockTag: "latest" })).timestamp) * 1000);
    const org = await this.org(orgId);
    const { rows } = await this.db.query(
      `SELECT r.deposit_id FROM payout_rows r JOIN payouts p ON p.id=r.payout_id
        WHERE p.org_id=$1 AND r.status='in_escrow' AND r.auto_refund_at IS NOT NULL AND r.auto_refund_at <= $2`,
      [orgId, now],
    );
    let refunded = 0;
    for (const r of rows) {
      // refundExpired is permissionless: someone else may have refunded (or the recipient claimed) since the query.
      // One such deposit must not stop the rest; the indexer below records what actually happened.
      try {
        await this.chain.waitTx(await this.chain.refundExpired(org.escrow, r.deposit_id));
        refunded++;
      } catch (e) {
        console.warn(`keeper: deposit ${r.deposit_id} not refunded: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message}`);
      }
    }
    await this.pollEscrow(orgId);
    return { refunded };
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
      payout: { id: p.id, title: p.title, status: p.status, closedAt: p.closed_at, orgId: p.org_id, chainId: (await this.org(p.org_id)).chain_id },
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
        document: documentLabel(r.doc_required, r.doc_status),
      })),
    };
  }

  async listPayouts(orgId: string) {
    return (
      await this.db.query(
        `SELECT p.id, p.title, p.status, p.created_at, count(r.*)::int AS rows, coalesce(sum(r.amount),0)::text AS total
           FROM payouts p LEFT JOIN payout_rows r ON r.payout_id=p.id WHERE p.org_id=$1 GROUP BY p.id ORDER BY p.created_at DESC`,
        [orgId],
      )
    ).rows;
  }

  async balance(orgId: string) {
    const org = await this.org(orgId);
    const [token, eth] = await Promise.all([
      this.chain.pub.readContract({
        address: org.token,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "balanceOf",
        args: [org.account],
      }) as Promise<bigint>,
      this.chain.pub.getBalance({ address: org.account }),
    ]);
    const reserved = await this.db.query(
      `SELECT coalesce(sum(r.amount),0)::text AS s FROM payout_rows r JOIN payouts p ON p.id=r.payout_id WHERE p.org_id=$1 AND r.status='in_escrow'`,
      [orgId],
    );
    // unclaimed escrow is the sender's money, reserved — not spent.
    return { account: org.account, token: org.token, balance: token, reservedInEscrow: BigInt(reserved.rows[0].s), gasBalance: eth };
  }

  /**
   * approvers learn what is waiting and what left. "pending" — a batch needs signatures; "sent" — executed.
   */
  async notifyApprovers(batchId: string, kind: "pending" | "sent") {
    const { batch, org } = await this.batchCtx(batchId);
    const m = manifestFromJson(batch.manifest);
    const total = m.rows.reduce((s, r) => (r.kind === "refund" ? s : s + r.amount + (r.kind === "escrow" ? r.tip : 0n)), 0n);
    const amount = `${(Number(total) / 10 ** this.cfg.tokenDecimals).toLocaleString("en-US")} USDC`;
    const emails = (await this.db.query(`SELECT email FROM org_members WHERE org_id=$1 AND 'approver' = ANY(roles) AND status<>'removed'`, [org.id])).rows;
    for (const e of emails) {
      await this.mailer.send(
        kind === "pending"
          ? {
              to: e.email,
              subject:
                batch.kind === "revoke"
                  ? `${org.name}: revoking ${m.rows.length} unclaimed payment(s) is waiting for your approval`
                  : batch.kind === "rekey"
                    ? `${org.name}: new links for ${m.rows.length} payment(s) are waiting for your approval`
                    : `${org.name}: a payout is waiting for your approval — ${amount}`,
              text: batch.kind === "revoke"
                ? `An operator asks to revoke unclaimed payments (${m.rows.length}). The money returns to the organization account.
Open: ${this.cfg.appUrl}#/approve/${batchId}`
                : batch.kind === "rekey"
                  ? `An operator asks to send new links for unclaimed payments (${m.rows.length}). The old links will stop working.
Open: ${this.cfg.appUrl}#/approve/${batchId}`
                  : `${amount} will leave the organization account ${org.account} to ${m.rows.length} recipients.
Review and approve: ${this.cfg.appUrl}#/approve/${batchId}`,
            }
          : {
              to: e.email,
              subject:
                batch.kind === "revoke"
                  ? `${org.name}: ${m.rows.length} unclaimed payment(s) returned to the account`
                  : batch.kind === "rekey"
                    ? `${org.name}: new links sent for ${m.rows.length} payment(s)`
                    : `${org.name}: ${amount} left the account`,
              text: `The batch was executed. Transaction ${batch.tx_hash}. Receipt: ${this.cfg.appUrl}#/payout/${m.payoutId}`,
            },
      );
    }
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

  /** Batches with who has signed each: the operator sees whom the payout is waiting for. */
  async batchesOf(payoutId: string) {
    const batches = (
      await this.db.query(
        `SELECT b.id, b.batch_no, b.kind, b.status, b.approve_hash, b.tx_hash, b.created_at, (SELECT u.email FROM users u WHERE u.did=b.requested_by) AS requested_by
           FROM batches b WHERE b.payout_id=$1 ORDER BY b.batch_no`,
        [payoutId],
      )
    ).rows;
    if (!batches.length) return batches;
    const orgId = (await this.db.query(`SELECT org_id FROM payouts WHERE id=$1`, [payoutId])).rows[0].org_id;
    const threshold = Number((await this.db.query(`SELECT threshold FROM orgs WHERE id=$1`, [orgId])).rows[0].threshold);
    const approvers = (
      await this.db.query(
        `SELECT a.address, a.weight, (SELECT u.email FROM users u WHERE lower(u.wallet)=lower(a.address) LIMIT 1) AS email FROM approvers a WHERE a.org_id=$1 ORDER BY a.address`,
        [orgId],
      )
    ).rows as { address: Address; weight: number; email: string | null }[];
    const signed = (await this.db.query(`SELECT batch_id, approver, created_at FROM approvals WHERE batch_id = ANY($1)`, [batches.map((b) => b.id)])).rows as { batch_id: string; approver: string; created_at: Date }[];
    return batches.map((b) => {
      const mine = new Map(signed.filter((s) => s.batch_id === b.id).map((s) => [s.approver.toLowerCase(), s.created_at]));
      const signers = approvers.map((a) => ({ ...a, signed: mine.has(a.address.toLowerCase()), signedAt: mine.get(a.address.toLowerCase()) ?? null }));
      return { ...b, threshold, signedWeight: signers.filter((s) => s.signed).reduce((x, s) => x + s.weight, 0), signers };
    });
  }

  /** Batches waiting for this approver's signature, across every organisation they approve for. */
  async pendingFor(wallet: Address) {
    const { rows } = await this.db.query(
      `SELECT b.id, b.kind, b.batch_no, b.manifest, b.created_at, p.id AS payout_id, p.title, o.id AS org_id, o.name AS org, o.threshold
         FROM batches b JOIN payouts p ON p.id=b.payout_id JOIN orgs o ON o.id=p.org_id
         JOIN approvers a ON a.org_id=o.id AND lower(a.address)=lower($1)
        WHERE b.status='collecting'
          AND NOT EXISTS (SELECT 1 FROM approvals x WHERE x.batch_id=b.id AND lower(x.approver)=lower($1))
        ORDER BY b.created_at`,
      [wallet],
    );
    return rows.map((r) => {
      const m = manifestFromJson(r.manifest);
      const paying = m.rows.filter((x) => x.kind === "transfer" || x.kind === "escrow");
      return { batchId: r.id, kind: r.kind, payoutId: r.payout_id, title: r.title, orgId: r.org_id, org: r.org, rows: m.rows.length, total: paying.reduce((s, x) => s + x.amount, 0n).toString(), createdAt: r.created_at };
    });
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
  doc_required: string;
  doc_status: string;
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
