import type { Address, Hex } from "viem";
import { createDb, migrate, type Db } from "./db/db.js";
import { ChainClient } from "./chain/chain.js";
import { ClaimKeyVault } from "./claimkeys/vault.js";
import { DevMailboxMailer, type Mailer } from "./mail/mailer.js";
import { PayoutService } from "./payouts/service.js";
import { FormService } from "./payouts/forms.js";
import { DocumentService } from "./documents/service.js";
import { OrgService } from "./orgs/service.js";
import { PrivyVerifier } from "./auth/privy.js";
import { Erc7677Paymaster, LocalVerifyingPaymaster, ZeroDevPaymaster } from "./chain/paymaster.js";
import { createApp } from "./http/app.js";
import { ensureDevMailbox } from "@omniflow/devmail";
import { ListService } from "./payouts/lists.js";
import { ReportService, StablecoinParity } from "./reports/service.js";
import { EmulatedOnramp, type OnrampProvider } from "./onramp/onramp.js";
import { Monitor, type MonitorConfig } from "./ops/monitor.js";

/** Everything the API needs. Real setup vs emulation differs only here. */
export interface ComposeConfig {
  databaseUrl?: string;
  db?: Db;
  /** bundlerUrl: hosted bundler (ZeroDev's project RPC); omitted = the API calls handleOps itself */
  chain: { chainId: number; rpcUrl: string; entryPoint: Address; submitterKey: Hex; bundlerUrl?: string; logChunkBlocks?: number };
  deployment: { factory: Address; validator: Address; escrow: Address; token: Address };
  privy: { emulatorUrl: string } | { verificationKeyPem: string; appId: string } | { verifier: PrivyVerifier };
  claimKeyEncryptionKey: string;
  urls: { app: string; claim: string; form: string };
  tokenDecimals?: number;
  claimTip?: bigint;
  maxRowsPerBatch?: number;
  mailer?: Mailer;
  /**
   * ZeroDev — zd_sponsorUserOperation on the project RPC; the emulated local VerifyingPaymaster;
   * or any ERC-7677 paymaster. None = the account pays gas in ETH.
   */
  paymaster?: { zerodev: { url: string } } | { local: { address: Address; signerKey: Hex } } | { erc7677: { url: string; context?: unknown } };
  devEndpoints?: boolean;
  /** extra browser origins; the origins of urls.app/claim/form are always allowed. "any" — tests and local tools only */
  corsOrigins?: string[] | "any";
  trustProxy?: boolean | number | string;
  monitor?: MonitorConfig;
  /** for payment records: the network's name (a demo backend names its demo network) and an EIP-3091 explorer */
  network?: { name?: string; explorerUrl?: string };
  /** partner not chosen — the emulator, or nothing */
  onramp?: { emulatorUrl: string } | OnrampProvider;
}

export async function compose(cfg: ComposeConfig) {
  const db = cfg.db ?? createDb(cfg.databaseUrl!);
  await migrate(db);
  await ensureDevMailbox(db);
  const chain = new ChainClient(cfg.chain);
  const mailer = cfg.mailer ?? new DevMailboxMailer(db);
  const sponsor = !cfg.paymaster
    ? undefined
    : "zerodev" in cfg.paymaster
      ? new ZeroDevPaymaster(cfg.paymaster.zerodev.url, cfg.chain.entryPoint, cfg.chain.chainId)
      : "local" in cfg.paymaster
        ? new LocalVerifyingPaymaster(chain, cfg.paymaster.local.address, cfg.paymaster.local.signerKey)
        : new Erc7677Paymaster(cfg.paymaster.erc7677.url, cfg.chain.entryPoint, cfg.chain.chainId, cfg.paymaster.erc7677.context);
  const payouts = new PayoutService(db, chain, new ClaimKeyVault(cfg.claimKeyEncryptionKey), mailer, {
    tokenDecimals: cfg.tokenDecimals ?? 6,
    claimTip: cfg.claimTip ?? 50_000n,
    maxRowsPerBatch: cfg.maxRowsPerBatch ?? 40,
    claimBaseUrl: cfg.urls.claim,
    appUrl: cfg.urls.app,
    senderDisplayName: (org) => `${org} via Omniflow`,
  }, sponsor);
  const orgs = new OrgService(db, chain, mailer, { chainId: cfg.chain.chainId, ...cfg.deployment, appUrl: cfg.urls.app });
  const forms = new FormService(db, mailer, cfg.urls.form);
  const lists = new ListService(db, payouts, mailer, cfg.urls.app, cfg.tokenDecimals ?? 6);
  payouts.afterSettle = (payoutId) => lists.rememberPaid(payoutId);
  const price = new StablecoinParity();
  const reports = new ReportService(db, price, cfg.tokenDecimals ?? 6, "USDC", cfg.network);
  const docs = new DocumentService(db, mailer, price, cfg.tokenDecimals ?? 6, cfg.urls.form);
  const onramp = !cfg.onramp ? null : "emulatorUrl" in cfg.onramp ? new EmulatedOnramp(cfg.onramp.emulatorUrl) : cfg.onramp;
  const monitor = new Monitor(db, chain, cfg.monitor);
  /** One scheduler pass: indexer, keeper, stuck batches, recurring payouts, then the health alerts. Idempotent. */
  const tick = async () => {
    await payouts.tick();
    await lists.runSchedules();
    await monitor.run();
  };
  const verifier =
    "verifier" in cfg.privy
      ? cfg.privy.verifier
      : "emulatorUrl" in cfg.privy
        ? await PrivyVerifier.fromEmulator(cfg.privy.emulatorUrl)
        : await PrivyVerifier.fromPem(cfg.privy.verificationKeyPem, cfg.privy.appId);
  const app = await createApp({ db, payouts, orgs, forms, docs, lists, reports, onramp, chain, verifier, devEndpoints: cfg.devEndpoints ?? false,
    corsOrigins: cfg.corsOrigins === "any" ? "any" : [...new Set([cfg.urls.app, cfg.urls.claim, cfg.urls.form, ...(cfg.corsOrigins ?? [])].map((u) => new URL(u).origin))],
    trustProxy: cfg.trustProxy,
    monitor,
  });
  return { app, db, chain, payouts, orgs, forms, docs, lists, reports, mailer, tick, monitor };
}
