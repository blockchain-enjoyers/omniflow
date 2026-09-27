import { getAddress, isAddress, parseUnits, type Address } from "viem";
import type { PayoutRow } from "@omniflow/shared";
import type { Db } from "../db/db.js";
import type { Mailer } from "../mail/mailer.js";
import { HttpError, type PayoutService } from "./service.js";

export interface BookEntry {
  id?: string;
  name: string;
  email?: string | null;
  address?: string | null;
  chainId: number;
  category?: string | null;
}

/** Inputs besides CSV: address book, repeat with edits, recurring payouts. */
export class ListService {
  constructor(private readonly db: Db, private readonly payouts: PayoutService, private readonly mailer: Mailer, private readonly appUrl: string, private readonly decimals: number) {}

  // ---------------------------------------------------------------- book

  async book(orgId: string) {
    return (await this.db.query(`SELECT id, name, email, address, chain_id AS "chainId", category, last_amount::text AS "lastAmount", updated_at FROM address_book WHERE org_id=$1 ORDER BY name`, [orgId])).rows;
  }

  async upsertEntry(orgId: string, e: BookEntry) {
    if (!e.name?.trim()) throw new HttpError(400, "name is required");
    if (e.address && !isAddress(e.address)) throw new HttpError(400, "invalid address");
    const { rows } = await this.db.query(
      `INSERT INTO address_book (org_id, name, email, address, chain_id, category) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id, name) DO UPDATE SET email=EXCLUDED.email, address=EXCLUDED.address, chain_id=EXCLUDED.chain_id, category=EXCLUDED.category, updated_at=now()
       RETURNING id`,
      [orgId, e.name.trim(), e.email?.trim().toLowerCase() || null, e.address ? getAddress(e.address) : null, e.chainId, e.category ?? null],
    );
    return rows[0];
  }

  async deleteEntry(orgId: string, id: string) {
    await this.db.query(`DELETE FROM address_book WHERE org_id=$1 AND id=$2`, [orgId, id]);
  }

  /** Called after a batch settles: paid recipients are remembered with their last amount. */
  async rememberPaid(payoutId: string) {
    await this.db.query(
      `INSERT INTO address_book (org_id, name, email, address, chain_id, category, last_amount)
       SELECT p.org_id, r.name, r.email, r.address, r.chain_id, r.category, r.amount FROM payout_rows r JOIN payouts p ON p.id=r.payout_id
        WHERE r.payout_id=$1 AND r.status IN ('sent','in_escrow','claimed')
       ON CONFLICT (org_id, name) DO UPDATE SET
         email=COALESCE(EXCLUDED.email, address_book.email), address=COALESCE(EXCLUDED.address, address_book.address),
         chain_id=EXCLUDED.chain_id, category=COALESCE(EXCLUDED.category, address_book.category), last_amount=EXCLUDED.last_amount, updated_at=now()`,
      [payoutId],
    );
  }

  /** A payout from chosen address-book entries with amounts (in token units, e.g. "1500.5"). */
  async payoutFromBook(orgId: string, input: { title: string; items: { id: string; amount: string }[]; autoRefundDays?: number | null }) {
    const book = await this.book(orgId);
    const rows: PayoutRow[] = input.items.map((it, i) => {
      const e = book.find((b) => b.id === it.id);
      if (!e) throw new HttpError(400, `address book entry ${it.id} not found`);
      return { rowId: `row-${i + 2}`, name: e.name, email: e.email ?? undefined, address: e.address ? (getAddress(e.address) as Address) : undefined, chainId: e.chainId, amount: parseUnits(it.amount, this.decimals), category: e.category ?? undefined };
    });
    return this.payouts.createPayoutFromRows(orgId, { title: input.title, rows, autoRefundDays: input.autoRefundDays, source: "address_book" });
  }

  // -------------------------------------------------- repeat and editing

  /** Repeat a past payout: same people and amounts, as a new draft to edit before freezing. */
  async repeat(payoutId: string, title?: string, scheduleId?: string) {
    const { rows: [p] } = await this.db.query(`SELECT * FROM payouts WHERE id=$1`, [payoutId]);
    if (!p) throw new HttpError(404, "payout not found");
    const src = (await this.db.query(`SELECT * FROM payout_rows WHERE payout_id=$1 ORDER BY row_key`, [payoutId])).rows;
    const rows: PayoutRow[] = src.map((r, i) => ({ rowId: `row-${i + 2}`, name: r.name, email: r.email ?? undefined, address: r.address ?? undefined, chainId: r.chain_id, amount: BigInt(r.amount), category: r.category ?? undefined }));
    return this.payouts.createPayoutFromRows(p.org_id, { title: title ?? `${p.title} (repeat)`, rows, autoRefundDays: p.auto_refund_days, source: "repeat", scheduleId });
  }

