import { Body, Controller, Get, Inject, Param, Post, Query, Req, StreamableFile, UseFilters, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/guard.js";
import type { AuthUser } from "../auth/privy.js";
import type { OrgService, Role } from "../orgs/service.js";
import type { DocumentService } from "../documents/service.js";
import { recordLines, recordPdf, recordTitle, recordFooter } from "../documents/record-pdf.js";
import type { Party } from "../documents/nec.js";
import type { Db } from "../db/db.js";
import type { ReportService } from "../reports/service.js";
import { HttpError } from "../payouts/service.js";
import { DB, ErrorFilter, ORGS } from "./controllers.js";
import { REPORTS } from "./extras.js";
import { RateLimit } from "./ratelimit.js";

export const DOCS = Symbol("DocumentService");
type Rq = { user: AuthUser };
const ANY: Role[] = ["admin", "operator", "approver"];
const pdf = (bytes: Uint8Array, filename: string, inline = false) =>
  new StreamableFile(Buffer.from(bytes), { type: "application/pdf", disposition: `${inline ? "inline" : "attachment"}; filename="${filename}"` });
const utcNow = () => new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

/** Signed-in side: the payment record, form requests, year-end forms. */
@Controller()
@UseFilters(ErrorFilter)
@UseGuards(AuthGuard)
export class DocumentController {
  constructor(
    @Inject(DOCS) private readonly docs: DocumentService,
    @Inject(ORGS) private readonly orgs: OrgService,
    @Inject(REPORTS) private readonly reports: ReportService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** The record of one payment as data — the dashboard page and the PDF are drawn from the same lines. */
  @Get("payouts/:id/rows/:row/record.json")
  async record(@Req() r: Rq, @Param("id") id: string, @Param("row") row: string) {
    const org = await this.orgs.orgOfPayout(id);
    await this.orgs.requireRole(org, r.user, ANY);
    const [rec] = await this.reports.records.records(org, { payoutId: id, row });
    if (!rec) throw new HttpError(404, "no payment for this row yet — a record exists once the money has left the account");
    const { rows } = await this.db.query(`SELECT id FROM payout_rows WHERE payout_id=$1 AND row_key=$2`, [id, row]);
    return { rowId: rows[0].id, orgId: org, title: recordTitle(rec), sub: `${rec.status} · ${rec.executedAt ?? ""}`, lines: recordLines(rec), footer: recordFooter(rec, utcNow()), documents: await this.docs.documents(id, row) };
  }

  /** The payment record as a PDF, built in code. */
  @Get("payments/:rowId/record.pdf")
  async recordPdf(@Req() r: Rq, @Param("rowId") rowId: string) {
    const { rows } = await this.db.query(`SELECT r.row_key, r.payout_id, p.org_id FROM payout_rows r JOIN payouts p ON p.id=r.payout_id WHERE r.id=$1`, [rowId]).catch(() => ({ rows: [] }));
    if (!rows[0]) throw new HttpError(404, "payment not found");
    await this.orgs.requireRole(rows[0].org_id, r.user, ANY);
    const [rec] = await this.reports.records.records(rows[0].org_id, { payoutId: rows[0].payout_id, row: rows[0].row_key });
    if (!rec) throw new HttpError(404, "no payment for this row yet");
    return pdf(await recordPdf(rec, utcNow()), `payment-record-${rowId}.pdf`);
  }

  @Post("payouts/:id/rows/:row/document-request")
  async request(@Req() r: Rq, @Param("id") id: string, @Param("row") row: string, @Body() b: { type?: string }) {
    const org = await this.orgs.orgOfPayout(id);
    await this.orgs.requireRole(org, r.user, ["operator", "admin"]);
    return this.docs.request(id, row, b.type, r.user.did);
  }

  @Get("orgs/:id/reports/year-end")
  async yearEnd(@Req() r: Rq, @Param("id") id: string, @Query("year") year: string | undefined) {
    await this.orgs.requireRole(id, r.user, ANY);
    return this.docs.yearEnd(id, year ? Number(year) : new Date().getUTCFullYear());
  }

  /** One recipient's Form 1099-NEC, Copy B. TINs and addresses arrive with the request and are not stored. */
  @Post("orgs/:id/reports/year-end/1099-nec")
  async nec(@Req() r: Rq, @Param("id") id: string, @Body() b: { year: number; recipient: string; payer: Party; recipientInfo: Omit<Party, "name"> }) {
    await this.orgs.requireRole(id, r.user, ["operator", "admin"]);
    const { bytes, filename } = await this.docs.nec(id, r.user.did, b);
    return pdf(bytes, filename);
  }
}

/** Public side: the recipient's form request page. The link is the capability. */
@Controller("tax-forms")
@UseFilters(ErrorFilter)
export class TaxFormController {
  private readonly limit = new RateLimit(30, 60_000);
  constructor(@Inject(DOCS) private readonly docs: DocumentService) {}

  @Get("blank/:type")
  blank(@Req() req: { ip?: string }, @Param("type") type: string) {
    this.limit.hit(req.ip ?? "?");
    const b = this.docs.blank(type);
    return pdf(b.bytes, b.filename);
  }

  @Get(":token")
  view(@Req() req: { ip?: string }, @Param("token") token: string) {
    this.limit.hit(req.ip ?? "?");
    return this.docs.view(token);
  }

  @Post(":token")
  upload(@Req() req: { ip?: string }, @Param("token") token: string, @Body() b: { type?: string; filename?: string; contentBase64?: string }) {
    this.limit.hit(req.ip ?? "?");
    return this.docs.upload(token, b);
  }
}
