import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/guard.js";
import type { AuthUser } from "../auth/privy.js";
import type { OrgService, Role } from "../orgs/service.js";
import type { ListService, BookEntry } from "../payouts/lists.js";
import type { PayoutService } from "../payouts/service.js";
import { HttpError } from "../payouts/service.js";
import { ReportService } from "../reports/service.js";
import type { OnrampProvider } from "../onramp/onramp.js";
import { ErrorFilter, ORGS, PAYOUTS, json } from "./controllers.js";

export const LISTS = Symbol("ListService");
export const REPORTS = Symbol("ReportService");
export const ONRAMP = Symbol("OnrampProvider");
type Rq = { user: AuthUser };
const ANY: Role[] = ["admin", "operator", "approver"];

@Controller("orgs/:id")
@UseFilters(ErrorFilter)
@UseGuards(AuthGuard)
export class OrgExtrasController {
  constructor(
    @Inject(ORGS) private readonly orgs: OrgService,
    @Inject(LISTS) private readonly lists: ListService,
    @Inject(REPORTS) private readonly reports: ReportService,
    @Inject(ONRAMP) private readonly onramp: OnrampProvider | null,
  ) {}

  @Get("address-book")
  async book(@Req() r: Rq, @Param("id") id: string) {
    await this.orgs.requireRole(id, r.user, ANY);
    return this.lists.book(id);
  }

  @Post("address-book")
  async upsert(@Req() r: Rq, @Param("id") id: string, @Body() b: BookEntry) {
    await this.orgs.requireRole(id, r.user, ["operator"]);
    const e = await this.lists.upsertEntry(id, b);
    await this.orgs.audit(id, r.user.did, "book.saved", { name: b.name, address: b.address, email: b.email });
    return e;
  }

  @Delete("address-book/:entry")
  async remove(@Req() r: Rq, @Param("id") id: string, @Param("entry") entry: string) {
    await this.orgs.requireRole(id, r.user, ["operator"]);
    await this.lists.deleteEntry(id, entry);
    await this.orgs.audit(id, r.user.did, "book.deleted", { entry });
    return { ok: true };
  }

  @Post("payouts/from-book")
  async fromBook(@Req() r: Rq, @Param("id") id: string, @Body() b: { title: string; items: { id: string; amount: string }[]; autoRefundDays?: number | null }) {
    await this.orgs.requireRole(id, r.user, ["operator"]);
    const p = await this.lists.payoutFromBook(id, b);
    await this.orgs.audit(id, r.user.did, "payout.created", { payoutId: p.id, title: b.title, source: "address_book" });
    return p;
  }

  @Get("schedules")
  async schedules(@Req() r: Rq, @Param("id") id: string) {
    await this.orgs.requireRole(id, r.user, ANY);
    return this.lists.schedules(id);
  }

  @Post("schedules")
  async schedule(@Req() r: Rq, @Param("id") id: string, @Body() b: { title: string; templatePayoutId: string; every: "week" | "month"; firstRunAt: string }) {
    await this.orgs.requireRole(id, r.user, ["operator"]);
    const s = await this.lists.createSchedule(id, r.user.did, b);
    await this.orgs.audit(id, r.user.did, "schedule.created", b);
    return s;
  }

  @Patch("schedules/:sid")
  async toggle(@Req() r: Rq, @Param("id") id: string, @Param("sid") sid: string, @Body() b: { active: boolean }) {
    await this.orgs.requireRole(id, r.user, ["operator"]);
    await this.lists.setScheduleActive(id, sid, b.active);
    await this.orgs.audit(id, r.user.did, b.active ? "schedule.resumed" : "schedule.paused", { scheduleId: sid });
    return { ok: true };
  }

  /** payments report; ?format=csv for the accountant. */
  @Get("reports/payments")
  async report(@Req() r: Rq, @Param("id") id: string, @Query("from") from: string | undefined, @Query("to") to: string | undefined, @Query("format") format: string | undefined, @Res({ passthrough: true }) res: { setHeader(k: string, v: string): void }) {
    await this.orgs.requireRole(id, r.user, ANY);
    const lines = await this.reports.payments(id, from ? new Date(from) : undefined, to ? new Date(to) : undefined);
    if (format !== "csv") return lines;
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="omniflow-payments.csv"`);
    return ReportService.toCsv(lines);
  }

  /** buy crypto onto the organisation's own account. The destination comes from the database. */
  @Post("onramp")
  async buy(@Req() r: Rq, @Param("id") id: string, @Body() b: { fiatAmount: number; currency?: string; returnUrl?: string }) {
    await this.orgs.requireRole(id, r.user, ["admin", "approver"]);
    if (!this.onramp) throw new HttpError(501, "on-ramp partner not configured");
    const s = await this.orgs.settings(id);
    const session = await this.onramp.createSession({ account: s.account, fiatAmount: b.fiatAmount, currency: b.currency ?? "USD", returnUrl: b.returnUrl });
    await this.orgs.audit(id, r.user.did, "onramp.session", { fiatAmount: b.fiatAmount, provider: this.onramp.name });
    return { ...session, destination: s.account, provider: this.onramp.name };
  }
}

@Controller("payouts/:id")
@UseFilters(ErrorFilter)
@UseGuards(AuthGuard)
export class PayoutExtrasController {
  constructor(@Inject(ORGS) private readonly orgs: OrgService, @Inject(LISTS) private readonly lists: ListService, @Inject(PAYOUTS) private readonly payouts: PayoutService) {}

  private async op(r: Rq, id: string) {
    const org = await this.orgs.orgOfPayout(id);
    await this.orgs.requireRole(org, r.user, ["operator"]);
    return org;
  }

  @Post("repeat")
  async repeat(@Req() r: Rq, @Param("id") id: string, @Body() b: { title?: string }) {
    const org = await this.op(r, id);
    const p = await this.lists.repeat(id, b.title);
    await this.orgs.audit(org, r.user.did, "payout.created", { payoutId: p.id, source: "repeat", from: id });
    return p;
  }

  @Patch("rows/:row")
  async edit(@Req() r: Rq, @Param("id") id: string, @Param("row") row: string, @Body() b: { amount?: string; address?: string | null; email?: string | null; remove?: boolean }) {
    const org = await this.op(r, id);
    const res = await this.lists.editRow(id, row, b);
    await this.orgs.audit(org, r.user.did, "row.edited", { payoutId: id, row, ...b });
    return res;
  }

  @Post("rows")
  async add(@Req() r: Rq, @Param("id") id: string, @Body() b: { name: string; email?: string; address?: string; chainId: number; amount: string; category?: string }) {
    const org = await this.op(r, id);
    await this.lists.addRow(id, b);
    await this.orgs.audit(org, r.user.did, "row.added", { payoutId: id, name: b.name });
    return { ok: true };
  }

  /** re-issue claim links (new keys, escrow.rekey under N-of-M). */
  @Post("rekey")
  async rekey(@Req() r: Rq, @Param("id") id: string, @Body() b: { rows: string[] }) {
    const org = await this.op(r, id);
    const batch = await this.payouts.freezeRekey(id, b.rows);
    await this.orgs.audit(org, r.user.did, "batch.rekey_frozen", { payoutId: id, rows: b.rows });
    await this.payouts.notifyApprovers(batch.id, "pending");
    return json(batch);
  }
}
