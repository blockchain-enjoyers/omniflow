import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { createPublicClient, createWalletClient, erc20Abi, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { claimEscrowAbi, DepositStatus, kernelInitData, parseClaimLink, signClaim } from "@omniflow/shared";
import { readDevMailbox } from "@omniflow/devmail";
import { PrivyEmulator } from "@omniflow/privy-emulator";
import { createDb, type Db } from "../src/db/db.js";
import { compose } from "../src/compose.js";
import { PrivyVerifier } from "../src/auth/privy.js";
import type { ChainClient } from "../src/chain/chain.js";
import type { PayoutService } from "../src/payouts/service.js";
import { FORK, fundAccount, increaseTime, loginAs, PAYMASTER_SIGNER_KEY, startLocalStack, SUBMITTER_KEY, type LocalStack, type TestUser } from "./helpers.js";

/**
 * The whole sender side, end to end on a local chain (or a Sepolia fork with STACK=fork), with Privy EMULATED:
 * setup of the organisation account (flow 1) → roles → CSV → review → 2-of-3 → transfers + escrow → claim →
 * details form → top-up batch → revoke → auto-refund → receipt, notifications and audit log.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const CHAIN = FORK ? 421614 : 31337;

describe.skipIf(!DB_URL)("sender side e2e (emulated Privy)", () => {
  let stack: LocalStack;
  let db: Db;
  let emu: PrivyEmulator;
  let chain: ChainClient;
  let payouts: PayoutService;
  let app: Awaited<ReturnType<typeof compose>>["app"];
  let api: ReturnType<typeof request>;
  let ops: TestUser;
  let a1: TestUser;
  let a2: TestUser;
  let a3: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let account: Address;
  const alice = privateKeyToAccount(generatePrivateKey()).address;
  const bob = privateKeyToAccount(generatePrivateKey()).address;

  const balance = (who: Address) => chain.pub.readContract({ address: stack.token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const inbox = async (email: string) => readDevMailbox(db, email);

  beforeAll(async () => {
    stack = await startLocalStack();
    db = createDb(DB_URL!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    emu = new PrivyEmulator(db, { appId: "omniflow-test", walletEncryptionKey: randomBytes(32).toString("hex") });
    await emu.init();
    const c = await compose({
      db,
      chain: { chainId: CHAIN, rpcUrl: stack.rpcUrl, entryPoint: stack.entryPoint, submitterKey: SUBMITTER_KEY },
      deployment: { factory: stack.factory, validator: stack.validator, escrow: stack.escrow, token: stack.token },
      privy: { verifier: await PrivyVerifier.fromPem(emu.verificationKey(), "omniflow-test") },
      claimKeyEncryptionKey: randomBytes(32).toString("hex"),
      urls: { app: "http://app.local/", claim: "http://claim.local/", form: "http://app.local/" },
      devEndpoints: true,
      paymaster: { local: { address: stack.paymaster, signerKey: PAYMASTER_SIGNER_KEY } },
    });
    ({ app, chain, payouts } = c);
    await app.init();
    api = request(app.getHttpServer());
    const users = await Promise.all(["ops@acme.test", "a1@acme.test", "a2@acme.test", "a3@acme.test", "eve@evil.test"].map((e) => loginAs(emu, db, e)));
    [ops, a1, a2, a3, outsider] = [users[0]!, users[1]!, users[2]!, users[3]!, users[4]!];
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    stack?.anvil.kill();
  });

  /** One approver signs Approve(hash), the next signs the final userOpHash — through the API, as the UI does. */
  async function approveAndSubmit(batchId: string, first = a1, second = a2) {
    const s1 = await api.get(`/batches/${batchId}/next-step`).set(first.headers).expect(200);
    expect(s1.body.step).toBe("approve");
    await api.post(`/batches/${batchId}/approvals`).set(first.headers).send({ signature: await first.signTypedData(s1.body.typedData) }).expect(201);
    const s2 = await api.get(`/batches/${batchId}/next-step`).set(second.headers).expect(200);
    expect(s2.body.step).toBe("final");
    const fin = await api.post(`/batches/${batchId}/final`).set(second.headers).send({ signature: await second.signHash(s2.body.userOpHash) }).expect(201);
    await payouts.settleBatch(batchId);
    return fin.body.txHash as Hex;
  }

  // ------------------------------------------------------------------ auth

  it("everything except claims and forms requires a Privy login", async () => {
    await api.get("/me").expect(401);
    await api.get("/me").set({ authorization: "Bearer not-a-jwt" }).expect(401);
    const me = await api.get("/me").set(ops.headers).expect(200);
    expect(me.body.user.email).toBe("ops@acme.test");
    expect(me.body.user.wallet).toBe(ops.wallet);
  });

  // ---------------------------------------------------------------- flow 1

  let setupId: string;

  it("flow 1: the creator names approvers by email; invitations go out", async () => {
    const r = await api
      .post("/org-setups")
      .set(ops.headers)
      .send({ name: "Acme DAO", threshold: 2, approvers: [a1, a2, a3].map((a) => ({ email: a.email, weight: 1 })) })
      .expect(201);
    setupId = r.body.id;
    expect(r.body.status).toBe("collecting");
    expect((await inbox(a2.email))[0]!.subject).toBe("Acme DAO: вас назначили подтверждающим выплат");
  });

  it("only named approvers can join; joining records their embedded wallet", async () => {
    await api.post(`/org-setups/${setupId}/join`).set(outsider.headers).expect(403);
    await api.post(`/org-setups/${setupId}/join`).set(a1.headers).expect(201);
    await api.post(`/org-setups/${setupId}/join`).set(a2.headers).expect(201);
    const r = await api.post(`/org-setups/${setupId}/join`).set(a3.headers).expect(201);
    expect(r.body.status).toBe("confirming");
    account = r.body.account;
    const salt = (await db.query("SELECT salt FROM org_setups WHERE id=$1", [setupId])).rows[0].salt;
    const initData = kernelInitData(stack.validator, { threshold: 2, approvers: [a1, a2, a3].map((a) => ({ address: a.wallet, weight: 1 })) });
    expect(await chain.accountAddress(stack.factory, initData, salt)).toBe(account);
  });

  it("each approver confirms the set with their own wallet; someone else's signature is refused", async () => {
    const s = await api.get(`/org-setups/${setupId}`).set(a1.headers).expect(200);
    expect(s.body.typedData.message.approvers).toContain(a1.wallet);
    await api.post(`/org-setups/${setupId}/confirm`).set(a1.headers).send({ signature: await a2.signTypedData(s.body.typedData) }).expect(403);
    await api.post(`/org-setups/${setupId}/confirm`).set(a1.headers).send({ signature: await a1.signTypedData(s.body.typedData) }).expect(201);
    await api.post(`/org-setups/${setupId}/confirm`).set(a2.headers).send({ signature: await a2.signTypedData(s.body.typedData) }).expect(201);
    const last = await api.post(`/org-setups/${setupId}/confirm`).set(a3.headers).send({ signature: await a3.signTypedData(s.body.typedData) }).expect(201);
    expect(last.body.status).toBe("deployed");
    orgId = last.body.orgId;
    expect(await chain.pub.getCode({ address: account })).not.toBe("0x");
  });

  it("the deployed account holds exactly this set on chain; roles are assigned", async () => {
    const onChain = await chain.readApprovers(stack.validator, account, [a1, a2, a3, outsider].map((u) => u.wallet));
    expect(onChain.threshold).toBe(2);
    expect(onChain.weights.map((w) => w.weight)).toEqual([1, 1, 1, 0]);
    const me = await api.get("/me").set(ops.headers).expect(200);
    expect([...me.body.orgs[0].roles].sort()).toEqual(["admin", "operator"]);
    const members = await api.get(`/orgs/${orgId}/members`).set(a1.headers).expect(200);
    expect(members.body.filter((m: { roles: string[] }) => m.roles.includes("approver"))).toHaveLength(3);
    await fundAccount(stack, account, 1_000_000_000_000n, false); // USDC only: gas is paid by the paymaster
  });

  it("roles are enforced: approvers cannot create payouts, outsiders see nothing", async () => {
    await api.post(`/orgs/${orgId}/payouts`).set(a1.headers).send({ title: "x", csv: "name,email,address,chain_id,amount\n" }).expect(403);
    await api.get(`/orgs/${orgId}`).set(outsider.headers).expect(403);
    await api.post(`/orgs/${orgId}/members`).set(a1.headers).send({ email: "x@y.z" }).expect(403);
  });

  // --------------------------------------------------------------- payouts

  let payoutId: string;
  let batchId: string;

  it("operator uploads CSV (with categories) and gets the review summary", async () => {
    const csv = [
      "name,email,address,chain_id,amount,category",
      `Alice,,${alice},${CHAIN},1000,grants`,
      `Bob,bob@example.test,${bob},${CHAIN},2000.5,contractors`,
      `Carol,carol@example.test,,${CHAIN},3000,grants`,
      `Dave,,,${CHAIN},10,grants`,
      `Eve,,${alice},1,5,grants`,
    ].join("\n");
    payoutId = (await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "September grants", csv }).expect(201)).body.id;
    const r = await api.get(`/payouts/${payoutId}/review`).set(ops.headers).expect(200);
    expect(r.body.summary.total).toBe("6000500000");
    expect(r.body.summary.notSent.map((n: { reason: string }) => n.reason).sort()).toEqual(["no-address-no-email", "other-chain"]);
  });

  it("freezing notifies every approver", async () => {
    batchId = (await api.post(`/payouts/${payoutId}/batches`).set(ops.headers).expect(201)).body.id;
    for (const a of [a1, a2, a3]) expect((await inbox(a.email))[0]!.subject).toMatch(/ждёт вашего подтверждения/);
  });

  it("an approver cannot pass off someone else's signature; operators cannot approve", async () => {
    const s = await api.get(`/batches/${batchId}/next-step`).set(a1.headers).expect(200);
    await api.post(`/batches/${batchId}/approvals`).set(a1.headers).send({ signature: await a2.signTypedData(s.body.typedData) }).expect(403);
    // and nothing was recorded: a2 has still not approved
    expect((await api.get(`/batches/${batchId}/next-step`).set(a2.headers).expect(200)).body.step).toBe("approve");
    await api.get(`/batches/${batchId}/next-step`).set(ops.headers).expect(403);
  });

  it("2 of 3 approve → EOAs paid, escrow funded; approvers get the 'sent' email", async () => {
    const before = await balance(account);
    await approveAndSubmit(batchId);
    expect(await balance(alice)).toBe(1_000_000_000n);
    expect(await balance(bob)).toBe(2_000_500_000n);
    expect(await balance(account)).toBe(before - 6_000_500_000n - 50_000n);
    expect((await inbox(a3.email))[0]!.subject).toMatch(/с аккаунта ушло/);
    const bal = await api.get(`/orgs/${orgId}/balance`).set(ops.headers).expect(200);
    expect(bal.body.reservedInEscrow).toBe("3000000000"); // still the sender's money
  });

  it("Carol claims by the emailed link into a fresh wallet", async () => {
    const mail = (await inbox("carol@example.test")).find((m) => m.subject.includes("вам отправлен платёж"))!;
    const link = parseClaimLink(mail.body.match(/http:\/\/claim\.local\/#\S+/)![0]);
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = await signClaim(link, wallet, deadline);
    const relayerBefore = await balance(chain.submitter);
    const r = await api.post("/claims").send({ escrow: link.escrow, depositId: link.depositId, recipient: wallet, deadline: deadline.toString(), signature }).expect(201);
    expect(r.body.ok).toBe(true);
    expect(await balance(wallet)).toBe(3_000_000_000n);
    expect((await balance(chain.submitter)) - relayerBefore).toBe(50_000n);
    await api.post("/claims").send({ escrow: link.escrow, depositId: link.depositId, recipient: wallet, deadline: deadline.toString(), signature }).expect(400);
    await payouts.pollEscrow(orgId);
    const receipt = await api.get(`/payouts/${payoutId}/receipt`).set(ops.headers).expect(200);
    expect(receipt.body.rows.find((x: { name: string }) => x.name === "Carol").status).toBe("claimed");
  });

  it("details form: Dave fills in his address; a top-up batch pays him after approval", async () => {
    const links = (await api.post(`/payouts/${payoutId}/forms`).set(ops.headers).send({}).expect(201)).body;
    const dave = links.find((l: { name: string }) => l.name === "Dave");
    expect(dave.emailed).toBe(false); // no email known — the operator passes the link on
    const token = dave.link.split("#/form/")[1];
    const view = await api.get(`/forms/${token}`).expect(200);
    expect(view.body).toMatchObject({ org: "Acme DAO", name: "Dave", filled: false });
    const daveWallet = privateKeyToAccount(generatePrivateKey()).address;
    await api.post(`/forms/${token}`).send({ address: "0x123" }).expect(400);
    await api.post(`/forms/${token}`).send({ address: daveWallet }).expect(201);

    const top = (await api.post(`/payouts/${payoutId}/batches`).set(ops.headers).expect(201)).body;
    expect(top.manifest.rows).toHaveLength(1);
    await approveAndSubmit(top.id, a3, a1);
    expect(await balance(daveWallet)).toBe(10_000_000n);
    await api.post(`/forms/${token}`).send({ address: alice }).expect(409); // once paid, details are locked
  });

  it("claim works without Omniflow: link + any RPC + own wallet", async () => {
    const p = await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "solo", csv: `name,email,address,chain_id,amount\nZed,zed@example.test,,${CHAIN},7` }).expect(201);
    const b = await api.post(`/payouts/${p.body.id}/batches`).set(ops.headers).expect(201);
    await approveAndSubmit(b.body.id, a2, a3);
    const link = parseClaimLink((await inbox("zed@example.test"))[0]!.body.match(/http:\/\/claim\.local\/#\S+/)![0]);
    const self = privateKeyToAccount(SUBMITTER_KEY);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const w = createWalletClient({ account: self, transport: http(stack.rpcUrl), chain: { id: CHAIN, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [stack.rpcUrl] } } } });
    const h = await w.writeContract({ address: link.escrow, abi: claimEscrowAbi, functionName: "claim", args: [link.depositId, self.address, deadline, await signClaim(link, self.address, deadline)] });
    const pub = createPublicClient({ transport: http(stack.rpcUrl) });
    expect((await pub.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    expect((await pub.readContract({ address: link.escrow, abi: claimEscrowAbi, functionName: "getDeposit", args: [link.depositId] })).status).toBe(DepositStatus.Claimed);
  });

  it("revoke goes through the same 2 of 3 and returns money to the account", async () => {
    const p = await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "to revoke", csv: `name,email,address,chain_id,amount\nYan,yan@example.test,,${CHAIN},11` }).expect(201);
    await approveAndSubmit((await api.post(`/payouts/${p.body.id}/batches`).set(ops.headers).expect(201)).body.id);
    const before = await balance(account);
    const rv = await api.post(`/payouts/${p.body.id}/revoke`).set(ops.headers).send({ rows: ["row-2"] }).expect(201);
    await approveAndSubmit(rv.body.id, a2, a3);
    await payouts.pollEscrow(orgId);
    expect(await balance(account)).toBe(before + 11_050_000n);
    expect((await api.get(`/payouts/${p.body.id}/receipt`).set(ops.headers).expect(200)).body.rows[0].status).toBe("refunded");
  });

  it("settings: the admin sets a default auto-refund; the keeper returns expired deposits", async () => {
    await api.patch(`/orgs/${orgId}/settings`).set(a1.headers).send({ autoRefundDays: 1 }).expect(403);
    await api.patch(`/orgs/${orgId}/settings`).set(ops.headers).send({ autoRefundDays: 1 }).expect(200);
    const p = await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "expiring", csv: `name,email,address,chain_id,amount\nXia,xia@example.test,,${CHAIN},13` }).expect(201);
    expect((await api.get(`/payouts/${p.body.id}/review`).set(ops.headers).expect(200)).body.autoRefundDays).toBe(1);
    await approveAndSubmit((await api.post(`/payouts/${p.body.id}/batches`).set(ops.headers).expect(201)).body.id);
    const before = await balance(account);
    await increaseTime(stack.rpcUrl, 2 * 86_400);
    expect((await payouts.runKeeper(orgId, new Date(Date.now() + 2 * 86_400_000))).refunded).toBe(1);
    expect(await balance(account)).toBe(before + 13_050_000n);
    expect((await api.get(`/payouts/${p.body.id}/receipt`).set(ops.headers).expect(200)).body.payout.status).toBe("closed");
  });

  it("admin invites an operator; the invite activates on their first login", async () => {
    await api.post(`/orgs/${orgId}/members`).set(ops.headers).send({ email: "ops2@acme.test" }).expect(201);
    const ops2 = await loginAs(emu, db, "ops2@acme.test");
    await api.get("/me").set(ops2.headers).expect(200);
    await api.get(`/orgs/${orgId}/payouts`).set(ops2.headers).expect(200);
  });

  it("the audit log records who did what", async () => {
    const log = (await api.get(`/orgs/${orgId}/audit`).set(a1.headers).expect(200)).body;
    const actions = log.map((l: { action: string }) => l.action);
    for (const a of ["org.deployed", "payout.created", "batch.frozen", "batch.approved", "batch.submitted", "forms.created", "settings.updated", "member.invited"]) expect(actions).toContain(a);
    expect(log.find((l: { action: string }) => l.action === "batch.frozen").actor).toBe("ops@acme.test");
  });

  it("dev mailbox is served (DEV_ENDPOINTS on in this test)", async () => {
    const r = await api.get("/dev/mailbox").query({ to: "carol@example.test" }).expect(200);
    expect(r.body.length).toBeGreaterThan(0);
  });

  it("the organisation never needed ETH — every operation was sponsored by the paymaster", async () => {
    expect(await chain.pub.getBalance({ address: account })).toBe(0n);
  });

  it("manual close keeps unexecuted rows in the report", async () => {
    await api.post(`/payouts/${payoutId}/close`).set(ops.headers).expect(201);
    const r = await api.get(`/payouts/${payoutId}/receipt`).set(ops.headers).expect(200);
    expect(r.body.payout.status).toBe("closed");
    expect(r.body.rows.filter((x: { executed: boolean }) => !x.executed).map((x: { name: string }) => x.name)).toEqual(["Eve"]);
  });
});
