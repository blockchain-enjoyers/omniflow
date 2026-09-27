import { loadConfig } from "./config.js";
import { createDb, migrate } from "./db/db.js";
import { ChainClient } from "./chain/chain.js";
import { ClaimKeyVault } from "./claimkeys/vault.js";
import { DirectoryMailer } from "./mail/mailer.js";
import { PayoutService } from "./payouts/service.js";
import { createApp } from "./http/app.js";

const cfg = loadConfig();
const db = createDb(cfg.databaseUrl);
await migrate(db);
const chain = new ChainClient({ chainId: cfg.chainId, rpcUrl: cfg.rpcUrl, entryPoint: cfg.entryPoint, submitterKey: cfg.submitterKey });
const service = new PayoutService(db, chain, new ClaimKeyVault(cfg.claimKeyEncryptionKey), new DirectoryMailer(cfg.mailDir), {
  tokenDecimals: cfg.tokenDecimals,
  claimTip: cfg.claimTip,
  maxRowsPerBatch: cfg.maxRowsPerBatch,
  claimBaseUrl: cfg.claimBaseUrl,
  senderDisplayName: (org) => `${org} через Omniflow`,
});
const app = await createApp(service, chain);
await app.listen(cfg.port);

// Indexer + keeper loop. Deliberately simple (no job queue; one idempotent loop is enough for now).
const TICK_MS = Number(process.env.TICK_MS ?? 15_000);
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await service.tick();
  } finally {
    running = false;
  }
}, TICK_MS);
console.log(`omniflow api on :${cfg.port}, chain ${cfg.chainId}`);
