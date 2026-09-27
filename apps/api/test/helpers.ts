import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestClient, http, type Address, type Hex } from "viem";
import { DEPLOYER_KEY, mintToken as devMint, PAYMASTER_SIGNER_KEY, startAlto, startDevStack, SUBMITTER_KEY, type DevStack } from "@omniflow/devchain";
import express from "express";
import type { Server } from "node:http";
import { zerodevEmulator } from "@omniflow/zerodev-emulator";
import { foundry } from "viem/chains";

const here = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS = resolve(here, "../../../contracts");
export { DEPLOYER_KEY, SUBMITTER_KEY, PAYMASTER_SIGNER_KEY };

export type LocalStack = DevStack;

/** STACK=fork → an anvil fork of Arbitrum Sepolia with the deployed Kernel 0.3.1, validator and Circle USDC. */
export const FORK = process.env.STACK === "fork";

export async function startLocalStack(approvers: Address[] = [], threshold = 1): Promise<LocalStack> {
  const stack = await startDevStack({ fork: FORK, forkUrl: process.env.FORK_URL, contractsDir: CONTRACTS, approvers, threshold });
  if (FORK && approvers.length) await fundAccount(stack, stack.account);
  return stack;
}

/**
 * AA=zerodev → operations go the way they will with ZeroDev: through a bundler RPC and zd_sponsorUserOperation.
 * Here that RPC is the ZeroDev EMULATOR in front of a real bundler (Alto, safe mode = ERC-7562 rules) on the same anvil.
 */
export const HOSTED_AA = process.env.AA === "zerodev";

export async function startZeroDevEmulator(stack: LocalStack) {
  // Alto 0.0.21 safe mode fails on v0.7 before applying any rule (it cannot decode EntryPoint's DelegateAndRevert);
  // ERC-7562 for our side is checked by test/erc7562.ts instead. ALTO_SAFE_MODE=1 to try again with a newer Alto.
  const alto = await startAlto(stack.rpcUrl, stack.entryPoint, { safeMode: process.env.ALTO_SAFE_MODE === "1" });
  const app = express();
  app.use(zerodevEmulator({ bundlerUrl: alto.url, rpcUrl: stack.rpcUrl, paymaster: stack.paymaster, paymasterSignerKey: PAYMASTER_SIGNER_KEY }));
  const server = await new Promise<Server>((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, stop: () => { server.close(); alto.process.kill(); } };
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

/** Credits test tokens on anvil (MockUSDC or Circle USDC on a fork) — see @omniflow/devchain. */
export async function mintToken(stack: LocalStack, to: Address, amount: bigint) {
  await devMint(stack.rpcUrl, stack.token, to, amount);
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
