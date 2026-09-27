import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, UseGuards, UseFilters, type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Address, Hex } from "viem";
import { HttpError, PayoutService } from "../payouts/service.js";
import type { ChainClient } from "../chain/chain.js";
import { DevAuthGuard } from "./auth.js";

export const PAYOUTS = Symbol("PayoutService");
export const CHAIN = Symbol("ChainClient");

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    if (e instanceof HttpException) return res.status(e.getStatus()).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: "internal error" });
  }
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

@Controller()
@UseFilters(ErrorFilter)
export class OperatorController {
  constructor(@Inject(PAYOUTS) private readonly s: PayoutService) {}

  @Post("orgs")
  @UseGuards(DevAuthGuard)
  async createOrg(@Body() b: { name: string; account: Address; validator: Address; escrow: Address; token: Address; approvers: { address: Address; weight: number }[]; autoRefundDays?: number | null }) {
    return this.s.createOrg(b);
  }

  @Post("orgs/:orgId/payouts")
  @UseGuards(DevAuthGuard)
  async createPayout(@Param("orgId") orgId: string, @Body() b: { title: string; csv: string; autoRefundDays?: number | null }) {
    return this.s.createPayout(orgId, b);
  }

  @Get("payouts/:id/review")
  @UseGuards(DevAuthGuard)
  async review(@Param("id") id: string) {
    return json(await this.s.review(id));
  }

  @Post("payouts/:id/batches")
  @UseGuards(DevAuthGuard)
  async freeze(@Param("id") id: string) {
    return json(await this.s.freezeBatch(id));
  }

  @Post("payouts/:id/revoke")
  @UseGuards(DevAuthGuard)
  async revoke(@Param("id") id: string, @Body() b: { rows: string[] }) {
    return json(await this.s.freezeRevoke(id, b.rows));
  }

  @Get("payouts/:id/batches")
  @UseGuards(DevAuthGuard)
  async batches(@Param("id") id: string) {
    return this.s.batchesOf(id);
  }

  @Post("payouts/:id/close")
  @UseGuards(DevAuthGuard)
  async close(@Param("id") id: string) {
    await this.s.closePayout(id);
    return { ok: true };
  }

  @Get("payouts/:id/receipt")
  @UseGuards(DevAuthGuard)
  async receipt(@Param("id") id: string) {
    return this.s.receipt(id);
  }
}

/** Approvers authenticate by signature; the set is checked against the chain (createOrg). */
@Controller("batches/:id")
@UseFilters(ErrorFilter)
export class ApproverController {
  constructor(@Inject(PAYOUTS) private readonly s: PayoutService) {}

  @Get("next-step")
  async next(@Param("id") id: string, @Query("approver") approver: Address) {
    return json(await this.s.nextStep(id, approver));
  }

  @Post("approvals")
  async approve(@Param("id") id: string, @Body() b: { signature: Hex }) {
    return this.s.addApproval(id, b.signature);
  }

  @Post("final")
  async final(@Param("id") id: string, @Body() b: { signature: Hex }) {
    const r = await this.s.submitFinal(id, b.signature);
    void this.s.settleBatch(id).catch((e) => console.error("settle", e));
    return r;
  }
}

/** Omniflow's default relayer for claims — any other relayer or the recipient can do the same. */
@Controller("claims")
@UseFilters(ErrorFilter)
export class ClaimController {
  constructor(@Inject(CHAIN) private readonly chain: ChainClient) {}

  @Post()
  async relay(@Body() b: { escrow: Address; depositId: Hex; recipient: Address; deadline: string; signature: Hex }) {
    let txHash: Hex;
    try {
      txHash = await this.chain.relayClaim(b.escrow, b.depositId, b.recipient, BigInt(b.deadline), b.signature);
    } catch {
      throw new HttpError(400, "claim would fail on chain (already claimed, revoked, expired or bad signature)");
    }
    return { txHash, ok: await this.chain.waitTx(txHash) };
  }
}
