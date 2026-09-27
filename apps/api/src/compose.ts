import type { Address, Hex } from "viem";
import { createDb, migrate, type Db } from "./db/db.js";
import { ChainClient } from "./chain/chain.js";
import { ClaimKeyVault } from "./claimkeys/vault.js";
import { DevMailboxMailer, type Mailer } from "./mail/mailer.js";
import { PayoutService } from "./payouts/service.js";
import { FormService } from "./payouts/forms.js";
import { OrgService } from "./orgs/service.js";
import { PrivyVerifier } from "./auth/privy.js";
import { Erc7677Paymaster, LocalVerifyingPaymaster } from "./chain/paymaster.js";
import { createApp } from "./http/app.js";
import { ensureDevMailbox } from "@omniflow/devmail";

/** Everything the API needs. Real setup vs emulation differs only here. */
export interface ComposeConfig {
  databaseUrl?: string;
  db?: Db;
  chain: { chainId: number; rpcUrl: string; entryPoint: Address; submitterKey: Hex };
  deployment: { factory: Address; validator: Address; escrow: Address; token: Address };
  privy: { emulatorUrl: string } | { verificationKeyPem: string; appId: string } | { verifier: PrivyVerifier };
  claimKeyEncryptionKey: string;
  urls: { app: string; claim: string; form: string };
  tokenDecimals?: number;
  claimTip?: bigint;
  maxRowsPerBatch?: number;
  mailer?: Mailer;
  /** emulated local VerifyingPaymaster, or a hosted ERC-7677 paymaster; none = the account pays gas in ETH */
  paymaster?: { local: { address: Address; signerKey: Hex } } | { erc7677: { url: string; context?: unknown } };
  devEndpoints?: boolean;
}

export async function compose(cfg: ComposeConfig) {
  const db = cfg.db ?? createDb(cfg.databaseUrl!);
  await migrate(db);
  await ensureDevMailbox(db);
  const chain = new ChainClient(cfg.chain);
  const mailer = cfg.mailer ?? new DevMailboxMailer(db);
  const sponsor = !cfg.paymaster
    ? undefined
    : "local" in cfg.paymaster
      ? new LocalVerifyingPaymaster(chain, cfg.paymaster.local.address, cfg.paymaster.local.signerKey)
      : new Erc7677Paymaster(cfg.paymaster.erc7677.url, cfg.chain.entryPoint, cfg.chain.chainId, cfg.paymaster.erc7677.context);
  const payouts = new PayoutService(db, chain, new ClaimKeyVault(cfg.claimKeyEncryptionKey), mailer, {
    tokenDecimals: cfg.tokenDecimals ?? 6,
    claimTip: cfg.claimTip ?? 50_000n,
    maxRowsPerBatch: cfg.maxRowsPerBatch ?? 40,
    claimBaseUrl: cfg.urls.claim,
    appUrl: cfg.urls.app,
    senderDisplayName: (org) => `${org} через Omniflow`,
  }, sponsor);
  const orgs = new OrgService(db, chain, mailer, { chainId: cfg.chain.chainId, ...cfg.deployment, appUrl: cfg.urls.app });
  const forms = new FormService(db, mailer, cfg.urls.form);
  const verifier =
    "verifier" in cfg.privy
      ? cfg.privy.verifier
      : "emulatorUrl" in cfg.privy
        ? await PrivyVerifier.fromEmulator(cfg.privy.emulatorUrl)
        : await PrivyVerifier.fromPem(cfg.privy.verificationKeyPem, cfg.privy.appId);
  const app = await createApp({ db, payouts, orgs, forms, chain, verifier, devEndpoints: cfg.devEndpoints ?? false });
  return { app, db, chain, payouts, orgs, forms, mailer };
}
