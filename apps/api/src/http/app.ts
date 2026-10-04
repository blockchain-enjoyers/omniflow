import "reflect-metadata";
import { Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type pg from "pg";
import type { PayoutService } from "../payouts/service.js";
import type { OrgService } from "../orgs/service.js";
import type { ChainClient } from "../chain/chain.js";
import type { PrivyVerifier } from "../auth/privy.js";
import { AuthGuard, USERS, VERIFIER } from "../auth/guard.js";
import { ApproverController, CHAIN, ClaimController, DB, DevController, EXTRA, HealthController, MeController, MONITOR, ORGS, OrgController, PAYOUTS, PayoutController, SetupController } from "./controllers.js";
import type { Monitor } from "../ops/monitor.js";
import { FormController, FORMS } from "./forms.js";
import { DocumentController, DOCS, TaxFormController } from "./documents.js";
import type { DocumentService } from "../documents/service.js";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { FormService } from "../payouts/forms.js";
import { LISTS, ONRAMP, OrgExtrasController, PayoutExtrasController, REPORTS } from "./extras.js";
import type { ListService } from "../payouts/lists.js";
import type { ReportService } from "../reports/service.js";
import type { OnrampProvider } from "../onramp/onramp.js";

export interface AppDeps {
  db: pg.Pool;
  payouts: PayoutService;
  orgs: OrgService;
  forms: FormService;
  docs: DocumentService;
  lists: ListService;
  reports: ReportService;
  onramp: OnrampProvider | null;
  chain: ChainClient;
  verifier: PrivyVerifier;
  devEndpoints: boolean;
  /** browser origins allowed to call the API (the dashboard and the claim page), or "any" (tests, local tools) */
  corsOrigins: string[] | "any";
  /** Express "trust proxy": how many proxies (or which) sit in front, so req.ip is the client, not the proxy */
  trustProxy?: boolean | number | string;
  monitor: Monitor;
}

@Module({})
class AppModule {
  static with(d: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [MeController, SetupController, OrgController, OrgExtrasController, PayoutController, PayoutExtrasController, ApproverController, ClaimController, FormController, DocumentController, TaxFormController, DevController, HealthController],
      providers: [
        { provide: PAYOUTS, useValue: d.payouts },
        { provide: ORGS, useValue: d.orgs },
        { provide: FORMS, useValue: d.forms },
        { provide: DOCS, useValue: d.docs },
        { provide: LISTS, useValue: d.lists },
        { provide: REPORTS, useValue: d.reports },
        { provide: ONRAMP, useValue: d.onramp },
        { provide: CHAIN, useValue: d.chain },
        { provide: DB, useValue: d.db },
        { provide: EXTRA, useValue: { devEndpoints: d.devEndpoints } },
        { provide: VERIFIER, useValue: d.verifier },
        { provide: MONITOR, useValue: d.monitor },
        { provide: USERS, useValue: { upsert: (u: Parameters<OrgService["upsertUser"]>[0]) => d.orgs.upsertUser(u) } },
        AuthGuard,
      ],
    };
  }
}

export async function createApp(d: AppDeps) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.with(d), { logger: ["error", "warn"] });
  // a signed tax form arrives as base64 JSON (up to 8 MB of PDF)
  app.useBodyParser("json", { limit: "12mb" });
  if (d.trustProxy !== undefined) app.getHttpAdapter().getInstance().set("trust proxy", d.trustProxy);
  // Only our own pages may call the API from a browser. Server-to-server callers are unaffected by CORS.
  app.enableCors({ origin: d.corsOrigins === "any" ? true : d.corsOrigins, allowedHeaders: ["content-type", "authorization", "privy-id-token"] });
  return app;
}
