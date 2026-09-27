import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { erc20Abi, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readDevMailbox } from "@omniflow/devmail";
import { startStack, type RunningStack } from "@omniflow/devstack";

/**
 * The whole application in a real browser, everything external EMULATED (Privy, mail, on-ramp, chain):
 * login → flow 1 (approvers join and confirm the set) → top-up via the on-ramp widget → CSV payout → review →
 * 2-of-2 in the cabinet → the recipient claims by email login into the embedded wallet → details form → reports.
 * STACK=fork runs it on an anvil fork of Arbitrum Sepolia (Kernel 0.3.1, Circle USDC).
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

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
  let payoutUrl: string;

  const mail = (to: string) => readDevMailbox(stack.db, to);
  const linkIn = async (to: string, subject: RegExp, base: string) => {
    const m = (await mail(to)).find((x) => subject.test(x.subject));
    if (!m) throw new Error(`no mail "${subject}" for ${to}`);
    return m.body.match(new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/#\\S+`))![0];
  };
  const balance = (who: Address) => stack.api.chain.pub.readContract({ address: stack.chain.token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  /** Email → code from the dev mailbox → in. Works on the cabinet and on the claim page (same LoginForm). */
  async function login(page: Page, email: string) {
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-start").click();
    await page.getByTestId("login-code").waitFor();
    const code = (await mail(email))[0]!.subject.match(/\d{6}/)![0];
    await page.getByTestId("login-code").fill(code);
    await page.getByTestId("login-verify").click();
  }
  async function person(email: string) {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${stack.urls.web}/`);
    await login(page, email);
    await expect.poll(() => page.getByTestId("me").textContent()).toContain(email);
    pages[email] = page;
    return page;
  }
  /** Signing goes through the emulator's confirmation window (Privy shows its own). */
  async function signIn(page: Page, button: string) {
    await page.getByTestId(button).click();
    await page.getByTestId("sign-modal").waitFor();
    await page.getByTestId("sign-confirm").click();
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

  it("flow 1: the creator names approvers; each joins and signs the set; the account is deployed", async () => {
    const p = await person(ops);
    await p.getByTestId("new-org").click();
    await p.getByTestId("org-name").fill("Acme");
    await p.getByTestId("approver-0").fill(a1);
    await p.getByTestId("add-approver").click();
    await p.getByTestId("approver-1").fill(a2);
    await p.getByTestId("threshold").fill("2");
    await p.getByTestId("setup-start").click();
    await p.getByTestId("setup-view").waitFor();

    setupUrl = await linkIn(a1, /назначили подтверждающим/, stack.urls.web);
    for (const e of [a1, a2]) {
      const page = await person(e);
      await page.goto(setupUrl);
      await page.getByTestId("setup-join").click();
      await expect.poll(() => page.getByText("ещё не вошёл").count()).toBeLessThan(2);
    }
    for (const e of [a1, a2]) {
      const page = pages[e]!;
      await page.reload();
      await page.getByTestId("confirm-check").waitFor();
      await signIn(page, "setup-confirm");
    }
    const last = pages[a2]!;
    await expect.poll(() => last.getByTestId("setup-status").textContent(), { timeout: 30_000 }).toContain("аккаунт создан");
    account = (await last.getByTestId("setup-account").textContent()) as Address;
    expect(await stack.api.chain.pub.getCode({ address: account })).not.toBe("0x");
  });

  it("the operator tops the account up through the on-ramp widget (emulated)", async () => {
    const p = pages[ops]!;
    await p.goto(`${stack.urls.web}/`);
    await p.getByTestId("org-Acme").click();
    await p.getByTestId("tab-topup").click();
    expect(await p.getByTestId("topup-address").textContent()).toBe(account);
    await p.getByTestId("topup-qr").waitFor();
    await p.getByTestId("onramp-amount").fill("10000");
    await p.getByTestId("onramp-start").click();
    const [widget] = await Promise.all([p.context().waitForEvent("page"), p.getByTestId("onramp-open").click()]);
    expect(await widget.getByTestId("dest").textContent()).toBe(account);
    await widget.getByTestId("pay").click();
    await widget.getByTestId("done").waitFor();
    expect(await balance(account)).toBe(9_825_000_000n); // 10 000 minus the emulated 1.75 % fee
  });

  it("CSV → review → send for approval; approvers are notified", async () => {
    const p = pages[ops]!;
    await p.getByTestId("tab-payouts").click();
    const chainId = stack.chain.chainId;
    await p.getByTestId("payout-title").fill("September");
    await p.getByTestId("payout-csv").fill(["name,email,address,chain_id,amount,category", `Alice,,${alice},${chainId},1000,grants`, `Carol,carol@example.test,,${chainId},250,grants`, `Dave,,,${chainId},10,grants`].join("\n"));
    await p.getByTestId("payout-create").click();
    await p.getByTestId("review").waitFor();
    payoutUrl = p.url();
    expect(await p.getByTestId("review").textContent()).toContain("2 строк");
    await p.getByTestId("freeze").click();
    await expect.poll(async () => (await mail(a1)).some((m) => /ждёт вашего подтверждения/.test(m.subject))).toBe(true);
  });

  it("2 of 2 in the cabinet: approve, then the final signature sends it", async () => {
    const approveUrl = await linkIn(a1, /ждёт вашего подтверждения/, stack.urls.web);
    const p1 = pages[a1]!;
    await p1.goto(approveUrl);
    // ru-RU groups thousands with a no-break space
    await expect.poll(async () => (await p1.getByTestId("what").textContent())?.replace(/\s/g, " ")).toContain("1 250 USDC");
    await signIn(p1, "sign");
    await p1.getByTestId("done").waitFor();

    const p2 = pages[a2]!;
    await p2.goto(approveUrl);
    await expect.poll(() => p2.getByTestId("sign").textContent()).toBe("Подписать и отправить");
    await signIn(p2, "sign");
    await p2.getByTestId("closed").waitFor({ timeout: 30_000 });
    await expect.poll(() => balance(alice), { timeout: 30_000 }).toBe(1_000_000_000n);

    const ops_ = pages[ops]!;
    await ops_.goto(payoutUrl);
    await expect.poll(async () => { await ops_.getByTestId("refresh").click(); return ops_.getByTestId("status-Carol").textContent(); }, { timeout: 30_000 }).toBe("по ссылке, не получено");
    expect(await ops_.getByTestId("status-Alice").textContent()).toBe("отправлено");
  });

  it("Carol opens the emailed link, logs in by email and receives into her embedded wallet", async () => {
    const link = await linkIn("carol@example.test", /вам отправлен платёж/, stack.urls.claim);
    const page = await (await browser.newContext()).newPage();
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url() + (r.postData() ?? "")));
    await page.goto(link);
    await expect.poll(() => page.getByTestId("amount").textContent()).toMatch(/^250 /);
    await login(page, "carol@example.test");
    const wallet = (await page.getByTestId("embedded-wallet").textContent()) as Address;
    await page.getByTestId("claim-embedded").click();
    await page.getByTestId("done").waitFor({ timeout: 30_000 });
    expect(await balance(wallet)).toBe(250_000_000n);
    // the claim key in the fragment never left the browser
    const key = link.split("k=")[1]!.split("&")[0]!.replace(/^0x/, "");
    expect(requests.some((u) => u.includes(key))).toBe(false);
    await page.reload();
    await expect.poll(() => page.getByTestId("status").textContent()).toBe("Платёж уже получен.");
    const ops_ = pages[ops]!;
    await expect.poll(async () => { await ops_.getByTestId("refresh").click(); return ops_.getByTestId("status-Carol").textContent(); }, { timeout: 30_000 }).toBe("получено");
  });

  it("Dave gets a details form link and fills in his address; the row becomes ready", async () => {
    const ops_ = pages[ops]!;
    await ops_.getByTestId("forms-create").click();
    const link = (await ops_.getByTestId("form-link-Dave").textContent())!;
    const page = await (await browser.newContext()).newPage();
    await page.goto(link);
    await page.getByTestId("form-address").fill(daveWallet);
    await page.getByTestId("form-submit").click();
    await page.getByTestId("form-done").waitFor();
    await expect.poll(async () => { await ops_.getByTestId("refresh").click(); return ops_.getByTestId("status-Dave").textContent(); }).toBe("готова");
  });

  it("reports list the payments with USD value and source; the dev mailbox shows the letters", async () => {
    const p = pages[ops]!;
    await p.goto(`${stack.urls.web}/`);
    await p.getByTestId("org-Acme").click();
    await p.getByTestId("tab-reports").click();
    await expect.poll(() => p.getByTestId("report-table").textContent()).toContain("Alice");
    expect(await p.getByTestId("report-table").textContent()).toContain("Carol");
    await p.goto(`${stack.urls.web}/#/dev/mailbox`);
    await expect.poll(() => p.getByTestId("mail").count()).toBeGreaterThan(5);
  });
});
