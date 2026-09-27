import { keccak256, recoverTypedDataAddress, getAddress, toHex, type Address, type Hex } from "viem";
import { kernelInitData, setupConfirmationTypedData, type ApproverSet } from "@omniflow/shared";
import { tx, type Db } from "../db/db.js";
import type { ChainClient } from "../chain/chain.js";
import type { AuthUser } from "../auth/privy.js";
import type { Mailer } from "../mail/mailer.js";
import { HttpError } from "../payouts/service.js";

export type Role = "admin" | "operator" | "approver";

export interface OrgDeployment {
  chainId: number;
  factory: Address;
  validator: Address;
  escrow: Address;
  token: Address;
  appUrl: string;
}

export class OrgService {
  constructor(
    private readonly db: Db,
    private readonly chain: ChainClient,
    private readonly mailer: Mailer,
    private readonly dep: OrgDeployment,
  ) {}

  // ------------------------------------------------------------------ users

  async upsertUser(u: AuthUser) {
    await this.db.query(
      `INSERT INTO users (did, email, wallet) VALUES ($1,$2,$3)
       ON CONFLICT (did) DO UPDATE SET email=COALESCE(EXCLUDED.email, users.email), wallet=COALESCE(EXCLUDED.wallet, users.wallet), updated_at=now()`,
      [u.did, u.email, u.wallet],
    );
    // An invited email becomes active on first login with that verified email.
    if (u.email) await this.db.query(`UPDATE org_members SET did=$1, status='active' WHERE email=$2 AND status='invited'`, [u.did, u.email]);
  }

  async me(u: AuthUser) {
    const orgs = await this.db.query(
      `SELECT o.id, o.name, o.account, o.chain_id, m.roles FROM org_members m JOIN orgs o ON o.id=m.org_id
        WHERE m.did=$1 AND m.status='active' ORDER BY o.created_at`,
      [u.did],
    );
    const setups = await this.db.query(
      `SELECT s.id, s.name, s.status, a.wallet IS NOT NULL AS joined, a.confirmation IS NOT NULL AS confirmed
         FROM org_setup_approvers a JOIN org_setups s ON s.id=a.setup_id
        WHERE a.email=$1 AND s.status IN ('collecting','confirming')
       UNION
       SELECT s.id, s.name, s.status, NULL, NULL FROM org_setups s WHERE s.created_by=$2 AND s.status IN ('collecting','confirming')`,
      [u.email, u.did],
    );
    return { user: u, orgs: orgs.rows, setups: setups.rows };
  }

  // ------------------------------------------------------------- authz

  async requireRole(orgId: string, u: AuthUser, roles: Role[]) {
    const { rows } = await this.db.query(`SELECT roles FROM org_members WHERE org_id=$1 AND did=$2 AND status='active'`, [orgId, u.did]);
    const have: string[] = rows[0]?.roles ?? [];
    if (!have.some((r) => roles.includes(r as Role))) throw new HttpError(403, `requires role: ${roles.join(" or ")}`);
    return have as Role[];
  }

  async orgOfPayout(payoutId: string): Promise<string> {
    const { rows } = await this.db.query(`SELECT org_id FROM payouts WHERE id=$1`, [payoutId]);
    if (!rows[0]) throw new HttpError(404, "payout not found");
    return rows[0].org_id;
  }

  async orgOfBatch(batchId: string): Promise<string> {
    const { rows } = await this.db.query(`SELECT p.org_id FROM batches b JOIN payouts p ON p.id=b.payout_id WHERE b.id=$1`, [batchId]);
    if (!rows[0]) throw new HttpError(404, "batch not found");
    return rows[0].org_id;
  }

  async audit(orgId: string | null, actor: string | null, action: string, details: unknown = null) {
    await this.db.query(`INSERT INTO audit_log (org_id, actor, action, details) VALUES ($1,$2,$3,$4)`, [orgId, actor, action, details === null ? null : JSON.stringify(details)]);
  }

  async auditLog(orgId: string) {
    return (await this.db.query(`SELECT a.at, a.action, a.details, u.email AS actor FROM audit_log a LEFT JOIN users u ON u.did=a.actor WHERE a.org_id=$1 ORDER BY a.id DESC LIMIT 200`, [orgId])).rows;
  }

  // ------------------------------------------------------ flow 1: setup

