import { createPublicClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";

/**
 * LOCAL CHAIN ONLY (anvil, incl. forks). Test-money helpers for emulation and tests — never against a live RPC:
 * they rely on anvil_* methods that real nodes do not have.
 */
export async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount) returns (bool)",
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 allowance) returns (bool)",
]);

/**
 * Credits test tokens on anvil. MockUSDC: open mint. Circle FiatToken on a fork: Circle's own path — impersonate
 * masterMinter, configure a minter, mint. Nothing touches the live network: impersonation exists only in anvil.
 */
export async function mintToken(rpcUrl: string, token: Address, to: Address, amount: bigint) {
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const send = async (from: Address, data: Hex) => {
    await rpc(rpcUrl, "anvil_setBalance", [from, "0x56BC75E2D63100000"]);
    await rpc(rpcUrl, "anvil_impersonateAccount", [from]);
    const hash = await rpc(rpcUrl, "eth_sendTransaction", [{ from, to: token, data }]);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("mint reverted");
  };
  let master: Address | null = null;
  try {
    master = await pub.readContract({ address: token, abi: tokenAbi, functionName: "masterMinter" });
  } catch {
    master = null;
  }
  if (!master) return send("0x00000000000000000000000000000000000da0da", encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [to, amount] }));
  const minter = "0x00000000000000000000000000000000000da0da" as Address;
  await send(master, encodeFunctionData({ abi: tokenAbi, functionName: "configureMinter", args: [minter, amount] }));
  await send(minter, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [to, amount] }));
}

export async function setEthBalance(rpcUrl: string, who: Address, wei: bigint) {
  await rpc(rpcUrl, "anvil_setBalance", [who, `0x${wei.toString(16)}`]);
}

// ------------------------------------------------------------------ anvil + deployment of the contract stack

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

/** anvil's publicly known development mnemonic — test-only keys, never used on a real network. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const anvilKey = (i: number): Hex => {
  const acc = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
  return `0x${Buffer.from(acc.getHdKey().privateKey!).toString("hex")}`;
};
export const DEPLOYER_KEY = anvilKey(0);
export const SUBMITTER_KEY = anvilKey(1);
/** signs sponsorships for the emulated VerifyingPaymaster (test-only anvil key) */
export const PAYMASTER_SIGNER_KEY = anvilKey(2);

export interface DevStack {
  rpcUrl: string;
  chainId: number;
  anvil: ChildProcess;
  entryPoint: Address;
  validator: Address;
  token: Address;
  escrow: Address;
  account: Address;
  factory: Address;
  paymaster: Address;
}

export interface DevStackOptions {
  /** anvil fork of Arbitrum Sepolia with the deployed Kernel 0.3.1, validator and Circle USDC */
  fork?: boolean;
  forkUrl?: string;
  port?: number;
  /** local chain only: unix time of the first block — a demo history can then happen "in the past" */
  startTime?: number;
  contractsDir: string;
  foundryBin?: string;
  /** optional pre-made account (tests); the app creates its own accounts through flow 1 */
  approvers?: Address[];
  threshold?: number;
}

