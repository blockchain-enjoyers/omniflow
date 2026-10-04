import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { parseClaimLink, signClaim } from "@omniflow/shared";
import { mintToken } from "@omniflow/devchain";
import { readDevMailbox } from "@omniflow/devmail";
import type { RunningStack } from "./stack.js";

/**
 * EMULATION ONLY. A ready demo: an organisation account 2-of-3 created through flow 1 over the HTTP API, exactly as the
 * cabinet does it, with test USDC and three months of history, so a visitor sees the system at work without doing
 * anything. People log in by these emails; codes arrive in the dev mailbox.
 */
export const DEMO = {
  org: "Demo DAO",
  operator: "ops@demo.test",
  approvers: ["anna@demo.test", "boris@demo.test", "vera@demo.test"],
  threshold: 2,
  usdc: 100_000_000_000n,
  forms: "finance@demo.test",
};

/** Who a visitor can sign in as, and what each one will see (the sign-in screen lists them). */
export const demoAccounts = (history: boolean) => [
  { email: DEMO.operator, role: "Operator and admin", note: history ? "prepares payouts; three months of payouts, reports, tax forms" : "prepares payouts" },
  { email: DEMO.approvers[1]!, role: "Approver", note: history ? "the October payout is waiting for this signature" : "signs payouts" },
  { email: DEMO.approvers[2]!, role: "Approver", note: history ? "can also sign the October payout" : "signs payouts" },
  { email: DEMO.approvers[0]!, role: "Approver", note: history ? "already signed October" : "signs payouts" },
];

/** The history starts this many days ago (local chain only: anvil's first block is put there). */
export const HISTORY_DAYS = 98;
const DAY = 86_400;

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
  // the newest letter with a sign-in code — other mail (an approval request) may have arrived after it
  const letter = (await readDevMailbox(stack.db, email)).find((m) => /code/i.test(m.subject) && /\b\d{6}\b/.test(m.subject));
  if (!letter) throw new Error(`no sign-in code for ${email}`);
  const code = letter.subject.match(/\b\d{6}\b/)![0];
  const r = await post("/auth/email/verify", { email, code });
  return { email, did: r.user.did, wallet: r.user.wallet, headers: { authorization: `Bearer ${r.accessToken}`, "privy-id-token": r.identityToken } };
}