  /** The creator names the approvers by email; each will log in, which yields their embedded-wallet address. */
  async startSetup(u: AuthUser, input: { name: string; threshold: number; approvers: { email: string; weight: number }[]; operators?: string[]; autoRefundDays?: number | null }) {
    if (!u.email) throw new HttpError(400, "identity token with email required");
    const approvers = input.approvers.map((a) => ({ email: a.email.trim().toLowerCase(), weight: a.weight }));
    const total = approvers.reduce((s, a) => s + a.weight, 0);
    if (!approvers.length || input.threshold < 1 || input.threshold > total) throw new HttpError(400, "threshold must be between 1 and the total weight");
    if (new Set(approvers.map((a) => a.email)).size !== approvers.length) throw new HttpError(400, "duplicate approver email");
    const id = await tx(this.db, async (c) => {
      const salt = keccak256(toHex(`omniflow-setup-${crypto.randomUUID()}`));
      const s = await c.query(
        `INSERT INTO org_setups (name, chain_id, threshold, salt, created_by, creator_email, operators, auto_refund_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [input.name, this.dep.chainId, input.threshold, salt, u.did, u.email, (input.operators ?? []).map((e) => e.trim().toLowerCase()), input.autoRefundDays ?? null],
      );
      for (const a of approvers) await c.query(`INSERT INTO org_setup_approvers (setup_id, email, weight) VALUES ($1,$2,$3)`, [s.rows[0].id, a.email, a.weight]);
      return s.rows[0].id as string;
    });
    for (const a of approvers) {
      await this.mailer.send({
        to: a.email,
        subject: `${input.name}: you have been named a payout approver`,
        text: `${u.email} is creating the organization account "${input.name}" in Omniflow and named you an approver.\nSign in with this email and confirm the set of approvers: ${this.dep.appUrl}#/setup/${id}\n\nNo one but the approvers will be able to send money from this account.`,
      });
    }
    await this.audit(null, u.did, "setup.started", { setupId: id, name: input.name });
    return this.setup(id);
  }

  async setup(id: string) {
    const { rows } = await this.db.query(`SELECT * FROM org_setups WHERE id=$1`, [id]);
    if (!rows[0]) throw new HttpError(404, "setup not found");
    const approvers = (await this.db.query(`SELECT email, weight, wallet, confirmation IS NOT NULL AS confirmed FROM org_setup_approvers WHERE setup_id=$1 ORDER BY email`, [id])).rows;
    const s = rows[0];
    const set: ApproverSet | null = approvers.every((a) => a.wallet) ? { threshold: s.threshold, approvers: approvers.map((a) => ({ address: a.wallet, weight: a.weight })) } : null;
    return {
      id: s.id as string,
      name: s.name as string,
      chainId: s.chain_id as number,
      status: s.status as string,
      threshold: s.threshold as number,
      account: s.account as Address | null,
      orgId: s.org_id as string | null,
      approvers,
      typedData: set && s.account ? setupConfirmationTypedData(s.chain_id, s.account, set, s.name) : null,
    };
  }

  /** An approver joins: their embedded-wallet address comes from the verified identity token. */
  async joinSetup(id: string, u: AuthUser) {
    if (!u.email || !u.wallet) throw new HttpError(400, "identity token with email and embedded wallet required");
    const upd = await this.db.query(
      `UPDATE org_setup_approvers a SET wallet=$3 FROM org_setups s
        WHERE a.setup_id=$1 AND a.email=$2 AND s.id=a.setup_id AND s.status='collecting' RETURNING a.email`,
      [id, u.email, u.wallet],
    );
    if (!upd.rowCount) throw new HttpError(403, "you are not an approver of this setup, or it is no longer collecting");
    await this.audit(null, u.did, "setup.joined", { setupId: id, wallet: u.wallet });
    await this.maybeComputeAccount(id);
    return this.setup(id);
  }

  /** When every approver has a wallet: the counterfactual address from the factory (what everyone confirms). */
  private async maybeComputeAccount(id: string) {
    const s = await this.setup(id);
    if (s.status !== "collecting" || s.approvers.some((a) => !a.wallet)) return;
    const { rows } = await this.db.query(`SELECT salt FROM org_setups WHERE id=$1`, [id]);
    const initData = kernelInitData(this.dep.validator, { threshold: s.threshold, approvers: s.approvers.map((a) => ({ address: a.wallet, weight: a.weight })) });
    const account = await this.chain.accountAddress(this.dep.factory, initData, rows[0].salt);
    await this.db.query(`UPDATE org_setups SET account=$2, status='confirming' WHERE id=$1 AND status='collecting'`, [id, account]);
  }

