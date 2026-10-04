import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { mintToken } from "@omniflow/devchain";
import { readDevMailbox } from "@omniflow/devmail";
import { signedForm, type DemoForm } from "./forms.js";
import { emulatedLogin, emulatedSign, type DemoUser } from "./seed.js";
import type { RunningStack } from "./stack.js";

/**
 * EMULATION ONLY — "Open a live example". Each visitor gets an organisation of their own,
 * built through the same HTTP API the dashboard uses, with one payout already carried through:
 *   Alice — paid to her address; Carol — claim link emailed, not claimed; Dave — waiting for payment details;
 *   Frank — claim link not used, returned to the account when it expired.
 * Documents as a US payer keeps them, each a filled IRS form: W-9s from Alice and Maya (their 1099-NECs can be filled
 * at once), a W-8BEN from Bruno, a W-8BEN-E from Kite Labs; a W-8BEN asked of Carol and not yet sent. Received forms go
 * to the example's finance address.
 * The visitor is admin, operator and one of the approvers (2 of 3). The other two approvers are simulated people
 * (Anna, Boris): they sign the seeded payout, and afterwards sign anything only once the visitor has signed it —
 * so the visitor can carry a payout of their own all the way through.
 *
 * Frank's expiry is real: the escrow refunds only after autoRefundAt by block time, so building an example moves the
 * demo chain's clock forward by a day. Deposits whose deadline falls within that day expire early — demo network only.
 */
export interface LiveExampleSession {
  accessToken: string;
  identityToken: string;
  user: { did: string; email: string; wallet: Address | null };
  orgId: string;
  payoutId: string;
}

interface Example {
  orgId: string;
  payoutId: string;
  guest: string;
  bots: { email: string; user: DemoUser; at: number }[];
}

const ORG = "Example DAO";
const DAY = 86_400;
const TOKEN_LIFETIME_MS = 50 * 60_000; // the emulator's tokens live an hour