  /** Edit a row while it is not in a batch yet. After freezing, a row can no longer change. */
  async editRow(payoutId: string, rowKey: string, e: { amount?: string; address?: string | null; email?: string | null; remove?: boolean }) {
    const { rows: [r] } = await this.db.query(`SELECT r.*, o.chain_id AS org_chain FROM payout_rows r JOIN payouts p ON p.id=r.payout_id JOIN orgs o ON o.id=p.org_id WHERE r.payout_id=$1 AND r.row_key=$2`, [payoutId, rowKey]);
    if (!r) throw new HttpError(404, "row not found");
    if (!["ready", "waiting_details", "other_chain"].includes(r.status)) throw new HttpError(409, `row is ${r.status} — it can no longer be edited`);
    if (e.remove) {
      await this.db.query(`DELETE FROM detail_forms WHERE row_id=$1`, [r.id]);
      await this.db.query(`DELETE FROM payout_rows WHERE id=$1`, [r.id]);
      return { removed: true };
    }
    if (e.address && !isAddress(e.address)) throw new HttpError(400, "invalid address");
    const amount = e.amount !== undefined ? parseUnits(e.amount, this.decimals) : BigInt(r.amount);
    if (amount <= 0n) throw new HttpError(400, "amount must be positive");
    const address = e.address === undefined ? r.address : e.address ? getAddress(e.address) : null;
    const email = e.email === undefined ? r.email : e.email?.toLowerCase() || null;
    const status = r.chain_id !== r.org_chain ? "other_chain" : !address && !email ? "waiting_details" : "ready";
    await this.db.query(`UPDATE payout_rows SET amount=$2, address=$3, email=$4, status=$5 WHERE id=$1`, [r.id, amount.toString(), address, email, status]);
    return { status };
  }

  async addRow(payoutId: string, row: { name: string; email?: string; address?: string; chainId: number; amount: string; category?: string }) {
    const { rows: [p] } = await this.db.query(`SELECT p.id, o.chain_id FROM payouts p JOIN orgs o ON o.id=p.org_id WHERE p.id=$1 AND p.status<>'closed'`, [payoutId]);
    if (!p) throw new HttpError(409, "payout not found or closed");
    if (row.address && !isAddress(row.address)) throw new HttpError(400, "invalid address");
    const n = Number((await this.db.query(`SELECT count(*) FROM payout_rows WHERE payout_id=$1`, [payoutId])).rows[0].count);
    const status = row.chainId !== p.chain_id ? "other_chain" : !row.address && !row.email ? "waiting_details" : "ready";
    await this.db.query(
      `INSERT INTO payout_rows (payout_id, row_key, name, email, address, chain_id, amount, status, category, details_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual')`,
      [payoutId, `row-${n + 2}-m`, row.name, row.email?.toLowerCase() ?? null, row.address ? getAddress(row.address) : null, row.chainId, parseUnits(row.amount, this.decimals).toString(), status, row.category ?? null],
    );
  }

  // ------------------------------------------------------------ recurring

  async schedules(orgId: string) {
    return (await this.db.query(`SELECT id, title, template_payout_id AS "templatePayoutId", every, next_run_at AS "nextRunAt", active FROM schedules WHERE org_id=$1 ORDER BY created_at`, [orgId])).rows;
  }

  async createSchedule(orgId: string, actor: string, s: { title: string; templatePayoutId: string; every: "week" | "month"; firstRunAt: string }) {
    const { rows } = await this.db.query(`SELECT org_id FROM payouts WHERE id=$1`, [s.templatePayoutId]);
    if (rows[0]?.org_id !== orgId) throw new HttpError(400, "template payout belongs to another organisation");
    if (!["week", "month"].includes(s.every)) throw new HttpError(400, "every must be week or month");
    const r = await this.db.query(
      `INSERT INTO schedules (org_id, title, template_payout_id, every, next_run_at, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [orgId, s.title, s.templatePayoutId, s.every, new Date(s.firstRunAt), actor],
    );
    return r.rows[0];
  }

  async setScheduleActive(orgId: string, id: string, active: boolean) {
    await this.db.query(`UPDATE schedules SET active=$3 WHERE org_id=$1 AND id=$2`, [orgId, id, active]);
  }

  /** Scheduler pass: due schedules create a draft and tell the operators. Nothing is sent without approval. */
  async runSchedules(now = new Date()) {
    const due = (await this.db.query(`SELECT * FROM schedules WHERE active AND next_run_at <= $1`, [now])).rows;
    const created: string[] = [];
    for (const s of due) {
      const next = new Date(s.next_run_at);
      if (s.every === "week") next.setUTCDate(next.getUTCDate() + 7);
      else next.setUTCMonth(next.getUTCMonth() + 1);
      // advance first: a crash after this line skips a run rather than creating it twice
      const adv = await this.db.query(`UPDATE schedules SET next_run_at=$2 WHERE id=$1 AND next_run_at=$3`, [s.id, next, s.next_run_at]);
      if (!adv.rowCount) continue;
      const stamp = new Date(s.next_run_at).toISOString().slice(0, 10);
      const p = await this.repeat(s.template_payout_id, `${s.title} — ${stamp}`, s.id);
      created.push(p.id);
      const ops = (await this.db.query(`SELECT m.email, o.name FROM org_members m JOIN orgs o ON o.id=m.org_id WHERE m.org_id=$1 AND 'operator'=ANY(m.roles) AND m.status<>'removed'`, [s.org_id])).rows;
      for (const o of ops) {
        await this.mailer.send({ to: o.email, subject: `${o.name}: the recurring payout "${s.title}" has a draft ready for review`, text: `A scheduled draft was created. Review it and send it for approval: ${this.appUrl}#/payout/${p.id}` });
      }
    }
    return created;
  }
}