  /** Each approver signs the full set and the account address; the signature must come from their wallet. */
  async confirmSetup(id: string, u: AuthUser, signature: Hex) {
    const s = await this.setup(id);
    if (s.status !== "confirming" || !s.typedData) throw new HttpError(409, `setup is ${s.status}`);
    const signer = getAddress(await recoverTypedDataAddress({ ...s.typedData, signature }));
    const me = s.approvers.find((a) => a.email === u.email);
    if (!me || getAddress(me.wallet) !== signer) throw new HttpError(403, "signature must come from your own wallet in this set");
    await this.db.query(`UPDATE org_setup_approvers SET confirmation=$3 WHERE setup_id=$1 AND email=$2`, [id, u.email, signature]);
    await this.audit(null, u.did, "setup.confirmed", { setupId: id });
    const after = await this.setup(id);
    if (after.approvers.every((a) => a.confirmed)) await this.deploy(id);
    return this.setup(id);
  }

  /** Deploys the account (permissionless factory call, gas by the submitter), then registers the organisation. */
  private async deploy(id: string) {
    const s = await this.setup(id);
    const { rows } = await this.db.query(`SELECT * FROM org_setups WHERE id=$1`, [id]);
    const row = rows[0];
    const set = { threshold: s.threshold, approvers: s.approvers.map((a) => ({ address: getAddress(a.wallet), weight: a.weight })) };
    await this.chain.deployAccount(this.dep.factory, kernelInitData(this.dep.validator, set), row.salt);
    const org = await this.importOrg({
      name: s.name,
      account: s.account!,
      validator: this.dep.validator,
      escrow: this.dep.escrow,
      token: this.dep.token,
      approvers: set.approvers,
      autoRefundDays: row.auto_refund_days,
    });
    await tx(this.db, async (c) => {
      const add = (email: string, roles: Role[]) =>
        c.query(
          `INSERT INTO org_members (org_id, email, roles) VALUES ($1,$2,$3)
           ON CONFLICT (org_id, email) DO UPDATE SET roles = (SELECT array_agg(DISTINCT r) FROM unnest(org_members.roles || EXCLUDED.roles) r)`,
          [org.id, email, roles],
        );
      await add(row.creator_email, ["admin", "operator"]);
      for (const a of s.approvers) await add(a.email, ["approver"]);
      for (const e of row.operators as string[]) await add(e, ["operator"]);
      await c.query(`UPDATE org_members m SET did=u.did, status='active' FROM users u WHERE m.org_id=$1 AND u.email=m.email`, [org.id]);
      await c.query(`UPDATE org_setups SET status='deployed', org_id=$2 WHERE id=$1`, [id, org.id]);
    });
    await this.audit(org.id, row.created_by, "org.deployed", { account: s.account, setupId: id });
  }

