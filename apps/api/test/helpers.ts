import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
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
/** signs sponsorships for the emulated VerifyingPaymaster (test-only anvil key) */
export const PAYMASTER_SIGNER_KEY = keyAt(2);

export interface LocalStack {
  rpcUrl: string;
  anvil: ChildProcess;
  entryPoint: Address;
  validator: Address;
  token: Address;
  escrow: Address;
  account: Address;
  factory: Address;
  paymaster: Address;
}

/** STACK=fork → an anvil fork of Arbitrum Sepolia with the deployed Kernel 0.3.1, validator and Circle USDC. */
export const FORK = process.env.STACK === "fork";
const FORK_URL = process.env.FORK_URL ?? "https://sepolia-rollup.arbitrum.io/rpc";

export async function startLocalStack(approvers: Address[] = [], threshold = 1): Promise<LocalStack> {
  const port = 8600 + Math.floor(Math.random() * 300);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const args = FORK ? ["--fork-url", FORK_URL] : ["--disable-code-size-limit"];
  const anvil = spawn(`${FOUNDRY_BIN}/anvil`, ["--port", String(port), "--silent", ...args], { stdio: "ignore" });
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
    ["script", FORK ? "script/ForkStack.s.sol" : "script/LocalStack.s.sol", "--rpc-url", rpcUrl, "--private-key", DEPLOYER_KEY, "--broadcast", "--disable-code-size-limit", "--offline", "--non-interactive", "-q"],
    { cwd: CONTRACTS, env: { ...process.env, ...(approvers.length ? { APPROVERS: approvers.join(","), THRESHOLD: String(threshold) } : {}), PAYMASTER_SIGNER: privateKeyToAccount(PAYMASTER_SIGNER_KEY).address, OUT: out }, stdio: "pipe" },
  );
  const d = JSON.parse(readFileSync(resolve(CONTRACTS, out), "utf8"));
  const stack = { rpcUrl, anvil, ...d } as LocalStack;
  if (FORK && approvers.length) await fundAccount(stack, stack.account);
  return stack;
}

/** Gas prefund (until the paymaster pays) and 1 000 000 test USDC for an organisation account. */
export async function fundAccount(stack: LocalStack, account: Address, usdc = 1_000_000_000_000n, eth = true) {
  if (eth) await rpc(stack.rpcUrl, "anvil_setBalance", [account, "0x8AC7230489E80000"]);
  await mintToken(stack, account, usdc);
}

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

/**
 * Credits test tokens. Local stack: MockUSDC.mint. Fork: Circle's own path on the FORK only —
 * impersonate masterMinter, configure a minter, mint. Nothing touches the live network.
 */
export async function mintToken(stack: LocalStack, to: Address, amount: bigint) {
  const pub = createPublicClient({ transport: http(stack.rpcUrl) });
  const mintAbi = parseAbi(["function mint(address to, uint256 amount) returns (bool)", "function masterMinter() view returns (address)", "function configureMinter(address minter, uint256 allowance) returns (bool)"]);
  const send = async (from: Address, data: Hex) => {
    const hash = await rpc(stack.rpcUrl, "eth_sendTransaction", [{ from, to: stack.token, data }]);
    await pub.waitForTransactionReceipt({ hash });
  };
  if (!FORK) {
    const deployer = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 0 }).address;
    await rpc(stack.rpcUrl, "anvil_impersonateAccount", [deployer]);
    return send(deployer, encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [to, amount] }));
  }
  const master = await pub.readContract({ address: stack.token, abi: mintAbi, functionName: "masterMinter" });
  const minter = "0x00000000000000000000000000000000000da0da" as Address;
  for (const a of [master, minter]) {
    await rpc(stack.rpcUrl, "anvil_setBalance", [a, "0x56BC75E2D63100000"]);
    await rpc(stack.rpcUrl, "anvil_impersonateAccount", [a]);
  }
  await send(master, encodeFunctionData({ abi: mintAbi, functionName: "configureMinter", args: [minter, amount] }));
  await send(minter, encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [to, amount] }));
}

export async function increaseTime(rpcUrl: string, seconds: number) {
  const c = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
  await c.increaseTime({ seconds });
  await c.mine({ blocks: 1 });
}

// ------------------------------------------------------------------ login via the Privy EMULATOR

import type pg from "pg";
import { readDevMailbox } from "@omniflow/devmail";
import type { PrivyEmulator } from "@omniflow/privy-emulator";

export interface TestUser {
  email: string;
  did: string;
  wallet: Address;
  headers: Record<string, string>;
  signTypedData(td: unknown): Promise<Hex>;
  signHash(hash: Hex): Promise<Hex>;
}

/** Logs a user in through the emulator exactly as the UI does: code by email → tokens. */
export async function loginAs(emu: PrivyEmulator, db: pg.Pool, email: string): Promise<TestUser> {
  await emu.startEmailLogin(email);
  const code = (await readDevMailbox(db, email))[0]!.subject.match(/\d{6}/)![0];
  const r = await emu.verifyEmailLogin(email, code);
  return {
    email: r.user.email,
    did: r.user.did,
    wallet: r.user.wallet as Address,
    headers: { authorization: `Bearer ${r.accessToken}`, "privy-id-token": r.identityToken },
    signTypedData: (td) => emu.sign(r.user.did, { kind: "typedData", typedData: td }),
    signHash: (hash) => emu.sign(r.user.did, { kind: "message", raw: hash }),
  };
}
