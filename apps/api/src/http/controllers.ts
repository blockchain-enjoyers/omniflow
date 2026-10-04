import {
  Body,
  Catch,
  Controller,
  Delete,
  Get,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import type pg from "pg";
import { readDevMailbox } from "@omniflow/devmail";
import { HttpError, PayoutService } from "../payouts/service.js";
import type { RowInput } from "../payouts/csv.js";
import type { ChainClient } from "../chain/chain.js";
import type { OrgService } from "../orgs/service.js";
import type { AuthUser } from "../auth/privy.js";
import { AuthGuard } from "../auth/guard.js";
import { RateLimit } from "./ratelimit.js";
import type { Monitor } from "../ops/monitor.js";

export const PAYOUTS = Symbol("PayoutService");
export const ORGS = Symbol("OrgService");
export const CHAIN = Symbol("ChainClient");
export const DB = Symbol("Db");
export const EXTRA = Symbol("Extra");

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...(e.details ? { details: e.details } : {}) });
    if (e instanceof HttpException) return res.status(e.getStatus()).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: "internal error" });
  }
}

export const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
type Rq = { user: AuthUser };

@Controller()
@UseFilters(ErrorFilter)
@UseGuards(AuthGuard)
export class MeController {
  constructor(@Inject(ORGS) private readonly orgs: OrgService, @Inject(PAYOUTS) private readonly payouts: PayoutService) {}

  @Get("me")
  me(@Req() r: Rq) {
    return this.orgs.me(r.user);
  }

  /** What waits for my signature — so an approver does not have to find the email. */
  @Get("me/approvals")
  async approvals(@Req() r: Rq) {
    return r.user.wallet ? this.payouts.pendingFor(getAddress(r.user.wallet)) : [];
  }
}

/** Flow 1 — creating the organisation account. */
@Controller("org-setups")
@UseFilters(ErrorFilter)
@UseGuards(AuthGuard)
export class SetupController {
  constructor(@Inject(ORGS) private readonly orgs: OrgService) {}

  @Post()
  start(@Req() r: Rq, @Body() b: { name: string; threshold: number; approvers: { email: string; weight: number }[]; operators?: string[]; autoRefundDays?: number | null }) {
    return this.orgs.startSetup(r.user, b);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.orgs.setup(id);
  }

  @Post(":id/join")
  join(@Req() r: Rq, @Param("id") id: string) {
    return this.orgs.joinSetup(id, r.user);
  }

  @Post(":id/confirm")
  confirm(@Req() r: Rq, @Param("id") id: string, @Body() b: { signature: Hex }) {
    return this.orgs.confirmSetup(id, r.user, b.signature);
  }
}

@Controller("orgs")
@UseFilters(ErrorFilter)
@UseGuards(AuthGuard)
export class OrgController {
  constructor(@Inject(ORGS) private readonly orgs: OrgService, @Inject(PAYOUTS) private readonly payouts: PayoutService) {}

  /** Import an account created elsewhere; the caller becomes admin and operator. The set is checked on chain. */
  @Post("import")
  async import(@Req() r: Rq, @Body() b: { name: string; account: Address; validator: Address; escrow: Address; token: Address; approvers: { address: Address; weight: number }[]; approverEmails?: string[]; autoRefundDays?: number | null }) {
    if (!r.user.email) throw new HttpError(400, "identity token with email required");
    const org = await this.orgs.importOrg(b);
    await this.orgs.addMember(org.id, r.user.email, ["admin", "operator"]);
    for (const e of b.approverEmails ?? []) await this.orgs.addMember(org.id, e, ["approver"]);
    await this.orgs.audit(org.id, r.user.did, "org.imported", { account: b.account });
    return org;
  }

  @Get(":id")
  async get(@Req() r: Rq, @Param("id") id: string) {
    const roles = await this.orgs.requireRole(id, r.user, ["admin", "operator", "approver"]);
    return { ...(await this.orgs.settings(id)), myRoles: roles };
  }

  @Patch(":id/settings")
  async settings(@Req() r: Rq, @Param("id") id: string, @Body() b: { autoRefundDays: number | null }) {
    await this.orgs.requireRole(id, r.user, ["admin"]);
    return this.orgs.updateSettings(id, r.user, b);
  }

