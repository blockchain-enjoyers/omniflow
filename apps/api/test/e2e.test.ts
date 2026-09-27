import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { createPublicClient, erc20Abi, http, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { claimEscrowAbi, DepositStatus, parseClaimLink, signClaim } from "@omniflow/shared";
import { createDb, migrate, type Db } from "../src/db/db.js";
import { ChainClient } from "../src/chain/chain.js";
import { ClaimKeyVault } from "../src/claimkeys/vault.js";
import { MemoryMailer } from "../src/mail/mailer.js";
import { PayoutService } from "../src/payouts/service.js";
import { createApp } from "../src/http/app.js";
import { increaseTime, startLocalStack, SUBMITTER_KEY, type LocalStack } from "./helpers.js";

/**
 * The approved slice, end to end on a local chain (no network): organisation 2-of-3 → CSV → review →
 * approvals → batch (two EOAs + one escrow deposit) → claim by link → revoke and auto-refund → receipt.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const dev = { "x-dev-user": "operator@example.test" };

describe.skipIf(!DB_URL)("slice e2e", () => {
  const approverKeys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
  const approvers = approverKeys.map((k) => privateKeyToAccount(k));
  const alice = privateKeyToAccount(generatePrivateKey()).address;
  const bob = privateKeyToAccount(generatePrivateKey()).address;

  let stack: LocalStack;
  let db: Db;
  let mailer: MemoryMailer;
  let service: PayoutService;
  let app: Awaited<ReturnType<typeof createApp>>;
  let chain: ChainClient;
  let orgId: string;
  let http_: ReturnType<typeof request>;

  const balance = (who: Address) =>
    chain.pub.readContract({ address: stack.token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  beforeAll(async () => {
    stack = await startLocalStack(approvers.map((a) => a.address), 2);
    db = createDb(DB_URL!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db);
    chain = new ChainClient({ chainId: 31337, rpcUrl: stack.rpcUrl, entryPoint: stack.entryPoint, submitterKey: SUBMITTER_KEY });
    mailer = new MemoryMailer();
    service = new PayoutService(db, chain, new ClaimKeyVault(randomBytes(32).toString("hex")), mailer, {
      tokenDecimals: 6,
      claimTip: 50_000n,
      maxRowsPerBatch: 40,
      claimBaseUrl: "http://claim.local/",
      senderDisplayName: (n) => `${n} через Omniflow`,
    });
    app = await createApp(service, chain);
    await app.init();
    http_ = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    stack?.anvil.kill();
  });

  /** Runs the approval flow: first approver signs Approve(hash), the second signs the final userOpHash. */
  async function approveAndSubmit(batchId: string, signers = [0, 1]) {
    const [first, second] = signers.map((i) => approvers[i]!);
    const s1 = await http_.get(`/batches/${batchId}/next-step`).query({ approver: first!.address }).expect(200);
    expect(s1.body.step).toBe("approve");
    const sig1 = await first!.signTypedData(s1.body.typedData);
    await http_.post(`/batches/${batchId}/approvals`).send({ signature: sig1 }).expect(201);

    const s2 = await http_.get(`/batches/${batchId}/next-step`).query({ approver: second!.address }).expect(200);
    expect(s2.body.step).toBe("final");
    const sig2 = await second!.signMessage({ message: { raw: s2.body.userOpHash as Hex } });
    const fin = await http_.post(`/batches/${batchId}/final`).send({ signature: sig2 }).expect(201);
    await service.settleBatch(batchId);
    return fin.body.txHash as Hex;
  }

  it("refuses an organisation whose approver set does not match the chain", async () => {
    await http_
      .post("/orgs")
      .set(dev)
      .send({ name: "Fake", account: stack.account, validator: stack.validator, escrow: stack.escrow, token: stack.token, approvers: [{ address: bob, weight: 1 }] })
      .expect(400);
  });

  it("operator endpoints require auth (slice auth)", async () => {
    await http_.post("/orgs").send({}).expect(401);
  });

  it("registers the organisation from the chain", async () => {
    const r = await http_
      .post("/orgs")
      .set(dev)
      .send({
        name: "Acme DAO",
        account: stack.account,
        validator: stack.validator,
        escrow: stack.escrow,
        token: stack.token,
        approvers: approvers.map((a) => ({ address: a.address, weight: 1 })),
        autoRefundDays: null,
      })
      .expect(201);
    orgId = r.body.id;
    expect(r.body.threshold).toBe(2);
  });

  let payoutId: string;
  let batchId: string;

  it("creates a payout from CSV and shows the review summary", async () => {
    const csv = [
      "name,email,address,chain_id,amount",
      `Alice,,${alice},31337,1000`,
      `Bob,bob@example.test,${bob},31337,2000.5`,
      "Carol,carol@example.test,,31337,3000",
      "Dave,,,31337,10",
      `Eve,,${alice},1,5`,
    ].join("\n");
    const p = await http_.post(`/orgs/${orgId}/payouts`).set(dev).send({ title: "September grants", csv }).expect(201);
    payoutId = p.body.id;

    const r = await http_.get(`/payouts/${payoutId}/review`).set(dev).expect(200);
    const s = r.body.summary;
    expect(s.total).toBe("6000500000");
    expect(s.toAddress).toBe(2);
    expect(s.byEmail).toBe(1);
    expect(s.newRecipients).toHaveLength(3);
    expect(s.notSent.map((n: { reason: string }) => n.reason).sort()).toEqual(["no-address-no-email", "other-chain"]);
    expect(s.balanceSufficient).toBe(true);
  });

  it("freezes a batch; one open batch per organisation", async () => {
    const b = await http_.post(`/payouts/${payoutId}/batches`).set(dev).expect(201);
    batchId = b.body.id;
    expect(b.body.manifest.rows.map((r: { kind: string }) => r.kind)).toEqual(["transfer", "transfer", "escrow"]);
    await http_.post(`/payouts/${payoutId}/batches`).set(dev).expect(409);
  });

  it("rejects approvals from non-approvers", async () => {
    const outsider = privateKeyToAccount(generatePrivateKey());
    await http_.get(`/batches/${batchId}/next-step`).query({ approver: outsider.address }).expect(403);
    const s = await http_.get(`/batches/${batchId}/next-step`).query({ approver: approvers[0]!.address }).expect(200);
    const forged = await outsider.signTypedData(s.body.typedData);
    await http_.post(`/batches/${batchId}/approvals`).send({ signature: forged }).expect(403);
  });

  it("2 of 3 approve → the batch pays two EOAs and funds the escrow", async () => {
    const accountBefore = await balance(stack.account);
    await approveAndSubmit(batchId);
    expect(await balance(alice)).toBe(1_000_000_000n);
    expect(await balance(bob)).toBe(2_000_500_000n);
    expect(await balance(stack.account)).toBe(accountBefore - 6_000_500_000n - 50_000n);

    const receipt = await http_.get(`/payouts/${payoutId}/receipt`).set(dev).expect(200);
    const st = Object.fromEntries(receipt.body.rows.map((r: { name: string; status: string }) => [r.name, r.status]));
    expect(st).toEqual({ Alice: "sent", Bob: "sent", Carol: "in_escrow", Dave: "waiting_details", Eve: "other_chain" });
  });

  it("the replayed operation cannot pay again", async () => {
    await http_.post(`/batches/${batchId}/final`).send({ signature: "0x00" }).expect(409);
    // and a late approver gets no new op to sign — the mined batch record stays intact
    const late = await http_.get(`/batches/${batchId}/next-step`).query({ approver: approvers[2]!.address }).expect(200);
    expect(late.body).toEqual({ step: "closed", status: "mined" });
  });

  it("emails the claim link and deletes the key", async () => {
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe("carol@example.test");
    expect(mailer.sent[0]!.subject).toBe("Acme DAO через Omniflow: вам отправлен платёж");
    const keys = await db.query("SELECT count(*) FROM claim_keys");
    expect(Number(keys.rows[0].count)).toBe(0);
  });

  it("Carol claims with the link into a fresh wallet; the relayer earns the tip", async () => {
    const url = mailer.sent[0]!.text.match(/http:\/\/claim\.local\/#\S+/)![0];
    const link = parseClaimLink(url);
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const signature = await signClaim(link, wallet, deadline);
    const r = await http_.post("/claims").send({ escrow: link.escrow, depositId: link.depositId, recipient: wallet, deadline: deadline.toString(), signature }).expect(201);
    expect(r.body.ok).toBe(true);
    expect(await balance(wallet)).toBe(3_000_000_000n);
    expect(await balance(chain.submitter)).toBe(50_000n);

    // the same link again: rejected by simulation, no transaction sent
    const nonceBefore = await chain.pub.getTransactionCount({ address: chain.submitter });
    await http_.post("/claims").send({ escrow: link.escrow, depositId: link.depositId, recipient: wallet, deadline: deadline.toString(), signature }).expect(400);
    expect(await chain.pub.getTransactionCount({ address: chain.submitter })).toBe(nonceBefore);

    await service.pollEscrow(orgId);
    const receipt = await http_.get(`/payouts/${payoutId}/receipt`).set(dev).expect(200);
    expect(receipt.body.rows.find((r: { name: string }) => r.name === "Carol").status).toBe("claimed");
  });

  it("claim works without Omniflow: straight to the escrow with any RPC", async () => {
    const p = await http_.post(`/orgs/${orgId}/payouts`).set(dev).send({ title: "solo", csv: "name,email,address,chain_id,amount\nZed,zed@example.test,,31337,7" }).expect(201);
    const b = await http_.post(`/payouts/${p.body.id}/batches`).set(dev).expect(201);
    await approveAndSubmit(b.body.id, [2, 0]);
    const link = parseClaimLink(mailer.sent.at(-1)!.text.match(/http:\/\/claim\.local\/#\S+/)![0]);

    // No API, no database: only the link, a public RPC and the recipient's own key paying gas.
    const self = privateKeyToAccount(SUBMITTER_KEY);
    const pub = createPublicClient({ transport: http(stack.rpcUrl) });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await signClaim(link, self.address, deadline);
    const { createWalletClient } = await import("viem");
    const w = createWalletClient({ account: self, transport: http(stack.rpcUrl), chain: { id: 31337, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [stack.rpcUrl] } } } });
    const h = await w.writeContract({ address: link.escrow, abi: claimEscrowAbi, functionName: "claim", args: [link.depositId, self.address, deadline, sig] });
    expect((await pub.waitForTransactionReceipt({ hash: h })).status).toBe("success");
    const d = await pub.readContract({ address: link.escrow, abi: claimEscrowAbi, functionName: "getDeposit", args: [link.depositId] });
    expect(d.status).toBe(DepositStatus.Claimed);
  });

  it("revoke needs the same 2 of 3 and returns money to the account", async () => {
    const p = await http_.post(`/orgs/${orgId}/payouts`).set(dev).send({ title: "to revoke", csv: "name,email,address,chain_id,amount\nYan,yan@example.test,,31337,11" }).expect(201);
    const b = await http_.post(`/payouts/${p.body.id}/batches`).set(dev).expect(201);
    await approveAndSubmit(b.body.id);
    const before = await balance(stack.account);

    const rv = await http_.post(`/payouts/${p.body.id}/revoke`).set(dev).send({ rows: ["row-2"] }).expect(201);
    await approveAndSubmit(rv.body.id, [1, 2]);
    await service.pollEscrow(orgId);
    expect(await balance(stack.account)).toBe(before + 11_000_000n + 50_000n);
    const receipt = await http_.get(`/payouts/${p.body.id}/receipt`).set(dev).expect(200);
    expect(receipt.body.rows[0].status).toBe("refunded");
  });

  it("auto-refund by the keeper after N days goes to the depositor only", async () => {
    const p = await http_.post(`/orgs/${orgId}/payouts`).set(dev).send({ title: "expiring", csv: "name,email,address,chain_id,amount\nXia,xia@example.test,,31337,13", autoRefundDays: 1 }).expect(201);
    const b = await http_.post(`/payouts/${p.body.id}/batches`).set(dev).expect(201);
    await approveAndSubmit(b.body.id);
    const before = await balance(stack.account);

    expect((await service.runKeeper(orgId)).refunded).toBe(0); // not yet due
    await increaseTime(stack.rpcUrl, 2 * 86_400);
    expect((await service.runKeeper(orgId, new Date(Date.now() + 2 * 86_400_000))).refunded).toBe(1);
    expect(await balance(stack.account)).toBe(before + 13_000_000n + 50_000n);
    const receipt = await http_.get(`/payouts/${p.body.id}/receipt`).set(dev).expect(200);
    expect(receipt.body.rows[0].status).toBe("refunded");
    expect(receipt.body.payout.status).toBe("closed"); // every row final → closes itself
  });

  it("first payout stays open while rows wait; manual close keeps them in the report", async () => {
    let r = await http_.get(`/payouts/${payoutId}/receipt`).set(dev).expect(200);
    expect(r.body.payout.status).toBe("partially_executed");
    await http_.post(`/payouts/${payoutId}/close`).set(dev).expect(201);
    r = await http_.get(`/payouts/${payoutId}/receipt`).set(dev).expect(200);
    expect(r.body.payout.status).toBe("closed");
    const notExecuted = r.body.rows.filter((x: { executed: boolean }) => !x.executed).map((x: { name: string }) => x.name);
    expect(notExecuted.sort()).toEqual(["Dave", "Eve"]);
  });
});
