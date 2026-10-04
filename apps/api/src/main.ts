import { getAddress, parseEther, type Address, type Hex } from "viem";
import { compose } from "./compose.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const addr = (n: string) => getAddress(need(n)) as Address;
function parseTrustProxy(v?: string): boolean | number | string | undefined {
  if (!v) return undefined;
  if (v === "true" || v === "false") return v === "true";
  return /^\d+$/.test(v) ? Number(v) : v;
}

const { app, tick, db } = await compose({
  databaseUrl: need("DATABASE_URL"),
  // ZERODEV_RPC: the project RPC from the ZeroDev dashboard — bundler and paymaster in one URL
  chain: {
    chainId: Number(need("CHAIN_ID")),
    rpcUrl: need("RPC_URL"),
    entryPoint: addr("ENTRYPOINT"),
    submitterKey: need("SUBMITTER_PRIVATE_KEY") as Hex,
    bundlerUrl: process.env.ZERODEV_RPC || process.env.BUNDLER_URL || undefined,
    logChunkBlocks: Number(process.env.LOG_CHUNK_BLOCKS ?? 2000),
  },
  deployment: { factory: addr("KERNEL_FACTORY"), validator: addr("WEIGHTED_VALIDATOR"), escrow: addr("ESCROW"), token: addr("TOKEN") },
  privy: process.env.PRIVY_EMULATOR_URL
    ? { emulatorUrl: process.env.PRIVY_EMULATOR_URL }
    : { verificationKeyPem: need("PRIVY_VERIFICATION_KEY"), appId: need("PRIVY_APP_ID") },
  claimKeyEncryptionKey: need("CLAIM_KEY_ENCRYPTION_KEY"),
  // payment records link transactions here (EIP-3091 routes); e.g. https://sepolia.arbiscan.io for Arbitrum Sepolia
  network: { name: process.env.NETWORK_NAME || undefined, explorerUrl: process.env.EXPLORER_URL || undefined },
  urls: { app: need("APP_URL"), claim: need("CLAIM_BASE_URL"), form: need("FORM_BASE_URL") },
  tokenDecimals: Number(process.env.TOKEN_DECIMALS ?? 6),
  claimTip: BigInt(process.env.CLAIM_TIP_UNITS ?? "50000"),
  maxRowsPerBatch: Number(process.env.MAX_ROWS_PER_BATCH ?? 40),
  paymaster: process.env.ZERODEV_RPC
    ? { zerodev: { url: process.env.ZERODEV_RPC } }
    : process.env.PAYMASTER_URL
    ? { erc7677: { url: process.env.PAYMASTER_URL } }
    : process.env.PAYMASTER_ADDRESS
      ? { local: { address: addr("PAYMASTER_ADDRESS"), signerKey: need("PAYMASTER_SIGNER_KEY") as Hex } }
      : undefined,
  onramp: process.env.ONRAMP_EMULATOR_URL ? { emulatorUrl: process.env.ONRAMP_EMULATOR_URL } : undefined,
  devEndpoints: process.env.DEV_ENDPOINTS === "1" && process.env.NODE_ENV !== "production",
  // TRUST_PROXY: number of proxies in front (e.g. 1 behind one load balancer), "true", or an Express trust expression
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // CORS_ORIGINS: extra browser origins, comma-separated; APP_URL, CLAIM_BASE_URL and FORM_BASE_URL are always allowed
  corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  monitor: {
    minSubmitterWei: parseEther(process.env.SUBMITTER_MIN_ETH ?? "0.005"),
    stuckAfterMinutes: Number(process.env.STUCK_BATCH_MINUTES ?? 15),
    maxIndexerLag: BigInt(process.env.MAX_INDEXER_LAG_BLOCKS ?? 5000),
    webhookUrl: process.env.ALERT_WEBHOOK_URL || undefined,
  },
});
const port = Number(process.env.PORT ?? 3001);
await app.listen(port);
console.log(`omniflow api on :${port}`);

// Indexer + keeper + schedules + alerts; every step is idempotent. An error in one pass is logged, never fatal:
// an unhandled rejection would stop the whole API (Node's default), and with it every payout.
const TICK_MS = Number(process.env.TICK_MS ?? 15_000);
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await tick();
  } catch (e) {
    console.error(JSON.stringify({ level: "error", where: "tick", text: (e as Error).message }));
  } finally {
    running = false;
  }
}, TICK_MS);

// Graceful stop (container restarts, deploys): no new pass, finish HTTP, close the pool.
const stop = async (signal: string) => {
  console.log(`omniflow api: ${signal}, stopping`);
  clearInterval(timer);
  await app.close();
  await db.end();
  process.exit(0);
};
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