  @Get(":id/members")
  async members(@Req() r: Rq, @Param("id") id: string) {
    await this.orgs.requireRole(id, r.user, ["admin", "operator", "approver"]);
    return this.orgs.members(id);
  }

  @Post(":id/members")
  async invite(@Req() r: Rq, @Param("id") id: string, @Body() b: { email: string }) {
    await this.orgs.requireRole(id, r.user, ["admin"]);
    await this.orgs.inviteOperator(id, r.user, b.email);
    return this.orgs.members(id);
  }

  @Delete(":id/members/:email")
  async remove(@Req() r: Rq, @Param("id") id: string, @Param("email") email: string) {
    await this.orgs.requireRole(id, r.user, ["admin"]);
    await this.orgs.removeOperator(id, r.user, email);
    return this.orgs.members(id);
  }

  @Get(":id/audit")
  async audit(@Req() r: Rq, @Param("id") id: string) {
    await this.orgs.requireRole(id, r.user, ["admin", "operator", "approver"]);
    return this.orgs.auditLog(id);
  }

  @Get(":id/payouts")
  async list(@Req() r: Rq, @Param("id") id: string) {
    await this.orgs.requireRole(id, r.user, ["admin", "operator", "approver"]);
    return this.payouts.listPayouts(id);
  }

  @Post(":id/payouts")
  async create(@Req() r: Rq, @Param("id") id: string, @Body() b: { title: string; csv?: string; rows?: RowInput[]; autoRefundDays?: number | null }) {
    await this.orgs.requireRole(id, r.user, ["operator"]);
    const p = await this.payouts.createPayout(id, b);
    await this.orgs.audit(id, r.user.did, "payout.created", { payoutId: p.id, title: b.title, rows: p.rows });
    return p;
  }

  /** Import preview: what the rows will become, line by line, before anything is created. */
  @Post(":id/payouts/preview")
  async preview(@Req() r: Rq, @Param("id") id: string, @Body() b: { csv?: string; rows?: RowInput[] }) {
    await this.orgs.requireRole(id, r.user, ["operator"]);
    const p = await this.payouts.parseRows(id, b);
    return json({
      ...p,
      rows: p.rows.map((x) => ({ ...x, status: x.chainId !== p.chainId ? "other_chain" : !x.address && !x.email ? "waiting_details" : "ready" })),
      total: p.rows.reduce((s, x) => s + x.amount, 0n),
    });
  }

  @Get(":id/balance")
  async balance(@Req() r: Rq, @Param("id") id: string) {
    await this.orgs.requireRole(id, r.user, ["admin", "operator", "approver"]);
    return json(await this.payouts.balance(id));
  }
}

@Controller("payouts/:id")
@UseFilters(ErrorFilter)
@UseGuards(AuthGuard)
export class PayoutController {
  constructor(@Inject(ORGS) private readonly orgs: OrgService, @Inject(PAYOUTS) private readonly s: PayoutService) {}

  private async can(r: Rq, id: string, roles: ("admin" | "operator" | "approver")[]) {
    const org = await this.orgs.orgOfPayout(id);
    await this.orgs.requireRole(org, r.user, roles);
    return org;
  }

  @Get("review")
  async review(@Req() r: Rq, @Param("id") id: string) {
    await this.can(r, id, ["admin", "operator", "approver"]);
    return json(await this.s.review(id));
  }

  @Post("batches")
  async freeze(@Req() r: Rq, @Param("id") id: string) {
    const org = await this.can(r, id, ["operator"]);
    const b = await this.s.freezeBatch(id, r.user.did);
    await this.orgs.audit(org, r.user.did, "batch.frozen", { payoutId: id, batchId: b.id });
    await this.s.notifyApprovers(b.id, "pending");
    return json(b);
  }

  @Post("revoke")
  async revoke(@Req() r: Rq, @Param("id") id: string, @Body() b: { rows: string[] }) {
    const org = await this.can(r, id, ["operator"]);
    const batch = await this.s.freezeRevoke(id, b.rows, r.user.did);
    await this.orgs.audit(org, r.user.did, "batch.revoke_frozen", { payoutId: id, rows: b.rows });
    await this.s.notifyApprovers(batch.id, "pending");
    return json(batch);
  }

  @Get("batches")
  async batches(@Req() r: Rq, @Param("id") id: string) {
    await this.can(r, id, ["admin", "operator", "approver"]);
    return this.s.batchesOf(id);
  }

