import { getAddress, type Address, type Hex } from "viem";
import { compose } from "./compose.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const addr = (n: string) => getAddress(need(n)) as Address;

const { app, payouts } = await compose({
  databaseUrl: need("DATABASE_URL"),
  chain: { chainId: Number(need("CHAIN_ID")), rpcUrl: need("RPC_URL"), entryPoint: addr("ENTRYPOINT"), submitterKey: need("SUBMITTER_PRIVATE_KEY") as Hex },
  deployment: { factory: addr("KERNEL_FACTORY"), validator: addr("WEIGHTED_VALIDATOR"), escrow: addr("ESCROW"), token: addr("TOKEN") },
  privy: process.env.PRIVY_EMULATOR_URL
    ? { emulatorUrl: process.env.PRIVY_EMULATOR_URL }
    : { verificationKeyPem: need("PRIVY_VERIFICATION_KEY"), appId: need("PRIVY_APP_ID") },
  claimKeyEncryptionKey: need("CLAIM_KEY_ENCRYPTION_KEY"),
  urls: { app: need("APP_URL"), claim: need("CLAIM_BASE_URL"), form: need("FORM_BASE_URL") },
  tokenDecimals: Number(process.env.TOKEN_DECIMALS ?? 6),
  claimTip: BigInt(process.env.CLAIM_TIP_UNITS ?? "50000"),
  maxRowsPerBatch: Number(process.env.MAX_ROWS_PER_BATCH ?? 40),
  paymaster: process.env.PAYMASTER_URL
    ? { erc7677: { url: process.env.PAYMASTER_URL } }
    : process.env.PAYMASTER_ADDRESS
      ? { local: { address: addr("PAYMASTER_ADDRESS"), signerKey: need("PAYMASTER_SIGNER_KEY") as Hex } }
      : undefined,
  devEndpoints: process.env.DEV_ENDPOINTS === "1" && process.env.NODE_ENV !== "production",
});
const port = Number(process.env.PORT ?? 3001);
await app.listen(port);
console.log(`omniflow api on :${port}`);

// Indexer + keeper + schedules loop; every step is idempotent.
const TICK_MS = Number(process.env.TICK_MS ?? 15_000);
let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await payouts.tick();
  } finally {
    running = false;
  }
}, TICK_MS);
