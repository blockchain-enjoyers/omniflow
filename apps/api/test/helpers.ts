import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestClient, http, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const here = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS = resolve(here, "../../../contracts");
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? "/root/.foundry/bin";

/** anvil's publicly known development mnemonic — test-only keys, never used on a real network. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const keyAt = (i: number): Hex => {
  const acc = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
  return `0x${Buffer.from(acc.getHdKey().privateKey!).toString("hex")}`;
};
export const DEPLOYER_KEY = keyAt(0);
export const SUBMITTER_KEY = keyAt(1);

export interface LocalStack {
  rpcUrl: string;
  anvil: ChildProcess;
  entryPoint: Address;
  validator: Address;
  token: Address;
  escrow: Address;
  account: Address;
  factory: Address;
}

export async function startLocalStack(approvers: Address[], threshold: number): Promise<LocalStack> {
  const port = 8600 + Math.floor(Math.random() * 300);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn(`${FOUNDRY_BIN}/anvil`, ["--port", String(port), "--silent", "--disable-code-size-limit"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  mkdirSync(resolve(CONTRACTS, "deployments"), { recursive: true });
  const out = `deployments/e2e-${port}.json`;
  execFileSync(
    `${FOUNDRY_BIN}/forge`,
    ["script", "script/LocalStack.s.sol", "--rpc-url", rpcUrl, "--private-key", DEPLOYER_KEY, "--broadcast", "--disable-code-size-limit", "--offline", "--non-interactive", "-q"],
    { cwd: CONTRACTS, env: { ...process.env, APPROVERS: approvers.join(","), THRESHOLD: String(threshold), OUT: out }, stdio: "pipe" },
  );
  const d = JSON.parse(readFileSync(resolve(CONTRACTS, out), "utf8"));
  return { rpcUrl, anvil, ...d };
}

export async function increaseTime(rpcUrl: string, seconds: number) {
  const c = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  await c.increaseTime({ seconds });
  await c.mine({ blocks: 1 });
}
