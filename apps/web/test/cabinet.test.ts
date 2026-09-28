import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { erc20Abi, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readDevMailbox } from "@omniflow/devmail";
import { startStack, type RunningStack } from "@omniflow/devstack";

/**
 * The whole application in a real browser, everything external EMULATED (Privy, ZeroDev, mail, on-ramp, chain):
 * login → flow 1 → top-up → CSV payout → review → 2-of-2 in the cabinet → claim by email login → details form →
 * address book → repeat with edits → schedules → rekey and revoke → close → members → settings → audit → CSV export,
 * then every main screen at phone width without horizontal scrolling.
 * STACK=fork runs it on an anvil fork of Arbitrum Sepolia (Kernel 0.3.1, Circle USDC).
 * SCREENSHOTS_DIR=… also saves desktop and phone screenshots of each screen.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const SHOTS = process.env.SCREENSHOTS_DIR;
const DESKTOP = { width: 1280, height: 860 };
const PHONE = { width: 390, height: 844 };

describe.skipIf(!DB_URL)("the application through the browser", () => {
  let stack: RunningStack;
  let browser: Browser;
  const alice = privateKeyToAccount(generatePrivateKey()).address;
  const daveWallet = privateKeyToAccount(generatePrivateKey()).address;
  const ops = "ops@acme.test";
  const [a1, a2] = ["anna@acme.test", "boris@acme.test"];
  const pages: Record<string, Page> = {};
  let setupUrl: string;
  let account: Address;
  let orgUrl: string;
  let payoutUrl: string;
  let lastClaimUrl = "";
  let formUrl = "";
  let approveUrlSeen = "";
  let shotNo = 0;

  const mail = (to: string) => readDevMailbox(stack.db, to);
  const linkIn = async (to: string, subject: RegExp, base: string) => {
    const m = (await mail(to)).find((x) => subject.test(x.subject));
    if (!m) throw new Error(`no mail "${subject}" for ${to}`);
    // links from the demo backend carry ?mode=demo
    return m.body.match(new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\\?mode=demo)?#\\S+`))![0];
  };
  const balance = (who: Address) => stack.api.chain.pub.readContract({ address: stack.chain.token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const text = async (page: Page, testid: string) => ((await page.getByTestId(testid).textContent()) ?? "").replace(/\s/g, " ");

  /** Desktop and phone screenshots of the current screen, when SCREENSHOTS_DIR is set. */
  async function shot(page: Page, name: string, o: { dark?: boolean; phoneOnly?: boolean } = {}) {
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    const n = String(++shotNo).padStart(2, "0");
    if (o.dark) await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
    await page.waitForTimeout(250);
    if (!o.phoneOnly) await page.screenshot({ path: `${SHOTS}/${n}-${name}-desktop${o.dark ? "-dark" : ""}.png`, fullPage: true });
    const size = page.viewportSize();
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${n}-${name}-phone${o.dark ? "-dark" : ""}.png`, fullPage: true });
    if (size) await page.setViewportSize(size);
    if (o.dark) await page.emulateMedia({ colorScheme: "light" });
  }

  /** Email → code from the dev mailbox → in. Works on the cabinet and on the claim page (same LoginForm). */
  async function login(page: Page, email: string) {
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-start").click();
    await page.getByTestId("login-code").waitFor();
    const code = (await mail(email))[0]!.subject.match(/\d{6}/)![0];
    await page.getByTestId("login-code").fill(code);
    await page.getByTestId("login-verify").click();
  }
  const newPage = async () => (await browser.newContext({ viewport: DESKTOP, colorScheme: "light" })).newPage();
  const demoUrl = () => `${stack.urls.web}/?mode=demo`;
  async function person(email: string) {
    const page = await newPage();
    await page.goto(`${demoUrl()}#/`);
    await login(page, email);
    await expect.poll(() => page.getByTestId("me").textContent()).toContain(email);
    pages[email] = page;
    return page;
  }
  /** Signing goes through the emulator's confirmation window (Privy shows its own). */
  async function signIn(page: Page, button: string, screenshot?: string) {
    await page.getByTestId(button).click();
    await page.getByTestId("sign-modal").waitFor();
    await sheetFitsPhone(page);
    if (screenshot) await shot(page, screenshot);
    await page.getByTestId("sign-confirm").click();
  }
  const pendingMails = async () => (await mail(a1)).filter((m) => /waiting for your approval/.test(m.subject)).length;
  /** Clicks what creates a batch, waits for its "waiting for your approval" letter; a1 approves, a2 signs last and sends. */
  async function approveBoth(page: Page, button: string, confirm = false) {
    const before = await pendingMails();
    await page.getByTestId(button).click();
    if (confirm) await page.getByTestId("confirm-ok").click(); // revoke and new links are confirmed first
    await expect.poll(pendingMails, { timeout: 15_000 }).toBeGreaterThan(before);
    const url = await linkIn(a1, /waiting for your approval/, stack.urls.web);
    const p1 = pages[a1]!;
    await p1.goto(url);
    await p1.getByTestId("sign").waitFor();
    await signIn(p1, "sign");
    await p1.getByTestId("done").waitFor();
    const p2 = pages[a2]!;
    await p2.goto(url);
    await expect.poll(() => p2.getByTestId("sign").textContent()).toBe("Sign and send");
    await signIn(p2, "sign");
    await p2.getByTestId("closed").waitFor({ timeout: 30_000 });
  }
  async function statusOf(page: Page, name: string) {
    await page.getByTestId("refresh").click();
    return text(page, `status-${name}`);
  }
  /** The signature sheet is position:fixed, so the page width check cannot see it overflow — measure it directly. */
  async function sheetFitsPhone(page: Page) {
    const size = page.viewportSize();
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => { const b = document.querySelector(".sheet")!.getBoundingClientRect(); return { left: b.left, right: b.right, w: window.innerWidth }; });
    if (size) await page.setViewportSize(size);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.right, "signature sheet wider than the phone").toBeLessThanOrEqual(r.w);
  }
  /** No sideways scrolling at phone width — the check behind "works on a phone". */
  async function fitsPhone(page: Page, what: string) {
    const size = page.viewportSize();
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(200);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    if (size) await page.setViewportSize(size);
    expect(scroll, `${what}: page is ${scroll}px wide at ${client}px`).toBeLessThanOrEqual(client);
  }

  beforeAll(async () => {
    const zero = { anvil: 0, api: 0, privy: 0, onramp: 0, web: 0, claim: 0, bundler: 0, zerodev: 0 };
    stack = await startStack({ databaseUrl: DB_URL!, fork: process.env.STACK === "fork", forkUrl: process.env.FORK_URL, host: "127.0.0.1", ports: zero, tickMs: 1000 });
    browser = await chromium.launch({ executablePath: CHROMIUM });
  });

  afterAll(async () => {
    await browser?.close();
    await stack?.stop();
  });

  // ------------------------------------------------------------------ the main path

  it("flow 1: the creator names approvers; each joins and signs the set; the account is deployed", async () => {
    // always a choice: demo or real; real stays off until Privy and the network are configured
    const start = await newPage();
    await start.goto(`${stack.urls.web}/`);
    await start.getByTestId("mode-card-demo").waitFor();
    expect(await start.getByTestId("mode-real").isDisabled()).toBe(true);
    expect(await start.getByTestId("mode-real").textContent()).toBe("Not set up yet");
    await shot(start, "mode-choice");
    await start.getByTestId("mode-demo").click();
    await start.getByTestId("login-email").waitFor();
    expect(await start.textContent("body")).toContain("Demo mode");
    expect(await start.textContent("body")).not.toMatch(/emulat/i);
    await shot(start, "login");
    await start.context().close();

    const p = await person(ops);
    await p.getByTestId("demo-banner").waitFor();
    await shot(p, "home-empty");
    await p.getByTestId("new-org").click();
    await p.getByTestId("org-name").fill("Acme");
    await p.getByTestId("approver-0").fill(a1);
    await p.getByTestId("add-approver").click();
    await p.getByTestId("setup-start").click(); // an empty approver line is caught before anything is sent
    await expect.poll(() => text(p, "setup-problems")).toContain("Fill in every approver's email");
    await p.getByTestId("approver-1").fill(a2);
    await p.getByTestId("threshold").fill("2");
    await shot(p, "setup-new");
    await p.getByTestId("setup-start").click();
    await p.getByTestId("setup-view").waitFor();

    setupUrl = await linkIn(a1, /named a payout approver/, stack.urls.web);
    for (const e of [a1, a2]) {
      const page = await person(e);
      await page.goto(setupUrl);
      await page.getByTestId("setup-join").click();
      await expect.poll(() => page.getByText("not signed in yet").count()).toBeLessThan(2);
    }
    for (const e of [a1, a2]) {
      const page = pages[e]!;
      await page.reload();
      await page.getByTestId("confirm-check").waitFor();
      if (e === a1) await shot(page, "setup-confirm");
      await signIn(page, "setup-confirm", e === a1 ? "sign-modal" : undefined);
    }
    const last = pages[a2]!;
    await expect.poll(() => last.getByTestId("setup-status").textContent(), { timeout: 30_000 }).toContain("account created");
    account = (await last.getByTestId("setup-account").textContent()) as Address;
    expect(await stack.api.chain.pub.getCode({ address: account })).not.toBe("0x");
    await shot(last, "setup-deployed");
  });

  it("the operator tops the account up through the on-ramp widget (emulated)", async () => {
    const p = pages[ops]!;
    await p.goto(`${stack.urls.web}/`);
    await p.getByTestId("org-Acme").waitFor();
    await shot(p, "home");
    await p.getByTestId("org-Acme").click();
    orgUrl = p.url().replace(/\/[a-z]+$/, "");
    await p.getByTestId("tab-topup").click();
    expect(await p.getByTestId("topup-address").textContent()).toBe(account);
    await p.getByTestId("topup-qr").waitFor();
    await p.getByTestId("onramp-amount").fill("10000");
    await p.getByTestId("onramp-start").click();
    await p.getByTestId("onramp-open").waitFor();
    await shot(p, "topup");
    const [widget] = await Promise.all([p.context().waitForEvent("page"), p.getByTestId("onramp-open").click()]);
    expect(await widget.getByTestId("dest").textContent()).toBe(account);
    await widget.getByTestId("pay").click();
    await widget.getByTestId("done").waitFor();
    await widget.close();
    expect(await balance(account)).toBe(9_825_000_000n); // 10 000 minus the emulated 1.75 % fee
  });

  it("a spreadsheet as Excel saves it is imported; no title — no payout; bad rows are shown line by line", async () => {
    const p = pages[ops]!;
    await p.goto(`${orgUrl}/payouts`);
    await p.getByTestId("new-payout").click();
    await p.getByTestId("np-title").waitFor();
    // a title is required
    await p.getByTestId("np-create").click();
    await p.getByTestId("np-title-error").waitFor();
    expect(await p.getByTestId("np-create").isDisabled()).toBe(true);
    // bad rows: reported with their lines, nothing can be created
    await p.getByTestId("np-tab-paste").click();
    await p.getByTestId("np-paste").fill(`name\tamount\taddress\nAlice\t1,500\t${alice}\nBob\t5\t0x12`);
    await expect.poll(() => text(p, "np-errors"), { timeout: 10_000 }).toContain("line 2");
    expect(await text(p, "np-errors")).toContain("ambiguous");
    expect(await text(p, "np-errors")).toContain("line 3");
    await shot(p, "payout-new-errors");
    // the real file: BOM, semicolons, CRLF, decimal comma, columns in another order, no chain_id
    await p.getByTestId("np-tab-file").click();
    const excel = `\uFEFFName;Wallet;E-mail;Amount;Category\r\nAlice;${alice};;1 000,00;grants\r\nCarol;;carol@example.test;250;grants\r\nDave;;;10;grants\r\n`;
    await p.getByTestId("np-file").setInputFiles({ name: "september.csv", mimeType: "text/csv", buffer: Buffer.from(excel, "utf8") });
    await expect.poll(() => text(p, "np-summary"), { timeout: 10_000 }).toContain("3 rows");
    expect(await text(p, "np-summary")).toContain("1,260 USDC");
    expect(await p.getByTestId("np-errors").count()).toBe(0);
    await p.getByTestId("np-title").fill("September");
    await shot(p, "payout-new");
    await p.getByTestId("np-create").click();
    await p.getByTestId("review").waitFor();
    expect(await p.getByTestId("toast").first().textContent()).toContain("Payout created");
    payoutUrl = p.url();
    expect(await text(p, "review")).toContain("2 rows");
    await shot(p, "payout-review");
    await p.getByTestId("freeze").click();
    await expect.poll(async () => (await mail(a1)).some((m) => /waiting for your approval/.test(m.subject))).toBe(true);
  });

  it("2 of 2 in the cabinet: approve, then the final signature sends it", async () => {
    approveUrlSeen = await linkIn(a1, /waiting for your approval/, stack.urls.web);
    const p1 = pages[a1]!;
    // the approver does not need the email: home lists what waits for them
    await p1.goto(`${stack.urls.web}/#/`);
    await p1.getByTestId("pending-September").waitFor();
    expect(await text(p1, "pending-September")).toContain("1,250 USDC");
    await shot(p1, "home-waiting");
    await p1.goto(approveUrlSeen);
    await expect.poll(() => text(p1, "what")).toContain("1,250 USDC");
    await shot(p1, "approve");
    await signIn(p1, "sign");
    await p1.getByTestId("done").waitFor();
    // the operator sees who has signed, without refreshing
    const o0 = pages[ops]!;
    await o0.goto(payoutUrl);
    await expect.poll(() => text(o0, "approval-count"), { timeout: 10_000 }).toBe("1 of 2");
    await shot(o0, "payout-waiting");

    const p2 = pages[a2]!;
    await p2.goto(approveUrlSeen);
    await expect.poll(() => p2.getByTestId("sign").textContent()).toBe("Sign and send");
    await signIn(p2, "sign");
    await p2.getByTestId("closed").waitFor({ timeout: 30_000 });
    await expect.poll(() => balance(alice), { timeout: 30_000 }).toBe(1_000_000_000n);

    const o = pages[ops]!;
    await o.goto(payoutUrl);
    await expect.poll(() => statusOf(o, "Carol"), { timeout: 30_000 }).toBe("link sent, not claimed");
    expect(await text(o, "status-Alice")).toBe("sent");
    await shot(o, "payout-sent");
  });

  it("Carol opens the emailed link, logs in by email and receives into her embedded wallet", async () => {
    const link = await linkIn("carol@example.test", /you have been sent a payment/, stack.urls.claim);
    lastClaimUrl = link;
    const page = await newPage();
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url() + (r.postData() ?? "")));
    await page.goto(link);
    await expect.poll(() => page.getByTestId("amount").textContent()).toMatch(/^250 /);
    await page.getByTestId("demo-badge").waitFor(); // a demo payment says so; the recipient chooses nothing
    await shot(page, "claim");
    await login(page, "carol@example.test");
    const wallet = (await page.getByTestId("embedded-wallet").textContent()) as Address;
    await shot(page, "claim-logged-in");
    await page.getByTestId("claim-embedded").click();
    await page.getByTestId("done").waitFor({ timeout: 30_000 });
    expect(await balance(wallet)).toBe(250_000_000n);
    await shot(page, "claim-done");
    // the claim key in the fragment never left the browser
    const key = link.split("k=")[1]!.split("&")[0]!.replace(/^0x/, "");
    expect(requests.some((u) => u.includes(key))).toBe(false);
    await page.reload();
    await expect.poll(() => page.getByTestId("status").textContent()).toBe("This payment has already been claimed.");
    const o = pages[ops]!;
    await expect.poll(() => statusOf(o, "Carol"), { timeout: 30_000 }).toBe("claimed");
  });

  it("Dave gets a details form link and fills in his address; the row becomes ready", async () => {
    const o = pages[ops]!;
    await o.getByTestId("forms-create").click();
    formUrl = (await o.getByTestId("form-link-Dave").textContent())!;
    const page = await newPage();
    await page.goto(formUrl);
    await page.getByTestId("form-address").waitFor();
    await shot(page, "details-form");
    await page.getByTestId("form-address").fill(daveWallet);
    await page.getByTestId("form-submit").click();
    await page.getByTestId("form-done").waitFor();
    await expect.poll(() => statusOf(o, "Dave")).toBe("ready");
  });

  // ------------------------------------------------------------------ the rest of the cabinet

  it("address book: paid recipients are remembered; an entry is added by hand; a payout is built from the book", async () => {
    const p = pages[ops]!;
    await p.goto(`${orgUrl}/book`);
    await p.getByTestId("pick-Alice").waitFor();
    const frank = privateKeyToAccount(generatePrivateKey()).address;
    await p.getByTestId("book-name").fill("Frank");
    await p.getByTestId("book-address").fill(frank);
    await p.getByTestId("book-category").fill("contractors");
    await p.getByTestId("book-save").click();
    await p.getByTestId("pick-Frank").waitFor();
    await p.getByTestId("pick-Alice").fill("1200");
    await p.getByTestId("pick-Frank").fill("300");
    await p.getByTestId("book-payout-title").fill("October from the book");
    await shot(p, "address-book");
    await p.getByTestId("book-payout").click();
    await p.getByTestId("review").waitFor();
    expect(await text(p, "payout-title")).toBe("October from the book");
    expect(await text(p, "review")).toContain("1,500 USDC");
    expect(await text(p, "review")).toContain("Amount changed"); // Alice 1000 → 1200, seen against history
  });

  it("repeat a payout with edits: change an amount, add a row, remove a row", async () => {
    const p = pages[ops]!;
    await p.goto(payoutUrl);
    await p.getByTestId("repeat").click();
    await expect.poll(() => p.url()).not.toBe(payoutUrl);
    await p.getByTestId("edit-Alice").click();
    await p.getByTestId("row-amount-Alice").fill("1500");
    await shot(p, "payout-edit-row");
    await p.getByTestId("row-save-Alice").click();
    await expect.poll(() => text(p, "rows")).toContain("1,500 USDC");
    const gina = privateKeyToAccount(generatePrivateKey()).address;
    await p.getByTestId("add-name").fill("Gina");
    await p.getByTestId("add-address").fill(gina);
    await p.getByTestId("add-amount").fill("7");
    await p.getByTestId("add-row").click();
    await p.getByTestId("status-Gina").waitFor();
    await p.getByTestId("edit-Carol").click();
    await p.getByTestId("row-remove-Carol").click();
    await expect.poll(() => p.getByTestId("status-Carol").count()).toBe(0);
  });

  it("schedules: a payout becomes recurring; it can be paused and resumed", async () => {
    const p = pages[ops]!;
    await p.goto(payoutUrl);
    await p.getByTestId("every").selectOption("week");
    await p.getByTestId("schedule").click();
    await p.getByTestId("schedule-state-September").waitFor();
    expect(await text(p, "schedule-state-September")).toBe("active");
    await shot(p, "schedules");
    await p.getByTestId("schedule-toggle-September").click();
    await expect.poll(() => text(p, "schedule-state-September")).toBe("paused");
    await p.getByTestId("schedule-toggle-September").click();
    await expect.poll(() => text(p, "schedule-state-September")).toBe("active");
  });

  it("in the dashboard: new links for one unclaimed payment, revoke another; then close the payout", async () => {
    const p = pages[ops]!;
    const chainId = stack.chain.chainId;
    await p.goto(`${orgUrl}/payouts`);
    await p.getByTestId("new-payout").click();
    await p.getByTestId("np-title").fill("Stipends");
    await p.getByTestId("np-tab-manual").click(); // typed in, one per line
    await p.getByTestId("np-name-0").fill("Hana");
    await p.getByTestId("np-dest-0").fill("hana@example.test");
    await p.getByTestId("np-amount-0").fill("40");
    await p.getByTestId("np-name-1").fill("Ivan");
    await p.getByTestId("np-dest-1").fill("ivan@example.test");
    await p.getByTestId("np-amount-1").fill(`${chainId > 0 ? "60" : ""}`);
    await expect.poll(() => text(p, "np-summary"), { timeout: 10_000 }).toContain("2 rows");
    await p.getByTestId("np-create").click();
    await p.getByTestId("freeze").waitFor();
    const stipends = p.url();
    await approveBoth(p, "freeze");
    await p.goto(stipends);
    await expect.poll(() => statusOf(p, "Hana"), { timeout: 30_000 }).toBe("link sent, not claimed");
    const oldLink = await linkIn("hana@example.test", /you have been sent a payment/, stack.urls.claim);

    await p.getByTestId("pick-Hana").check();
    await shot(p, "payout-picked");
    await approveBoth(p, "rekey", true);
    await expect.poll(async () => (await mail("hana@example.test"))[0]!.subject, { timeout: 30_000 }).toMatch(/a new link to your payment/);
    expect(await linkIn("hana@example.test", /a new link/, stack.urls.claim)).not.toBe(oldLink);

    await p.goto(stipends);
    await expect.poll(() => statusOf(p, "Ivan")).toBe("link sent, not claimed");
    await p.getByTestId("pick-Ivan").check();
    await approveBoth(p, "revoke", true);
    await p.goto(stipends);
    await expect.poll(() => statusOf(p, "Ivan"), { timeout: 30_000 }).toBe("returned");

    await p.getByTestId("close").click();
    await p.getByTestId("confirm-modal").waitFor();
    await shot(p, "confirm-close");
    await p.getByTestId("confirm-ok").click();
    await expect.poll(() => text(p, "payout-status")).toBe("closed");
  });

  it("members: the admin invites an operator and removes them again", async () => {
    const p = pages[ops]!;
    await p.goto(`${orgUrl}/members`);
    await p.getByTestId("invite-email").fill("ops2@acme.test");
    await p.getByTestId("invite").click();
    await p.getByTestId("member-ops2@acme.test").waitFor();
    expect((await mail("ops2@acme.test"))[0]!.subject).toMatch(/invitation/);
    await shot(p, "members");
    await p.getByTestId("remove-ops2@acme.test").click();
    await p.getByTestId("confirm-ok").click();
    await expect.poll(() => p.getByTestId("member-ops2@acme.test").count()).toBe(0);
  });

  it("settings: the admin sets the default auto-refund; the audit log shows who changed what", async () => {
    const p = pages[ops]!;
    await p.goto(`${orgUrl}/settings`);
    await p.getByTestId("autorefund").fill("30");
    await p.getByTestId("settings-save").click();
    await p.getByTestId("settings-saved").waitFor();
    await shot(p, "settings");
    await p.goto(`${orgUrl}/audit`);
    await expect.poll(() => text(p, "audit-table")).toContain("settings changed");
    for (const t of ["account created", "payout created", "signed", "submitted on chain", "operator invited", "operator removed", "payout closed"]) expect(await text(p, "audit-table")).toContain(t);
    await shot(p, "audit");
    const a = pages[a1]!;
    await a.goto(`${orgUrl}/settings`);
    await expect(a.getByTestId("autorefund").isDisabled()).resolves.toBe(true); // approvers see, only the admin changes
  });

  it("reports: payments with USD value and source; the CSV export downloads", async () => {
    const p = pages[ops]!;
    await p.goto(`${orgUrl}/reports`);
    await expect.poll(() => text(p, "report-table")).toContain("Alice");
    expect(await text(p, "report-table")).toContain("Carol");
    await shot(p, "reports");
    const [download] = await Promise.all([p.waitForEvent("download"), p.getByTestId("csv").click()]);
    const csv = readFileSync((await download.path())!, "utf8");
    expect(csv.split("\n")[0]).toContain("Date");
    expect(csv).toContain("Alice");
    expect(download.suggestedFilename()).toBe("omniflow-Acme-payments.csv");
  });

  it("the dev mailbox lists the letters", async () => {
    const p = pages[ops]!;
    await p.goto(`${demoUrl()}#/demo/mailbox`);
    await expect.poll(() => p.getByTestId("mail").count()).toBeGreaterThan(5);
    await shot(p, "mailbox");
  });

  // ------------------------------------------------------------------ phone

  it("every main screen fits a 390 px phone without sideways scrolling", async () => {
    const o = pages[ops]!;
    const screens: [Page, string, string][] = [
      [o, `${stack.urls.web}/`, "orgs"],
      ...["payouts", "book", "schedules", "topup", "reports", "members", "settings", "audit"].map((t) => [o, `${orgUrl}/${t}`, t] as [Page, string, string]),
      [o, payoutUrl, "payout"],
      [o, `${orgUrl}/new`, "new payout"],
      [o, `${stack.urls.web}/#/setup/new`, "setup-new"],
      [pages[a1]!, setupUrl, "setup"],
      [pages[a1]!, approveUrlSeen, "approve"],
      [o, `${demoUrl()}#/demo/mailbox`, "mailbox"],
    ];
    for (const [page, url, what] of screens) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await fitsPhone(page, what);
    }
    const guest = await newPage();
    for (const [url, what] of [[formUrl, "details form"], [lastClaimUrl, "claim page"], [`${stack.urls.web}/`, "mode choice"]] as const) {
      await guest.goto(url);
      await guest.waitForLoadState("networkidle");
      await fitsPhone(guest, what);
    }
    await o.goto(`${orgUrl}/payouts`);
    await o.getByTestId("payouts").waitFor();
    await shot(o, "org", { dark: true });
    await shot(o, "org");
    await o.goto(payoutUrl);
    await o.getByTestId("rows").waitFor();
    await shot(o, "payout", { dark: true });
  });

  it("switching mode signs out and returns to the choice", async () => {
    const p = pages[ops]!;
    await p.goto(`${stack.urls.web}/#/`);
    await p.getByTestId("mode-badge").waitFor();
    await p.getByTestId("mode-switch").click();
    await p.getByTestId("mode-card-demo").waitFor();
    await p.getByTestId("mode-demo").click();
    await p.getByTestId("login-email").waitFor(); // signed out: the demo session did not survive the switch
  });
});
