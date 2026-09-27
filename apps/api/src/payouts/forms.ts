import { createHash, randomBytes } from "node:crypto";
import { getAddress, isAddress } from "viem";
import type { Db } from "../db/db.js";
import type { Mailer } from "../mail/mailer.js";
import { HttpError } from "./service.js";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/**
 * the recipient fills in their own details. this link is NOT the claim link — it collects details
 * before sending; money never moves through it. A filled row still goes through review and N-of-M approval.
 */
export class FormService {
  constructor(private readonly db: Db, private readonly mailer: Mailer, private readonly formBaseUrl: string) {}

  /** Creates links for rows without an address (waiting or email-only). Emails them where an email is known. */
  async createLinks(payoutId: string, rowKeys?: string[]) {
    const { rows } = await this.db.query(
      `SELECT r.id, r.row_key, r.name, r.email, o.name AS org FROM payout_rows r JOIN payouts p ON p.id=r.payout_id JOIN orgs o ON o.id=p.org_id
        WHERE r.payout_id=$1 AND r.address IS NULL AND r.status IN ('waiting_details','ready')`,
      [payoutId],
    );
    const out: { row: string; name: string; link: string; emailed: boolean }[] = [];
    for (const r of rows.filter((x) => !rowKeys || rowKeys.includes(x.row_key))) {
      const token = randomBytes(24).toString("base64url");
      await this.db.query(`INSERT INTO detail_forms (row_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 days')`, [r.id, hash(token)]);
      const link = `${this.formBaseUrl}#/form/${token}`;
      if (r.email) {
        await this.mailer.send({
          to: r.email,
          subject: `${r.org} via Omniflow: tell us where to pay you`,
          text: `${r.org} is about to send you a payout. Enter your wallet address (or leave your email — then you will receive a claim link):\n${link}\n\nThis is not a payment and not a link to receive money.`,
        });
      }
      out.push({ row: r.row_key, name: r.name, link, emailed: Boolean(r.email) });
    }
    return out;
  }

  private async byToken(token: string) {
    const { rows } = await this.db.query(
      `SELECT f.id AS form_id, f.expires_at, f.filled_at, r.id AS row_id, r.name, r.amount, r.chain_id, r.status, r.email, o.name AS org, o.chain_id AS org_chain
         FROM detail_forms f JOIN payout_rows r ON r.id=f.row_id JOIN payouts p ON p.id=r.payout_id JOIN orgs o ON o.id=p.org_id
        WHERE f.token_hash=$1`,
      [hash(token)],
    );
    const f = rows[0];
    if (!f || new Date(f.expires_at) < new Date()) throw new HttpError(404, "link not found or expired");
    return f;
  }

  /** Public view: only what the recipient needs to recognise the payment. */
  async view(token: string) {
    const f = await this.byToken(token);
    return { org: f.org, name: f.name, amount: f.amount, chainId: f.org_chain, filled: Boolean(f.filled_at), locked: !["waiting_details", "ready"].includes(f.status) };
  }

  async submit(token: string, input: { address?: string; email?: string; chainId?: number }) {
    const f = await this.byToken(token);
    if (!["waiting_details", "ready"].includes(f.status)) throw new HttpError(409, "this payment is already being processed — details can no longer be changed");
    const address = input.address?.trim() || null;
    const email = input.email?.trim().toLowerCase() || null;
    if (!address && !email) throw new HttpError(400, "an address or an email is required");
    if (address && !isAddress(address)) throw new HttpError(400, "invalid address");
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "invalid email");
    const chainId = input.chainId ?? f.org_chain;
    const status = chainId !== f.org_chain ? "other_chain" : "ready";
    await this.db.query(
      `UPDATE payout_rows SET address=COALESCE($2, address), email=COALESCE($3, email), chain_id=$4, status=$5, details_source='form' WHERE id=$1`,
      [f.row_id, address ? getAddress(address) : null, email, chainId, status],
    );
    await this.db.query(`UPDATE detail_forms SET filled_at=now() WHERE id=$1`, [f.form_id]);
    return { status };
  }
}
