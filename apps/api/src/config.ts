import { getAddress, type Address, type Hex } from "viem";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

/** All secrets come from the environment / secret manager. See .env.example for the list. */
export function loadConfig() {
  return {
    port: Number(process.env.PORT ?? 3001),
    databaseUrl: need("DATABASE_URL"),
    chainId: Number(need("CHAIN_ID")),
    rpcUrl: need("RPC_URL"),
    entryPoint: getAddress(process.env.ENTRYPOINT ?? "0x0000000071727De22E5E9d8BAf0edAc6f37da032") as Address,
    submitterKey: need("SUBMITTER_PRIVATE_KEY") as Hex,
    claimKeyEncryptionKey: need("CLAIM_KEY_ENCRYPTION_KEY"),
    claimBaseUrl: need("CLAIM_BASE_URL"),
    tokenDecimals: Number(process.env.TOKEN_DECIMALS ?? 6),
    claimTip: BigInt(process.env.CLAIM_TIP_UNITS ?? "50000"),
    maxRowsPerBatch: Number(process.env.MAX_ROWS_PER_BATCH ?? 40),
    mailDir: process.env.MAIL_DIR ?? "./.mail",
    nodeEnv: process.env.NODE_ENV ?? "development",
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
