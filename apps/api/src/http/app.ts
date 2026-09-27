import "reflect-metadata";
import { Module, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { PayoutService } from "../payouts/service.js";
import type { ChainClient } from "../chain/chain.js";
import { ApproverController, CHAIN, ClaimController, OperatorController, PAYOUTS } from "./controllers.js";

@Module({})
class AppModule {
  static with(service: PayoutService, chain: ChainClient): DynamicModule {
    return {
      module: AppModule,
      controllers: [OperatorController, ApproverController, ClaimController],
      providers: [
        { provide: PAYOUTS, useValue: service },
        { provide: CHAIN, useValue: chain },
      ],
    };
  }
}

export async function createApp(service: PayoutService, chain: ChainClient) {
  const app = await NestFactory.create(AppModule.with(service, chain), { logger: ["error", "warn"] });
  app.enableCors({ origin: true });
  return app;
}
