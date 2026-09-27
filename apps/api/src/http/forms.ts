import { Body, Controller, Get, Inject, Param, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/guard.js";
import type { FormService } from "../payouts/forms.js";
import type { OrgService } from "../orgs/service.js";
import type { AuthUser } from "../auth/privy.js";
import { ErrorFilter, ORGS } from "./controllers.js";
import { RateLimit } from "./ratelimit.js";

export const FORMS = Symbol("FormService");

@Controller()
@UseFilters(ErrorFilter)
export class FormController {
  private readonly limit = new RateLimit(20, 60_000);
  constructor(@Inject(FORMS) private readonly forms: FormService, @Inject(ORGS) private readonly orgs: OrgService) {}

  @Post("payouts/:id/forms")
  @UseGuards(AuthGuard)
  async create(@Req() r: { user: AuthUser }, @Param("id") id: string, @Body() b: { rows?: string[] }) {
    const org = await this.orgs.orgOfPayout(id);
    await this.orgs.requireRole(org, r.user, ["operator"]);
    const links = await this.forms.createLinks(id, b.rows);
    await this.orgs.audit(org, r.user.did, "forms.created", { payoutId: id, rows: links.map((l) => l.row) });
    return links;
  }

  @Get("forms/:token")
  view(@Req() req: { ip?: string }, @Param("token") token: string) {
    this.limit.hit(req.ip ?? "?");
    return this.forms.view(token);
  }

  @Post("forms/:token")
  submit(@Req() req: { ip?: string }, @Param("token") token: string, @Body() b: { address?: string; email?: string; chainId?: number }) {
    this.limit.hit(req.ip ?? "?");
    return this.forms.submit(token, b);
  }
}
