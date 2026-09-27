import "reflect-metadata";
import { Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type pg from "pg";
import type { PayoutService } from "../payouts/service.js";
import type { OrgService } from "../orgs/service.js";
import type { ChainClient } from "../chain/chain.js";
import type { PrivyVerifier } from "../auth/privy.js";
import { AuthGuard, USERS, VERIFIER } from "../auth/guard.js";
import { ApproverController, CHAIN, ClaimController, DB, DevController, EXTRA, MeController, ORGS, OrgController, PAYOUTS, PayoutController, SetupController } from "./controllers.js";
import { FormController, FORMS } from "./forms.js";
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
  lists: ListService;
  reports: ReportService;
  onramp: OnrampProvider | null;
  chain: ChainClient;
  verifier: PrivyVerifier;
  devEndpoints: boolean;
}

@Module({})
class AppModule {
  static with(d: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [MeController, SetupController, OrgController, OrgExtrasController, PayoutController, PayoutExtrasController, ApproverController, ClaimController, FormController, DevController],
      providers: [
        { provide: PAYOUTS, useValue: d.payouts },
        { provide: ORGS, useValue: d.orgs },
        { provide: FORMS, useValue: d.forms },
        { provide: LISTS, useValue: d.lists },
        { provide: REPORTS, useValue: d.reports },
        { provide: ONRAMP, useValue: d.onramp },
        { provide: CHAIN, useValue: d.chain },
        { provide: DB, useValue: d.db },
        { provide: EXTRA, useValue: { devEndpoints: d.devEndpoints } },
        { provide: VERIFIER, useValue: d.verifier },
        { provide: USERS, useValue: { upsert: (u: Parameters<OrgService["upsertUser"]>[0]) => d.orgs.upsertUser(u) } },
        AuthGuard,
      ],
    };
  }
}

export async function createApp(d: AppDeps) {
  const app = await NestFactory.create(AppModule.with(d), { logger: ["error", "warn"] });
  app.enableCors({ origin: true, allowedHeaders: ["content-type", "authorization", "privy-id-token"] });
  return app;
}