/** Starts anvil and deploys the stack with script/LocalStack.s.sol (from source) or script/ForkStack.s.sol (fork). */
export async function startDevStack(o: DevStackOptions): Promise<DevStack> {
  const bin = o.foundryBin ?? process.env.FOUNDRY_BIN ?? "/root/.foundry/bin";
  const port = o.port ?? 8600 + Math.floor(Math.random() * 300);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const args = o.fork ? ["--fork-url", o.forkUrl ?? "https://sepolia-rollup.arbitrum.io/rpc"] : ["--disable-code-size-limit", ...(o.startTime ? ["--timestamp", String(o.startTime)] : [])];
  const anvil = spawn(`${bin}/anvil`, ["--port", String(port), "--silent", ...args], { stdio: "ignore" });
  let chainId = 0;
  for (let i = 0; i < 150 && !chainId; i++) {
    try {
      chainId = Number(await rpc(rpcUrl, "eth_chainId", []));
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!chainId) throw new Error(`anvil did not start on ${rpcUrl}`);
  mkdirSync(resolve(o.contractsDir, "deployments"), { recursive: true });
  const out = `deployments/stack-${port}.json`;
  const approvers = o.approvers ?? [];
  execFileSync(
    `${bin}/forge`,
    ["script", o.fork ? "script/ForkStack.s.sol" : "script/LocalStack.s.sol", "--rpc-url", rpcUrl, "--private-key", DEPLOYER_KEY, "--broadcast", "--disable-code-size-limit", "--offline", "--non-interactive", "-q"],
    {
      cwd: o.contractsDir,
      env: { ...process.env, ...(approvers.length ? { APPROVERS: approvers.join(","), THRESHOLD: String(o.threshold ?? 1) } : {}), PAYMASTER_SIGNER: privateKeyToAccount(PAYMASTER_SIGNER_KEY).address, OUT: out },
      stdio: "pipe",
    },
  );
  const d = JSON.parse(readFileSync(resolve(o.contractsDir, out), "utf8"));
  return { rpcUrl, chainId, anvil, ...d } as DevStack;
}

// ------------------------------------------------------------------ a real ERC-4337 bundler on the local chain

import { createRequire } from "node:module";

/** anvil keys 3 and 4: the bundler's executor and utility accounts (test-only, public mnemonic) */
export const BUNDLER_EXECUTOR_KEY = anvilKey(3);
export const BUNDLER_UTILITY_KEY = anvilKey(4);

export interface LocalBundler {
  url: string;
  process: ChildProcess;
}

/**
 * Pimlico's open-source bundler Alto (GPL-3.0; run as a separate process, not linked) against anvil. `safeMode` is meant
 * to enforce ERC-7562 through debug_traceCall; in 0.0.21 it fails for EntryPoint v0.7 before any rule is applied
 * (revert data `DelegateAndRevert` not in its ABI), so it is off by default.
 */
/**
 * expirationCheck: false when the chain clock is deliberately not the wall clock (a demo history in the past, a chain
 * moved forward): Alto compares validAfter/validUntil with Date.now(), the paymaster and the contracts use block time.
 */
export async function startAlto(rpcUrl: string, entryPoint: Address, o: { port?: number; safeMode?: boolean; expirationCheck?: boolean } = {}): Promise<LocalBundler> {
  // the package exports only "."; the CLI sits next to it (package.json "bin": ./esm/cli/alto.js)
  const bin = resolve(dirname(createRequire(import.meta.url).resolve("@pimlico/alto")), "cli/alto.js");
  const port = o.port ?? 4300 + Math.floor(Math.random() * 600);
  const args = [bin, "--entrypoints", entryPoint, "--executor-private-keys", BUNDLER_EXECUTOR_KEY, "--utility-private-key", BUNDLER_UTILITY_KEY, "--rpc-url", rpcUrl, "--port", String(port), "--safe-mode", String(o.safeMode ?? false), "--expiration-check", String(o.expirationCheck ?? true), "--log-level", process.env.ALTO_LOG_LEVEL ?? "warn"];
  const proc = spawn(process.execPath, args, { stdio: ["ignore", process.env.ALTO_LOG_FILE ? "pipe" : "ignore", "pipe"] });
  if (process.env.ALTO_LOG_FILE) {
    const { createWriteStream } = await import("node:fs");
    const out = createWriteStream(process.env.ALTO_LOG_FILE);
    proc.stdout?.pipe(out);
    proc.stderr?.pipe(out);
  }
  let err = "";
  proc.stderr?.on("data", (d) => (err += d.toString()));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try {
      await rpc(url, "eth_supportedEntryPoints", []);
      return { url, process: proc };
    } catch {
      if (proc.exitCode !== null) throw new Error(`alto exited: ${err.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  proc.kill();
  throw new Error(`alto did not start on ${url}: ${err.slice(-2000)}`);
}
