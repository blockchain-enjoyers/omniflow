import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright-core";
import { createPublicClient, erc20Abi, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createDb, migrate, type Db } from "../../api/src/db/db.js";
import { ChainClient } from "../../api/src/chain/chain.js";
import { ClaimKeyVault } from "../../api/src/claimkeys/vault.js";
import { MemoryMailer } from "../../api/src/mail/mailer.js";
import { PayoutService } from "../../api/src/payouts/service.js";
import { createApp } from "../../api/src/http/app.js";
import { FORK, startLocalStack, SUBMITTER_KEY, type LocalStack } from "../../api/test/helpers.js";

const CHAIN = FORK ? 421614 : 31337;

/** The approved slice through the UI: operator → review → two approvers sign in the cabinet → receipt. */
const DB_URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..");

describe.skipIf(!DB_URL)("slice through the cabinet UI", () => {
  const keys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
  const approvers = keys.map((k) => privateKeyToAccount(k).address);
  const alice = privateKeyToAccount(generatePrivateKey()).address;
  let stack: LocalStack;
  let db: Db;
  let api: Awaited<ReturnType<typeof createApp>>;
  let apiUrl: string;
  let preview: ChildProcess;
  let browser: Browser;
  let orgId: string;
  let service: PayoutService;
  const port = 5600 + Math.floor(Math.random() * 300);

  beforeAll(async () => {
    stack = await startLocalStack(approvers, 2);
    db = createDb(DB_URL!);
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db);
    const chain = new ChainClient({ chainId: CHAIN, rpcUrl: stack.rpcUrl, entryPoint: stack.entryPoint, submitterKey: SUBMITTER_KEY });
    service = new PayoutService(db, chain, new ClaimKeyVault(randomBytes(32).toString("hex")), new MemoryMailer(), {
      tokenDecimals: 6, claimTip: 50_000n, maxRowsPerBatch: 40, claimBaseUrl: "http://claim.local/", senderDisplayName: (n) => n,
    });
    orgId = (await service.createOrg({ name: "Acme", account: stack.account, validator: stack.validator, escrow: stack.escrow, token: stack.token, approvers: approvers.map((a) => ({ address: a as Address, weight: 1 })) })).id;
    api = await createApp(service, chain);
    await api.listen(0);
    apiUrl = `http://127.0.0.1:${(api.getHttpServer().address() as AddressInfo).port}`;

    execFileSync("npx", ["vite", "build", "--mode", "e2e", "--outDir", "dist-test"], { cwd: APP, env: { ...process.env, VITE_API_URL: apiUrl, VITE_PRIVY_APP_ID: "" }, stdio: "pipe" });
    preview = spawn("npx", ["vite", "preview", "--outDir", "dist-test", "--port", String(port), "--strictPort"], { cwd: APP, stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  });

  afterAll(async () => {
    await browser?.close();
    preview?.kill();
    await api?.close();
    await db?.end();
    stack?.anvil.kill();
  });

  async function approveAs(page: Page, key: string, batchId: string) {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId("tab-approver").click();
    await page.getByTestId("dev-key").fill(key);
    await page.getByTestId("dev-login").click();
    await page.getByTestId("batch").fill(batchId);
    await page.getByTestId("load").click();
    await expect.poll(() => page.getByTestId("what").textContent()).toContain("1000 USDC");
    await page.getByTestId("sign").click();
    await page.getByTestId("msg").waitFor();
    return page.getByTestId("msg").textContent();
  }

  it("operator uploads, reviews and freezes; two approvers sign; money arrives", async () => {
    const op = await browser.newPage();
    await op.goto(`http://127.0.0.1:${port}/`);
    await op.getByTestId("org").fill(orgId);
    await op.getByTestId("title").fill("October");
    await op.getByTestId("csv").fill(`name,email,address,chain_id,amount\nAlice,,${alice},${CHAIN},1000\nNobody,,,${CHAIN},5`);
    await op.getByTestId("create").click();
    const review = op.getByTestId("review");
    await review.waitFor();
    expect(await review.textContent()).toContain("Новые получатели: 1");
    expect(await review.textContent()).toContain("Не уйдут: 1");
    await op.getByTestId("freeze").click();
    const batchId = (await op.getByTestId("batch-id").textContent())!.trim();

    const a1 = await browser.newPage();
    expect(await approveAs(a1, keys[0]!, batchId)).toContain("Подтверждение принято");
    const a2 = await browser.newPage();
    expect(await approveAs(a2, keys[1]!, batchId)).toContain("Отправлено: 0x");

    await service.settleBatch((await service.batchesOf((await db.query("SELECT payout_id FROM batches WHERE id=$1", [batchId])).rows[0].payout_id))[0].id);
    const pub = createPublicClient({ transport: http(stack.rpcUrl) });
    expect(await pub.readContract({ address: stack.token, abi: erc20Abi, functionName: "balanceOf", args: [alice] })).toBe(1_000_000_000n);

    await op.getByTestId("refresh-receipt").click();
    await expect.poll(() => op.getByTestId("status-Alice").textContent()).toBe("sent");
    expect(await op.getByTestId("status-Nobody").textContent()).toBe("waiting_details");

    // the third approver arrives late: nothing left to sign
    const a3 = await browser.newPage();
    await a3.goto(`http://127.0.0.1:${port}/`);
    await a3.getByTestId("tab-approver").click();
    await a3.getByTestId("dev-key").fill(keys[2]!);
    await a3.getByTestId("dev-login").click();
    await a3.getByTestId("batch").fill(batchId);
    await a3.getByTestId("load").click();
    await expect.poll(() => a3.getByTestId("closed").textContent()).toBe("Подписывать нечего: партия уже исполнена.");
    expect(await a3.getByTestId("sign").count()).toBe(0);
  });
});
