import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { createPublicClient, createWalletClient, erc20Abi, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { claimEscrowAbi, DepositStatus, kernelInitData, parseClaimLink, signClaim } from "@omniflow/shared";
import { readDevMailbox } from "@omniflow/devmail";
import { PrivyEmulator } from "@omniflow/privy-emulator";
import { onrampEmulator } from "@omniflow/onramp-emulator";
import express from "express";
import type { Server } from "node:http";
import { createDb, type Db } from "../src/db/db.js";
import { compose } from "../src/compose.js";
import { Monitor } from "../src/ops/monitor.js";
import { PrivyVerifier } from "../src/auth/privy.js";
import type { ChainClient } from "../src/chain/chain.js";
import type { PayoutService } from "../src/payouts/service.js";
import { checkAccountValidation } from "./erc7562.js";
import { FORK, fundAccount, HOSTED_AA, increaseTime, loginAs, PAYMASTER_SIGNER_KEY, startLocalStack, startZeroDevEmulator, SUBMITTER_KEY, type LocalStack, type TestUser } from "./helpers.js";

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
  let onrampServer: Server;
  let zerodev: Awaited<ReturnType<typeof startZeroDevEmulator>> | undefined;
  let lists: Awaited<ReturnType<typeof compose>>["lists"];
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
    const onApp = express();
    onrampServer = await new Promise<Server>((ok) => {
      const srv = onApp.listen(0, () => ok(srv));
    });
    const onUrl = `http://127.0.0.1:${(onrampServer.address() as { port: number }).port}`;
    onApp.use(onrampEmulator({ publicUrl: onUrl, rpcUrl: stack.rpcUrl, token: stack.token, decimals: 6, feePercent: 1.75 }));
    if (HOSTED_AA) zerodev = await startZeroDevEmulator(stack);
    const c = await compose({
      db,
      // tiny log ranges: every claim and refund below reaches the API through the chunked indexer
      chain: { chainId: CHAIN, rpcUrl: stack.rpcUrl, entryPoint: stack.entryPoint, submitterKey: SUBMITTER_KEY, bundlerUrl: zerodev?.url, logChunkBlocks: 5 },
      deployment: { factory: stack.factory, validator: stack.validator, escrow: stack.escrow, token: stack.token },
      privy: { verifier: await PrivyVerifier.fromPem(emu.verificationKey(), "omniflow-test") },
      claimKeyEncryptionKey: randomBytes(32).toString("hex"),
      urls: { app: "http://app.local/", claim: "http://claim.local/", form: "http://app.local/" },
      devEndpoints: true,
      paymaster: zerodev ? { zerodev: { url: zerodev.url } } : { local: { address: stack.paymaster, signerKey: PAYMASTER_SIGNER_KEY } },
      onramp: { emulatorUrl: onUrl },
      trustProxy: 1, // as behind one load balancer: the client address comes from X-Forwarded-For
    });
    ({ app, chain, payouts, lists } = c);
    await app.init();
    api = request(app.getHttpServer());
    const users = await Promise.all(["ops@acme.test", "a1@acme.test", "a2@acme.test", "a3@acme.test", "eve@evil.test"].map((e) => loginAs(emu, db, e)));
    [ops, a1, a2, a3, outsider] = [users[0]!, users[1]!, users[2]!, users[3]!, users[4]!];
  });

  afterAll(async () => {
    onrampServer?.close();
    zerodev?.stop();
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
    expect((await inbox(a2.email))[0]!.subject).toBe("Acme DAO: you have been named a payout approver");
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

  it("a payout needs a title and rows; CSV problems come back line by line; the preview saves nothing", async () => {
    const csv = `name,amount,address\nAlice,10,${alice}`;
    expect((await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "  ", csv }).expect(400)).body.error).toBe("give the payout a title");
    expect((await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "x", csv: "name,amount\n" }).expect(400)).body.details.problems[0].message).toMatch(/no rows/);
    const bad = await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "x", csv: `Name;Amount;Wallet\nAlice;1,500;${alice}\nBob;5;0x12` }).expect(400);
    expect(bad.body.details.problems.map((p: { line: number; column: string }) => [p.line, p.column])).toEqual([[2, "amount"], [3, "address"]]);
    const before = (await api.get(`/orgs/${orgId}/payouts`).set(ops.headers).expect(200)).body.length;
    const pv = (await api.post(`/orgs/${orgId}/payouts/preview`).set(ops.headers).send({ csv: `\uFEFFAmount;Name;Email\n1 500,50;Zoe;zoe@example.test\n3;Yan;` }).expect(201)).body;
    expect(pv.errors).toEqual([]);
    expect(pv.total).toBe("1503500000");
    expect(pv.rows.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([["Zoe", "ready"], ["Yan", "waiting_details"]]);
    expect((await api.get(`/orgs/${orgId}/payouts`).set(ops.headers).expect(200)).body.length).toBe(before); // nothing created
    await api.post(`/orgs/${orgId}/payouts/preview`).set(a1.headers).send({ csv }).expect(403); // operators only
    const manual = await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "typed", rows: [{ name: "Kim", address: alice, amount: "2.5" }] }).expect(201);
    expect((await api.get(`/payouts/${manual.body.id}/receipt`).set(ops.headers).expect(200)).body.rows[0]).toMatchObject({ name: "Kim", amount: "2500000", status: "ready" });
    await api.post(`/payouts/${manual.body.id}/close`).set(ops.headers).expect(201); // keep the rest of the story unchanged
  });

  it("freezing notifies every approver", async () => {
    batchId = (await api.post(`/payouts/${payoutId}/batches`).set(ops.headers).expect(201)).body.id;
    for (const a of [a1, a2, a3]) expect((await inbox(a.email))[0]!.subject).toMatch(/waiting for your approval/);
  });

  it("the approver's home lists what waits for their signature; the batch shows who has signed", async () => {
    const mine = (await api.get("/me/approvals").set(a1.headers).expect(200)).body;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ batchId, org: "Acme DAO", title: "September grants", total: "6000500000" });
    expect((await api.get("/me/approvals").set(ops.headers).expect(200)).body).toEqual([]); // not an approver
    const b = (await api.get(`/payouts/${payoutId}/batches`).set(ops.headers).expect(200)).body[0];
    expect(b).toMatchObject({ threshold: 2, signedWeight: 0 });
    expect(b.signers.map((s: { email: string }) => s.email).sort()).toEqual([a1.email, a2.email, a3.email].sort());
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
    expect((await inbox(a3.email))[0]!.subject).toMatch(/left the account/);
    const bal = await api.get(`/orgs/${orgId}/balance`).set(ops.headers).expect(200);
    expect(bal.body.reservedInEscrow).toBe("3000000000"); // still the sender's money
  });

  it("ERC-7562: our side of validation (Kernel + WeightedECDSAValidator) keeps to the bundler storage and opcode rules", async () => {
    const tx = (await db.query(`SELECT tx_hash FROM batches WHERE id=$1`, [batchId])).rows[0].tx_hash as Hex;
    const report = await checkAccountValidation(stack.rpcUrl, tx, stack.entryPoint, account);
    if (process.env.ERC7562_REPORT) console.log(JSON.stringify(report, null, 2));
    expect(report.foreignAccesses.length).toBeGreaterThan(0); // the validator does read and write its own storage
    expect(report.violations).toEqual([]);
    // negative control: the same trace judged against another address must show violations
    const control = await checkAccountValidation(stack.rpcUrl, tx, stack.entryPoint, account, alice);
    expect(control.violations.length).toBe(report.foreignAccesses.length);
  });

  it("Carol claims by the emailed link into a fresh wallet", async () => {
    const mail = (await inbox("carol@example.test")).find((m) => m.subject.includes("you have been sent a payment"))!;
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
    // the letters say what it is — a revoke, not "0 USDC leaves"
    expect((await inbox(a1.email))[0]!.subject).toBe("Acme DAO: revoking 1 unclaimed payment(s) is waiting for your approval");
    await approveAndSubmit(rv.body.id, a2, a3);
    expect((await inbox(a1.email))[0]!.subject).toBe("Acme DAO: 1 unclaimed payment(s) returned to the account");
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
    // no date given: the keeper reads the chain clock, which is now two days ahead of this computer's
    expect((await payouts.runKeeper(orgId)).refunded).toBe(1);
    expect(await balance(account)).toBe(before + 13_050_000n);
    expect((await api.get(`/payouts/${p.body.id}/receipt`).set(ops.headers).expect(200)).body.payout.status).toBe("closed");
  });

  it("the keeper does not stop on a deposit someone else already refunded (refundExpired is permissionless)", async () => {
    const mk = async (name: string) => {
      const p = await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: `expiring ${name}`, rows: [{ name, email: `${name.toLowerCase()}@example.test`, amount: "2" }] }).expect(201);
      await approveAndSubmit((await api.post(`/payouts/${p.body.id}/batches`).set(ops.headers).expect(201)).body.id);
      return (await api.get(`/payouts/${p.body.id}/receipt`).set(ops.headers).expect(200)).body as { payout: { id: string }; rows: { depositId: Hex }[] };
    };
    const first = await mk("Yuri");
    const second = await mk("Zara");
    await increaseTime(stack.rpcUrl, 2 * 86_400);
    // a stranger refunds the first one before the keeper gets to it
    await chain.waitTx(await chain.refundExpired(stack.escrow, first.rows[0]!.depositId));
    expect((await payouts.runKeeper(orgId)).refunded).toBe(1);
    for (const r of [first, second]) {
      expect((await api.get(`/payouts/${r.payout.id}/receipt`).set(ops.headers).expect(200)).body.rows[0].status).toBe("refunded");
    }
  });

  // ------------------------------------------------------ address book, repeats, schedules

  it("address book remembers paid recipients; a payout can be built from it", async () => {
    const book = (await api.get(`/orgs/${orgId}/address-book`).set(ops.headers).expect(200)).body;
    const aliceEntry = book.find((e: { name: string }) => e.name === "Alice");
    expect(aliceEntry).toMatchObject({ address: alice, category: "grants", lastAmount: "1000000000" });
    await api.post(`/orgs/${orgId}/address-book`).set(a1.headers).send({ name: "X", chainId: CHAIN }).expect(403);
    const p = (await api.post(`/orgs/${orgId}/payouts/from-book`).set(ops.headers).send({ title: "October from book", items: [{ id: aliceEntry.id, amount: "1200" }] }).expect(201)).body;
    const review = (await api.get(`/payouts/${p.id}/review`).set(ops.headers).expect(200)).body;
    expect(review.summary.changedAmount[0].previous).toBe("1000000000"); // the diff sees the change vs history
  });

  it("repeat a payout and edit one row before freezing; a frozen row cannot be edited", async () => {
    const rep = (await api.post(`/payouts/${payoutId}/repeat`).set(ops.headers).send({ title: "October" }).expect(201)).body;
    await api.patch(`/payouts/${rep.id}/rows/row-2`).set(ops.headers).send({ amount: "1500" }).expect(200);
    await api.patch(`/payouts/${rep.id}/rows/row-6`).set(ops.headers).send({ remove: true }).expect(200); // Eve (other chain)
    const receipt = (await api.get(`/payouts/${rep.id}/receipt`).set(ops.headers).expect(200)).body;
    expect(receipt.rows.find((x: { name: string }) => x.name === "Alice").amount).toBe("1500000000");
    expect(receipt.rows.map((x: { name: string }) => x.name)).not.toContain("Eve");
    await api.patch(`/payouts/${payoutId}/rows/row-2`).set(ops.headers).send({ amount: "1" }).expect(409); // already sent
  });

  it("a recurring schedule creates a draft and tells operators — nothing is sent without approval", async () => {
    await api.post(`/orgs/${orgId}/schedules`).set(ops.headers).send({ title: "Monthly stipends", templatePayoutId: payoutId, every: "month", firstRunAt: new Date(Date.now() - 1000).toISOString() }).expect(201);
    const created = await lists.runSchedules();
    expect(created).toHaveLength(1);
    expect(await lists.runSchedules()).toHaveLength(0); // next run is a month away
    const draft = (await api.get(`/payouts/${created[0]}/receipt`).set(ops.headers).expect(200)).body;
    expect(draft.payout.status).toBe("draft");
    expect((await inbox(ops.email))[0]!.subject).toMatch(/recurring payout "Monthly stipends" has a draft/);
  });

  it("re-issuing a claim link — after N-of-M the new link works and the old one does not", async () => {
    const p = await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "spam folder", csv: `name,email,address,chain_id,amount\nWu,wu@example.test,,${CHAIN},5` }).expect(201);
    await approveAndSubmit((await api.post(`/payouts/${p.body.id}/batches`).set(ops.headers).expect(201)).body.id);
    const oldLink = parseClaimLink((await inbox("wu@example.test"))[0]!.body.match(/http:\/\/claim\.local\/#\S+/)![0]);
    const rk = await api.post(`/payouts/${p.body.id}/rekey`).set(ops.headers).send({ rows: ["row-2"] }).expect(201);
    expect(await inbox("wu@example.test")).toHaveLength(1); // no new email before the rekey is on chain
    await approveAndSubmit(rk.body.id, a3, a2);
    const mails = await inbox("wu@example.test");
    expect(mails[0]!.subject).toMatch(/a new link to your payment/);
    const newLink = parseClaimLink(mails[0]!.body.match(/http:\/\/claim\.local\/#\S+/)![0]);
    const newLinkKey = () => newLink.key;
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    // chain time: an earlier test moved the chain two days ahead of the wall clock
    const deadline = (await chain.pub.getBlock({ blockTag: "latest" })).timestamp + 3600n;
    // the old key is rejected by the contract because of the key itself, not the deadline
    const digestOld = await chain.pub.readContract({ address: oldLink.escrow, abi: claimEscrowAbi, functionName: "getDeposit", args: [oldLink.depositId] });
    expect(digestOld.claimSigner).not.toBe(privateKeyToAccount(oldLink.key).address);
    expect(digestOld.claimSigner).toBe(privateKeyToAccount(newLinkKey()).address);
    const send = async (l: typeof oldLink) => api.post("/claims").send({ escrow: l.escrow, depositId: l.depositId, recipient: wallet, deadline: deadline.toString(), signature: await signClaim(l, wallet, deadline) });
    expect((await send(oldLink)).status).toBe(400);
    expect((await send(newLink)).status).toBe(201);
    expect(await balance(wallet)).toBe(5_000_000n);
  });

  it("the payments report and CSV export — date, recipient, amount, USD with its source, category, hash", async () => {
    const lines = (await api.get(`/orgs/${orgId}/reports/payments`).set(a2.headers).expect(200)).body;
    const aliceLine = lines.find((l: { recipient: string }) => l.recipient === "Alice");
    expect(aliceLine).toMatchObject({ amount: "1000", token: "USDC", usdValue: "1000.00", category: "grants", status: "sent" });
    expect(aliceLine.priceSource).toMatch(/at par/);
    expect(aliceLine.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(lines.find((l: { recipient: string }) => l.recipient === "Carol").status).toBe("claimed");
    const csv = await api.get(`/orgs/${orgId}/reports/payments`).query({ format: "csv" }).set(ops.headers).expect(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text.split("\n")[0]).toContain("USD value");
    await api.get(`/orgs/${orgId}/reports/payments`).set(outsider.headers).expect(403);
  });

  it("CSV export neutralises formulas in names from uploaded files", async () => {
    const p = await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "inj", csv: `name,email,address,chain_id,amount\n=HYPERLINK(\"x\"),,${bob},${CHAIN},1` }).expect(201);
    await approveAndSubmit((await api.post(`/payouts/${p.body.id}/batches`).set(ops.headers).expect(201)).body.id);
    const csv = (await api.get(`/orgs/${orgId}/reports/payments`).query({ format: "csv" }).set(ops.headers).expect(200)).text;
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("buying USDC through the on-ramp (emulator) lands on the organisation account", async () => {
    await api.post(`/orgs/${orgId}/onramp`).set(outsider.headers).send({ fiatAmount: 100 }).expect(403);
    const s = (await api.post(`/orgs/${orgId}/onramp`).set(a1.headers).send({ fiatAmount: 1000 }).expect(201)).body;
    expect(s.destination).toBe(account);
    const before = await balance(account);
    const base = s.url.split("/widget/")[0];
    const r = await fetch(`${base}/sessions/${s.id}/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await r.json()).status).toBe("completed");
    expect(await balance(account)).toBe(before + 982_500_000n); // 1000 − 1.75 % placeholder fee
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

  it("fail closed: a sponsor that lowers callGasLimit below the floor gets no signature request (TRY batches)", async () => {
    const p = await api.post(`/orgs/${orgId}/payouts`).set(ops.headers).send({ title: "low gas", csv: `name,email,address,chain_id,amount\nZoe,,${alice},${CHAIN},1` }).expect(201);
    const b = (await api.post(`/payouts/${p.body.id}/batches`).set(ops.headers).expect(201)).body;
    const s1 = await api.get(`/batches/${b.id}/next-step`).set(a1.headers).expect(200);
    await api.post(`/batches/${b.id}/approvals`).set(a1.headers).send({ signature: await a1.signTypedData(s1.body.typedData) }).expect(201);
    const svc = payouts as unknown as { sponsor?: { sponsor(op: { accountGasLimits: Hex }): Promise<unknown> } };
    const real = svc.sponsor;
    svc.sponsor = { sponsor: async (op) => ({ ...op, accountGasLimits: `0x${((400_000n << 128n) | 50_000n).toString(16).padStart(64, "0")}` }) };
    try {
      const r = await api.get(`/batches/${b.id}/next-step`).set(a2.headers).expect(502);
      expect(r.body.error).toMatch(/below the minimum/);
    } finally {
      svc.sponsor = real;
    }
    expect((await api.get(`/batches/${b.id}/next-step`).set(a2.headers).expect(200)).body.step).toBe("final");
  });

  it("behind a proxy the claim limiter counts clients, not the proxy", async () => {
    const bad = { escrow: stack.escrow, depositId: `0x${"11".repeat(32)}`, recipient: alice, deadline: "1", signature: "0x" };
    for (let i = 0; i < 10; i++) await api.post("/claims").set("x-forwarded-for", "203.0.113.7").send(bad).expect(400);
    await api.post("/claims").set("x-forwarded-for", "203.0.113.7").send(bad).expect(429);
    await api.post("/claims").set("x-forwarded-for", "203.0.113.8").send(bad).expect(400); // another client is not blocked
  });

  it("only our own pages may call the API from a browser", async () => {
    const ok = await api.options("/me").set("origin", "http://app.local").set("access-control-request-method", "GET");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://app.local");
    const claimPage = await api.options("/claims").set("origin", "http://claim.local").set("access-control-request-method", "POST");
    expect(claimPage.headers["access-control-allow-origin"]).toBe("http://claim.local");
    const evil = await api.options("/me").set("origin", "https://evil.test").set("access-control-request-method", "GET");
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("/health says whether the API can work, without auth and without secrets", async () => {
    const r = await api.get("/health").expect(200);
    expect(r.body).toMatchObject({ ok: true, checks: { db: true, rpc: true } });
    expect(r.body.checks.bundler).toBe(HOSTED_AA ? true : null);
    expect(r.body.submitter.address).toBe(chain.submitter);
    expect(JSON.stringify(r.body)).not.toMatch(/[0-9a-f]{64}/i); // no keys, no hashes of secrets
  });

  it("alerts — low submitter ETH and a stuck batch reach the webhook once, then 'resolved'", async () => {
    const got: string[] = [];
    const hook = express();
    hook.use(express.json());
    hook.post("/", (req, res) => { got.push(req.body.text); res.json({ ok: true }); });
    const srv = await new Promise<Server>((ok) => { const s = hook.listen(0, () => ok(s)); });
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
    try {
      const mined = (await db.query(`SELECT id FROM batches WHERE status='mined' LIMIT 1`)).rows[0].id;
      await db.query(`UPDATE batches SET status='submitted', submitted_at=now() - interval '1 hour' WHERE id=$1`, [mined]);
      const m = new Monitor(db, chain, { minSubmitterWei: 10n ** 30n, webhookUrl: url, repeatMs: 3_600_000 });
      const h = await m.run(1_000);
      expect(h.submitter.low).toBe(true);
      expect(h.stuckBatches).toBe(1);
      expect(got.some((t) => /submitter .* ETH/.test(t))).toBe(true);
      expect(got.some((t) => /1 batch\(es\) submitted more than 15 min ago/.test(t))).toBe(true);
      await m.run(2_000); // within the repeat window: silent
      expect(got).toHaveLength(2);
      await db.query(`UPDATE batches SET status='mined' WHERE id=$1`, [mined]);
      await m.run(3_000);
      expect(got.filter((t) => t.startsWith("✓")).map((t) => t.split("— ")[1]).sort()).toEqual(["stuck-batches"]);
    } finally {
      srv.close();
    }
  });
});