  /**
   * Registers an existing account only if its approver set matches the validator on chain.
   * Used by the setup flow after deployment and for importing an account created elsewhere.
   */
  async importOrg(input: { name: string; account: Address; validator: Address; escrow: Address; token: Address; approvers: { address: Address; weight: number }[]; autoRefundDays?: number | null }) {
    const onChain = await this.chain.readApprovers(input.validator, input.account, input.approvers.map((a) => a.address));
    if (onChain.threshold === 0) throw new HttpError(400, "account has no weighted validator installed");
    for (const a of input.approvers) {
      const w = onChain.weights.find((x) => x.address === a.address)?.weight ?? 0;
      if (w !== a.weight) throw new HttpError(400, `approver ${a.address}: weight ${a.weight} differs from chain (${w})`);
    }
    // Start indexing from now, not from genesis (an unbounded log scan on a live chain).
    const head = await this.chain.blockNumber();
    return tx(this.db, async (c) => {
      await c.query(`INSERT INTO indexer_cursor (chain_id, last_block) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [this.chain.cfg.chainId, head.toString()]);
      const { rows } = await c.query(
        `INSERT INTO orgs (name, chain_id, account, validator, escrow, token, threshold, auto_refund_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [input.name, this.chain.cfg.chainId, getAddress(input.account), getAddress(input.validator), getAddress(input.escrow), getAddress(input.token), onChain.threshold, input.autoRefundDays ?? null],
      );
      for (const a of input.approvers) await c.query(`INSERT INTO approvers (org_id, address, weight) VALUES ($1,$2,$3)`, [rows[0].id, getAddress(a.address), a.weight]);
      return { id: rows[0].id as string, threshold: onChain.threshold };
    });
  }

  // ------------------------------------------------------- members, settings

  async addMember(orgId: string, email: string, roles: Role[]) {
    const e = email.trim().toLowerCase();
    await this.db.query(
      `INSERT INTO org_members (org_id, email, roles) VALUES ($1,$2,$3)
       ON CONFLICT (org_id, email) DO UPDATE SET roles = (SELECT array_agg(DISTINCT r) FROM unnest(org_members.roles || EXCLUDED.roles) r)`,
      [orgId, e, roles],
    );
    await this.db.query(`UPDATE org_members m SET did=u.did, status='active' FROM users u WHERE m.org_id=$1 AND m.email=$2 AND u.email=$2`, [orgId, e]);
  }

  async members(orgId: string) {
    return (await this.db.query(`SELECT email, roles, status, did IS NOT NULL AS joined FROM org_members WHERE org_id=$1 AND status<>'removed' ORDER BY email`, [orgId])).rows;
  }

  /** Admins invite operators (role A). Approvers are fixed by the on-chain set — changing them is renew() via N-of-M. */
  async inviteOperator(orgId: string, u: AuthUser, email: string) {
    const e = email.trim().toLowerCase();
    await this.db.query(
      `INSERT INTO org_members (org_id, email, roles) VALUES ($1,$2,ARRAY['operator'])
       ON CONFLICT (org_id, email) DO UPDATE SET roles = (SELECT array_agg(DISTINCT r) FROM unnest(org_members.roles || ARRAY['operator']) r), status = CASE WHEN org_members.status='removed' THEN 'invited' ELSE org_members.status END`,
      [orgId, e],
    );
    await this.db.query(`UPDATE org_members m SET did=u.did, status='active' FROM users u WHERE m.org_id=$1 AND m.email=$2 AND u.email=$2`, [orgId, e]);
    const org = (await this.db.query(`SELECT name FROM orgs WHERE id=$1`, [orgId])).rows[0];
    await this.mailer.send({ to: e, subject: `${org.name}: invitation to Omniflow`, text: `You have been invited as a payout operator of "${org.name}". Sign in with this email: ${this.dep.appUrl}` });
    await this.audit(orgId, u.did, "member.invited", { email: e, role: "operator" });
  }

  async removeOperator(orgId: string, u: AuthUser, email: string) {
    await this.db.query(`UPDATE org_members SET roles = array_remove(roles, 'operator') WHERE org_id=$1 AND email=$2`, [orgId, email.toLowerCase()]);
    await this.db.query(`UPDATE org_members SET status='removed' WHERE org_id=$1 AND email=$2 AND cardinality(roles)=0`, [orgId, email.toLowerCase()]);
    await this.audit(orgId, u.did, "member.removed", { email });
  }

  async settings(orgId: string) {
    const { rows } = await this.db.query(`SELECT id, name, chain_id, account, token, escrow, threshold, auto_refund_days FROM orgs WHERE id=$1`, [orgId]);
    if (!rows[0]) throw new HttpError(404, "org not found");
    const approvers = (await this.db.query(`SELECT address, weight FROM approvers WHERE org_id=$1`, [orgId])).rows;
    return { ...rows[0], approvers };
  }

  /** organisation default for auto-refund; each payout can override it. */
  async updateSettings(orgId: string, u: AuthUser, s: { autoRefundDays: number | null }) {
    if (s.autoRefundDays !== null && !(Number.isInteger(s.autoRefundDays) && s.autoRefundDays > 0)) throw new HttpError(400, "autoRefundDays must be a positive integer or null");
    await this.db.query(`UPDATE orgs SET auto_refund_days=$2 WHERE id=$1`, [orgId, s.autoRefundDays]);
    await this.audit(orgId, u.did, "settings.updated", s);
    return this.settings(orgId);
  }
}
