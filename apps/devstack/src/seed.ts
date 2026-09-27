import type { Address, Hex } from "viem";
import { mintToken } from "@omniflow/devchain";
import { readDevMailbox } from "@omniflow/devmail";
import type { RunningStack } from "./stack.js";

/**
 * EMULATION ONLY. A ready demo: an organisation account 2-of-3 created through flow 1 over the HTTP API, exactly as the
 * cabinet does it, then 100 000 test USDC on it. People log in by these emails; codes arrive in the dev mailbox.
 */
export const DEMO = {
  org: "Demo DAO",
  operator: "ops@demo.test",
  approvers: ["anna@demo.test", "boris@demo.test", "vera@demo.test"],
  threshold: 2,
  usdc: 100_000_000_000n,
};

export interface DemoUser {
  email: string;
  did: string;
  wallet: Address;
  headers: Record<string, string>;
}

/** Logs in through the emulator's HTTP endpoints — code from the dev mailbox, as a person would. */
export async function emulatedLogin(stack: RunningStack, email: string): Promise<DemoUser> {
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(`${stack.urls.privy}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${path}: ${j.error}`);
    return j;
  };
  await post("/auth/email/start", { email });
  const code = (await readDevMailbox(stack.db, email))[0]!.subject.match(/\d{6}/)![0];
  const r = await post("/auth/email/verify", { email, code });
  return { email, did: r.user.did, wallet: r.user.wallet, headers: { authorization: `Bearer ${r.accessToken}`, "privy-id-token": r.identityToken } };
}

export async function emulatedSign(stack: RunningStack, u: DemoUser, typedData: unknown): Promise<Hex> {
  const r = await fetch(`${stack.urls.privy}/wallet/sign`, { method: "POST", headers: { "content-type": "application/json", authorization: u.headers.authorization! }, body: JSON.stringify({ kind: "typedData", typedData }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`sign: ${j.error}`);
  return j.signature;
}

async function api<T>(stack: RunningStack, u: DemoUser, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${stack.urls.api}${path}`, { method, headers: { "content-type": "application/json", ...u.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j as T;
}

export async function seedDemo(stack: RunningStack) {
  const ops = await emulatedLogin(stack, DEMO.operator);
  const approvers = await Promise.all(DEMO.approvers.map((e) => emulatedLogin(stack, e)));
  const setup = await api<{ id: string }>(stack, ops, "POST", "/org-setups", { name: DEMO.org, threshold: DEMO.threshold, approvers: approvers.map((a) => ({ email: a.email, weight: 1 })) });
  for (const a of approvers) await api(stack, a, "POST", `/org-setups/${setup.id}/join`);
  let last: { status: string; orgId: string; account: Address; typedData: unknown } | null = null;
  for (const a of approvers) {
    const s = await api<{ typedData: unknown }>(stack, a, "GET", `/org-setups/${setup.id}`);
    last = await api(stack, a, "POST", `/org-setups/${setup.id}/confirm`, { signature: await emulatedSign(stack, a, s.typedData) });
  }
  if (last?.status !== "deployed") throw new Error(`demo setup ended in ${last?.status}`);
  await mintToken(stack.chain.rpcUrl, stack.chain.token, last.account, DEMO.usdc);
  // the invitations of the seeding are noise in the mailbox — the demo starts clean
  await stack.db.query("DELETE FROM dev_mailbox");
  return { orgId: last.orgId, account: last.account };
}