  @Post("close")
  async close(@Req() r: Rq, @Param("id") id: string) {
    const org = await this.can(r, id, ["operator"]);
    await this.s.closePayout(id);
    await this.orgs.audit(org, r.user.did, "payout.closed", { payoutId: id });
    return { ok: true };
  }

  @Get("receipt")
  async receipt(@Req() r: Rq, @Param("id") id: string) {
    await this.can(r, id, ["admin", "operator", "approver"]);
    return this.s.receipt(id);
  }
}

/**
 * Approvers: logged in, members with the approver role — and the signature must recover to the wallet in their
 * identity token. The on-chain set remains the final check (the validator rejects anything else).
 */
@Controller("batches/:id")
@UseFilters(ErrorFilter)
@UseGuards(AuthGuard)
export class ApproverController {
  constructor(@Inject(ORGS) private readonly orgs: OrgService, @Inject(PAYOUTS) private readonly s: PayoutService) {}

  private async me(r: Rq, id: string) {
    const org = await this.orgs.orgOfBatch(id);
    await this.orgs.requireRole(org, r.user, ["approver"]);
    if (!r.user.wallet) throw new HttpError(400, "identity token with embedded wallet required");
    return { org, wallet: getAddress(r.user.wallet) };
  }

  @Get("next-step")
  async next(@Req() r: Rq, @Param("id") id: string) {
    const { wallet } = await this.me(r, id);
    return json(await this.s.nextStep(id, wallet));
  }

  @Post("approvals")
  async approve(@Req() r: Rq, @Param("id") id: string, @Body() b: { signature: Hex }) {
    const { org, wallet } = await this.me(r, id);
    const res = await this.s.addApproval(id, b.signature, wallet);
    await this.orgs.audit(org, r.user.did, "batch.approved", { batchId: id });
    return res;
  }

  @Post("final")
  async final(@Req() r: Rq, @Param("id") id: string, @Body() b: { signature: Hex }) {
    const { org, wallet } = await this.me(r, id);
    const res = await this.s.submitFinal(id, b.signature, wallet);
    await this.orgs.audit(org, r.user.did, "batch.submitted", { batchId: id, userOpHash: res.userOpHash, txHash: res.txHash });
    void this.s.settleBatch(id).catch((e) => console.error("settle", e));
    return res;
  }
}

/** Omniflow's default claim relayer — any other relayer or the recipient can do the same. Rate-limited. */
@Controller("claims")
@UseFilters(ErrorFilter)
export class ClaimController {
  private readonly limit = new RateLimit(10, 60_000);
  constructor(@Inject(CHAIN) private readonly chain: ChainClient) {}

  @Post()
  async relay(@Req() req: { ip?: string }, @Body() b: { escrow: Address; depositId: Hex; recipient: Address; deadline: string; signature: Hex }) {
    this.limit.hit(req.ip ?? "?");
    let txHash: Hex;
    try {
      txHash = await this.chain.relayClaim(b.escrow, b.depositId, b.recipient, BigInt(b.deadline), b.signature);
    } catch {
      throw new HttpError(400, "claim would fail on chain (already claimed, revoked, expired or bad signature)");
    }
    return { txHash, ok: await this.chain.waitTx(txHash) };
  }
}

/** EMULATION ONLY: the dev mailbox. Enabled by DEV_ENDPOINTS=1; never in production. */
@Controller("dev")
@UseFilters(ErrorFilter)
export class DevController {
  constructor(@Inject(DB) private readonly db: pg.Pool, @Inject(EXTRA) private readonly extra: { devEndpoints: boolean }) {}

  @Get("mailbox")
  async mailbox(@Query("to") to?: string) {
    if (!this.extra.devEndpoints) throw new HttpError(404, "not found");
    return readDevMailbox(this.db, to);
  }
}

export const MONITOR = Symbol("Monitor");

/** For load balancers and uptime checks: 200 when the API can work, 503 otherwise. No secrets in the body. */
@Controller("health")
@UseFilters(ErrorFilter)
export class HealthController {
  constructor(@Inject(MONITOR) private readonly monitor: Monitor) {}

  @Get()
  async health(@Res({ passthrough: true }) res: { status(n: number): unknown }) {
    const h = await this.monitor.status();
    if (!h.ok) res.status(503);
    return h;
  }
}