export async function emulatedSign(stack: RunningStack, u: DemoUser, typedData: unknown): Promise<Hex> {
  const r = await fetch(`${stack.urls.privy}/wallet/sign`, { method: "POST", headers: { "content-type": "application/json", authorization: u.headers.authorization! }, body: JSON.stringify({ kind: "typedData", typedData }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`sign: ${j.error}`);
  return j.signature;
}

async function signRaw(stack: RunningStack, u: DemoUser, raw: Hex): Promise<Hex> {
  const r = await fetch(`${stack.urls.privy}/wallet/sign`, { method: "POST", headers: { "content-type": "application/json", authorization: u.headers.authorization! }, body: JSON.stringify({ kind: "message", raw }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`sign: ${j.error}`);
  return j.signature;
}

async function api<T>(stack: RunningStack, u: DemoUser | null, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${stack.urls.api}${path}`, { method, headers: { "content-type": "application/json", ...(u?.headers ?? {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j as T;
}

/** history: three months of payouts; travel: put them on past dates (needs a local chain started HISTORY_DAYS ago) */
export async function seedDemo(stack: RunningStack, o: { history?: boolean; travel?: boolean } = {}) {
  const ops = await emulatedLogin(stack, DEMO.operator);
  const approvers = await Promise.all(DEMO.approvers.map((e) => emulatedLogin(stack, e)));
  const started = new Date();
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
  const h = new History(stack, ops, approvers, last.orgId, Boolean(o.history && o.travel));
  await h.stamp(started, await h.chainTime());
  if (o.history) await h.run();
  // sign-in codes of the seeding are noise too; the letters of the history stay, dated as they happened
  await stack.db.query(`DELETE FROM dev_mailbox WHERE subject ILIKE '%code%'`);
  return { orgId: last.orgId, account: last.account, payouts: h.made };
}

/**
 * Three months of an organisation's life, through the same HTTP API the dashboard uses:
 *   July — four contributors (two by address, two by email link: one claims, one lets it expire and it returns);
 *   August and September — the regulars again, a new contributor whose link is still unclaimed, one row waiting for details;
 *   a hackathon prizes payout; a W-9 received and a W-8BEN requested; a monthly schedule;
 *   today — the October payout sent for approval, one of two signatures in.
 * Between the steps the demo chain's clock moves forward (block time is what the escrow and the reports use), and the
 * timestamps the API itself records — who requested, who signed, letters, the activity log — are moved to the same
 * dates. Demo network only.
 */
class History {
  readonly made: Record<string, string> = {};
  private readonly anna: DemoUser;
  private readonly boris: DemoUser;
  private readonly people = new Map<string, DemoUser>();

  constructor(
    private readonly stack: RunningStack,
    private readonly ops: DemoUser,
    approvers: DemoUser[],
    private readonly orgId: string,
    private readonly travel: boolean,
  ) {
    [this.anna, this.boris] = [approvers[0]!, approvers[1]!];
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const r = await fetch(this.stack.urls.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result as T;
  }

  async chainTime() {
    const b = await this.rpc<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false]);
    return Number(BigInt(b.timestamp));
  }

  /** Moves the demo chain to `at` (unix seconds) if it is ahead; never backwards. */
  private async to(at: number) {
    if (!this.travel) return;
    const now = await this.chainTime();
    if (at > now) {
      await this.rpc("evm_increaseTime", [at - now]);
      await this.rpc("evm_mine", []);
    }
  }

  /**
   * Timestamps the API records with the database clock, for rows written since `since` (wall clock), are moved to the
   * chain time `at`, keeping their order. Block-time columns (executed, claimed, refunded) already carry chain time.
   */
  async stamp(since: Date, at: number) {
    if (!this.travel) return;
    const cols: [string, string][] = [
      ["orgs", "created_at"], ["org_setups", "created_at"], ["org_members", "created_at"], ["payouts", "created_at"], ["payouts", "closed_at"],
      ["batches", "created_at"], ["batches", "submitted_at"], ["approvals", "created_at"], ["emails", "sent_at"], ["audit_log", "at"],
      ["address_book", "updated_at"], ["schedules", "created_at"], ["doc_requests", "created_at"], ["doc_requests", "fulfilled_at"],
      ["payout_rows", "doc_received_at"], ["detail_forms", "created_at"], ["detail_forms", "filled_at"], ["dev_mailbox", "sent_at"],
    ];
    for (const [t, c] of cols) await this.stack.db.query(`UPDATE ${t} SET ${c} = to_timestamp($2) + (${c} - $1::timestamptz) WHERE ${c} >= $1::timestamptz`, [since, at]);
  }

  /** One step of the history at chain time `at`: the clock moves there, the work happens, its records get that date. */
  private async at(at: number, work: () => Promise<void>) {
    await this.to(at);
    const since = new Date();
    const t = await this.chainTime();
    await work();
    await this.stamp(since, t);
  }

  private person(name: string) {
    return `${name.toLowerCase()}@demo-recipient.test`;
  }

  private async recipient(name: string) {
    const email = this.person(name);
    let u = this.people.get(email);
    if (!u) {
      u = await emulatedLogin(this.stack, email);
      this.people.set(email, u);
    }
    return u;
  }

  private async sign(u: DemoUser, batchId: string) {
    const s = await api<{ step: string; typedData?: unknown; userOpHash?: Hex }>(this.stack, u, "GET", `/batches/${batchId}/next-step`);
    if (s.step === "approve") await api(this.stack, u, "POST", `/batches/${batchId}/approvals`, { signature: await emulatedSign(this.stack, u, s.typedData) });
    else if (s.step === "final") await api(this.stack, u, "POST", `/batches/${batchId}/final`, { signature: await signRaw(this.stack, u, s.userOpHash!) });
  }

  private async rows(payoutId: string) {
    return (await api<{ rows: { row: string; name: string; status: string }[] }>(this.stack, this.ops, "GET", `/payouts/${payoutId}/receipt`)).rows;
  }

  private async until(payoutId: string, done: (rows: { name: string; status: string }[]) => boolean) {
    for (let i = 0; i < 240; i++) {
      if (done(await this.rows(payoutId))) return;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    throw new Error(`demo history: payout did not settle: ${(await this.rows(payoutId)).map((r) => `${r.name} ${r.status}`).join(", ")}`);
  }

  /** A payout created, sent for approval, signed by two approvers and settled. */
  private async pay(title: string, rows: { name: string; address?: Address; email?: string; amount: string; category?: string }[]) {
    const p = await api<{ id: string }>(this.stack, this.ops, "POST", `/orgs/${this.orgId}/payouts`, { title, rows });
    const b = await api<{ id: string }>(this.stack, this.ops, "POST", `/payouts/${p.id}/batches`);
    await this.sign(this.anna, b.id);
    await this.sign(this.boris, b.id);
    const sendable = rows.filter((r) => r.address || r.email).map((r) => r.name);
    await this.until(p.id, (rs) => sendable.every((n) => ["sent", "in_escrow"].includes(rs.find((r) => r.name === n)?.status ?? "")));
    this.made[title] = p.id;
    return p.id;
  }

  /** The recipient opens the newest claim link and receives through the relayer, as the claim page does. */
  private readonly usedLinks = new Set<string>();

  /** The recipient opens the link of this payout and receives through the relayer, as the claim page does. */
  private async claim(name: string, payoutId: string) {
    const u = await this.recipient(name);
    // the letter is sent once the batch settles — it can arrive a moment after the row's status changes,
    // so wait for a link that has not been used yet rather than take whatever letter is newest
    let link: ReturnType<typeof parseClaimLink> | null = null;
    for (let i = 0; i < 120 && !link; i++) {
      for (const m of await readDevMailbox(this.stack.db, this.person(name))) {
        const url = /you have been sent a payment/i.test(m.subject) ? m.body.match(/https?:\/\/\S+#\S+/)?.[0] : undefined;
        if (!url) continue;
        const l = parseClaimLink(url);
        if (!this.usedLinks.has(l.depositId)) {
          link = l;
          break;
        }
      }
      if (!link) await new Promise((ok) => setTimeout(ok, 500));
    }
    if (!link) throw new Error(`demo history: no new claim link for ${name}`);
    this.usedLinks.add(link.depositId);
    const deadline = BigInt((await this.chainTime()) + 3600);
    await api(this.stack, null, "POST", "/claims", { escrow: link.escrow, depositId: link.depositId, recipient: u.wallet, deadline: deadline.toString(), signature: await signClaim(link, u.wallet, deadline) });
    await this.until(payoutId, (rs) => rs.find((r) => r.name === name)?.status === "claimed");
  }

  async run() {
    const start = await this.chainTime();
    const day = (n: number) => start + n * DAY;
    // fixed demo wallets, derived from the names (nobody holds their keys; test money only)
    const addr = (name: string) => getAddress(keccak256(toHex(`omniflow demo ${name}`)).slice(0, 42));
    const [alice, bob, hiro, ines, jun] = ["Alice", "Bob", "Hiro", "Ines", "Jun"].map(addr) as [Address, Address, Address, Address, Address];
    const regulars = [
      { name: "Alice", address: alice, amount: "2000", category: "grants" },
      { name: "Bob", address: bob, amount: "900", category: "bounties" },
      { name: "Carol", email: this.person("Carol"), amount: "1500", category: "contractors" },
    ];

    await this.at(day(1), async () => {
      await api(this.stack, this.ops, "PATCH", `/orgs/${this.orgId}/settings`, { autoRefundDays: 14, docDestination: DEMO.forms });
    });

    let july = "";
    await this.at(day(10), async () => {
      july = await this.pay("July contributors", [...regulars, { name: "Dave", email: this.person("Dave"), amount: "400", category: "contractors" }]);
      // later links do not expire: the default goes back to "never"
      await api(this.stack, this.ops, "PATCH", `/orgs/${this.orgId}/settings`, { autoRefundDays: null });
    });
    await this.at(day(11), () => this.claim("Carol", july));

    let august = "";
    await this.at(day(41), async () => {
      // Dave never opened his July link; it expired after 14 days and the keeper returned the money
      if (this.travel) await this.until(july, (rs) => rs.find((r) => r.name === "Dave")?.status === "refunded");
      august = await this.pay("August contributors", [...regulars, { name: "Erin", email: this.person("Erin"), amount: "600", category: "contractors" }]);
    });
    await this.at(day(42), () => this.claim("Carol", august));

    let september = "";
    await this.at(day(72), async () => {
      september = await this.pay("September contributors", [...regulars, { name: "Frank", amount: "450", category: "contractors" }]);
    });
    await this.at(day(73), () => this.claim("Carol", september));

    await this.at(day(76), async () => {
      const rows = await this.rows(september);
      const carol = rows.find((r) => r.name === "Carol")!.row;
      await api(this.stack, this.ops, "POST", `/payouts/${september}/rows/${carol}/document-request`, { type: "w9" });
      const letter = (await readDevMailbox(this.stack.db, this.person("Carol"))).find((m) => /needs a tax form/.test(m.subject))!;
      const token = letter.body.match(/#\/tax-form\/(\S+)/)![1]!;
      await api(this.stack, null, "POST", `/tax-forms/${token}`, { type: "w9", filename: "W-9 Carol.pdf", contentBase64: Buffer.from(SIGNED_FORM).toString("base64") });
      const erin = (await this.rows(august)).find((r) => r.name === "Erin")!.row;
      await api(this.stack, this.ops, "POST", `/payouts/${august}/rows/${erin}/document-request`, { type: "w8ben" });
    });

    await this.at(day(84), async () => {
      await this.pay("Hackathon prizes", [
        { name: "Hiro", address: hiro, amount: "3000", category: "prizes" },
        { name: "Ines", address: ines, amount: "2000", category: "prizes" },
        { name: "Jun", address: jun, amount: "1000", category: "prizes" },
      ]);
      const next = new Date();
      next.setUTCMonth(next.getUTCMonth() + 1, 8);
      await api(this.stack, this.ops, "POST", `/orgs/${this.orgId}/schedules`, { title: "Monthly contributors", templatePayoutId: september, every: "month", firstRunAt: next.toISOString() });
    });

    // today: the October payout is waiting for the second signature
    await this.to(Math.floor(Date.now() / 1000));
    const oct = await api<{ id: string }>(this.stack, this.ops, "POST", `/orgs/${this.orgId}/payouts`, { title: "October contributors", rows: regulars.map((r) => (r.name === "Bob" ? { ...r, amount: "1100" } : r)) });
    const b = await api<{ id: string }>(this.stack, this.ops, "POST", `/payouts/${oct.id}/batches`);
    await this.sign(this.anna, b.id);
    this.made["October contributors"] = oct.id;
  }
}

/** A stand-in for a signed W-9 the recipient scanned: a minimal valid PDF. */
const SIGNED_FORM = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;