export class LiveExamples {
  private ready: Example[] = [];
  private handedOut: Example[] = [];
  private building: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private signing = false;
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly stack: RunningStack,
    private readonly o: { pool: number; log?: (s: string) => void; perIpPerHour?: number },
  ) {}

  start() {
    this.refill();
    this.timer = setInterval(() => void this.coSign(), 2000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** A fresh example for one visitor; built on the spot when none is waiting. */
  async take(ip: string): Promise<LiveExampleSession> {
    this.limit(ip);
    let ex = this.ready.shift();
    if (!ex) {
      await this.build();
      ex = this.ready.shift();
    }
    if (!ex) throw new Error("could not prepare an example");
    this.handedOut.push(ex);
    this.refill();
    const u = await this.login(ex.guest);
    return { accessToken: u.headers.authorization!.replace(/^Bearer /, ""), identityToken: u.headers["privy-id-token"]!, user: { did: u.did, email: u.email, wallet: u.wallet }, orgId: ex.orgId, payoutId: ex.payoutId };
  }

  private limit(ip: string) {
    const max = this.o.perIpPerHour ?? 20;
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= max) throw Object.assign(new Error("too many examples from this address — try again in an hour"), { status: 429 });
    recent.push(now);
    this.hits.set(ip, recent);
  }

  private refill() {
    if (this.building || this.ready.length >= this.o.pool) return;
    this.building = this.build()
      .catch((e) => this.o.log?.(`live example: ${(e as Error).message}`))
      .finally(() => {
        this.building = null;
        if (this.ready.length < this.o.pool) this.refill();
      });
  }

  /** One build at a time: each moves the chain clock, and the steps of two builds must not interleave with it. */
  private queue: Promise<unknown> = Promise.resolve();
  private build(): Promise<void> {
    const run = this.queue.then(() => this.buildOne());
    this.queue = run.catch(() => {});
    return run.then((ex) => void this.ready.push(ex));
  }

  private async login(email: string): Promise<DemoUser> {
    const u = await emulatedLogin(this.stack, email);
    // sign-in codes of simulated people are noise in the shared demo mailbox
    await this.stack.db.query(`DELETE FROM dev_mailbox WHERE to_addr=$1 AND subject ILIKE '%code%'`, [email]);
    return u;
  }

  private async api<T>(u: DemoUser, method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.stack.urls.api}${path}`, { method, headers: { "content-type": "application/json", ...u.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
    return j as T;
  }

  /** One approver's signature on a batch: Approve(hash), or the last one over userOpHash, which submits it. */
  private async sign(u: DemoUser, batchId: string) {
    const s = await this.api<{ step: string; typedData?: unknown; userOpHash?: `0x${string}` }>(u, "GET", `/batches/${batchId}/next-step`);
    if (s.step === "approve") await this.api(u, "POST", `/batches/${batchId}/approvals`, { signature: await emulatedSign(this.stack, u, s.typedData) });
    else if (s.step === "final") await this.api(u, "POST", `/batches/${batchId}/final`, { signature: await this.signMessage(u, s.userOpHash!) });
  }

  private async signMessage(u: DemoUser, raw: `0x${string}`) {
    const r = await fetch(`${this.stack.urls.privy}/wallet/sign`, { method: "POST", headers: { "content-type": "application/json", authorization: u.headers.authorization! }, body: JSON.stringify({ kind: "message", raw }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`sign: ${j.error}`);
    return j.signature as `0x${string}`;
  }

  private async settled(u: DemoUser, payoutId: string, done: (rows: { name: string; status: string }[]) => boolean) {
    for (let i = 0; i < 120; i++) {
      const r = await this.api<{ rows: { name: string; status: string }[] }>(u, "GET", `/payouts/${payoutId}/receipt`);
      if (done(r.rows)) return;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    const r = await this.api<{ rows: { name: string; status: string }[] }>(u, "GET", `/payouts/${payoutId}/receipt`);
    throw new Error(`the example payout did not settle: ${r.rows.map((x) => `${x.name} ${x.status}`).join(", ")}`);
  }

  private async rpc(method: string, params: unknown[]) {
    const r = await fetch(this.stack.urls.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }

  private async buildOne(): Promise<Example> {
    const id = randomBytes(3).toString("hex");
    const t0 = Date.now();
    const step = (s: string) => this.o.log?.(`live example ${id}: ${s} at ${Date.now() - t0} ms`);
    const mail = (who: string) => `${who}-${id}@example.test`;
    const guest = await this.login(mail("you"));
    const anna = await this.login(mail("anna"));
    const boris = await this.login(mail("boris"));
    const approvers = [guest, anna, boris];

    // flow 1, as in the dashboard: the visitor proposes the account, every approver joins and signs the set
    const setup = await this.api<{ id: string }>(guest, "POST", "/org-setups", { name: ORG, threshold: 2, approvers: approvers.map((a) => ({ email: a.email, weight: 1 })) });
    for (const a of approvers) await this.api(a, "POST", `/org-setups/${setup.id}/join`);
    let last: { status: string; orgId: string; account: Address } | null = null;
    for (const a of approvers) {
      const s = await this.api<{ typedData: unknown }>(a, "GET", `/org-setups/${setup.id}`);
      last = await this.api(a, "POST", `/org-setups/${setup.id}/confirm`, { signature: await emulatedSign(this.stack, a, s.typedData) });
    }
    if (last?.status !== "deployed") throw new Error(`example setup ended in ${last?.status}`);
    const orgId = last.orgId;
    step("account deployed");
    await mintToken(this.stack.chain.rpcUrl, this.stack.chain.token, last.account, 100_000_000_000n);

    // Batch 1 with a one-day deadline: Alice by address, Frank by email link
    await this.api(guest, "PATCH", `/orgs/${orgId}/settings`, { autoRefundDays: 1 });
    const alice = privateKeyToAccount(generatePrivateKey()).address;
    const p = await this.api<{ id: string }>(guest, "POST", `/orgs/${orgId}/payouts`, {
      title: "September contributors",
      rows: [
        // paid to her address; the email is where a tax-form request reaches her
        { name: "Alice", address: alice, email: mail("alice"), amount: "1200", category: "grants" },
        { name: "Maya", address: privateKeyToAccount(generatePrivateKey()).address, email: mail("maya"), amount: "650", category: "contractors" },
        { name: "Bruno", address: privateKeyToAccount(generatePrivateKey()).address, email: mail("bruno"), amount: "900", category: "contractors" },
        { name: "Kite Labs Ltd", address: privateKeyToAccount(generatePrivateKey()).address, email: mail("kite"), amount: "2000", category: "contractors" },
        { name: "Frank", email: mail("frank"), amount: "500", category: "contractors" },
        // no details yet: stays out of every batch, and keeps the payout open once Frank's deposit comes back
        { name: "Dave", amount: "300", category: "grants" },
      ],
    });
    const b1 = await this.api<{ id: string }>(guest, "POST", `/payouts/${p.id}/batches`);
    await this.sign(anna, b1.id);
    await this.sign(boris, b1.id);
    await this.settled(guest, p.id, (rows) => rows.find((r) => r.name === "Alice")?.status === "sent" && rows.find((r) => r.name === "Frank")?.status === "in_escrow");

    step("batch 1 settled");
    // Frank's day passes on the demo chain; the scheduler's keeper returns his deposit (it judges by chain time)
    await this.rpc("evm_increaseTime", [DAY + 120]);
    await this.rpc("evm_mine", []);
    await this.settled(guest, p.id, (rows) => rows.find((r) => r.name === "Frank")?.status === "refunded");

    step("Frank refunded");
    // Batch 2 without a deadline: Carol by email link
    await this.api(guest, "PATCH", `/orgs/${orgId}/settings`, { autoRefundDays: null });
    await this.api(guest, "POST", `/payouts/${p.id}/rows`, { name: "Carol", email: mail("carol"), amount: "800", chainId: this.stack.chain.chainId, category: "contractors" });
    const b2 = await this.api<{ id: string }>(guest, "POST", `/payouts/${p.id}/batches`);
    await this.sign(anna, b2.id);
    await this.sign(boris, b2.id);
    await this.settled(guest, p.id, (rows) => rows.find((r) => r.name === "Carol")?.status === "in_escrow");

    step("batch 2 settled");
    // documents: forms go to the finance address; each recipient answers the request link with their own filled form
    await this.api(guest, "PATCH", `/orgs/${orgId}/settings`, { docDestination: mail("finance") });
    const rows = (await this.api<{ rows: { row: string; name: string }[] }>(guest, "GET", `/payouts/${p.id}/receipt`)).rows;
    const row = (name: string) => rows.find((r) => r.name === name)!.row;
    const sends = async (name: string, who: string, type: DemoForm, country?: string) => {
      await this.api(guest, "POST", `/payouts/${p.id}/rows/${row(name)}/document-request`, { type });
      const letter = (await readDevMailbox(this.stack.db, mail(who))).find((m) => /needs a tax form/.test(m.subject));
      const token = letter?.body.match(/#\/tax-form\/(\S+)/)?.[1];
      if (!token) throw new Error(`no tax-form request reached ${name}`);
      const file = await signedForm(type, name, country);
      await this.api(guest, "POST", `/tax-forms/${token}`, { type, filename: `${name}.pdf`, contentBase64: file.toString("base64") });
    };
    await sends("Alice", "alice", "w9");
    await sends("Maya", "maya", "w9");
    await sends("Bruno", "bruno", "w8ben", "Brazil");
    await sends("Kite Labs Ltd", "kite", "w8bene", "Singapore");
    await this.api(guest, "POST", `/payouts/${p.id}/rows/${row("Carol")}/document-request`, { type: "w8ben" });
    step("documents");
    // the notifications of the build were for the simulated approvers; the visitor starts with a clean inbox
    await this.stack.db.query(`DELETE FROM dev_mailbox WHERE to_addr = ANY($1)`, [[mail("you"), mail("anna"), mail("boris")]]);
    this.o.log?.(`live example ${id} ready`);
    const now = Date.now();
    return { orgId, payoutId: p.id, guest: mail("you"), bots: [{ email: anna.email, user: anna, at: now }, { email: boris.email, user: boris, at: now }] };
  }

  /** Simulated approvers sign what the visitor has already signed — never before, so nothing leaves without them. */
  private async coSign() {
    if (this.signing || !this.handedOut.length) return;
    this.signing = true;
    try {
      for (const ex of this.handedOut) {
        for (const bot of ex.bots) {
          if (Date.now() - bot.at > TOKEN_LIFETIME_MS) {
            bot.user = await this.login(bot.email);
            bot.at = Date.now();
          }
        }
        const waiting = await this.api<{ batchId: string; payoutId: string }[]>(ex.bots[0]!.user, "GET", "/me/approvals");
        for (const w of waiting) {
          const batches = await this.api<{ id: string; signers: { email: string | null; signed: boolean }[] }[]>(ex.bots[0]!.user, "GET", `/payouts/${w.payoutId}/batches`);
          const b = batches.find((x) => x.id === w.batchId);
          if (!b?.signers.some((s) => s.email === ex.guest && s.signed)) continue;
          await this.sign(ex.bots[0]!.user, w.batchId).catch((e) => this.o.log?.(`live example co-sign: ${(e as Error).message}`));
        }
      }
    } catch (e) {
      this.o.log?.(`live example co-sign: ${(e as Error).message}`);
    } finally {
      this.signing = false;
    }
  }
}
