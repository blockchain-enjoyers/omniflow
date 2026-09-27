import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { createPublicClient, createWalletClient, erc20Abi, http, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { claimEscrowAbi, depositId, formatClaimLink, generateClaimKey } from "@omniflow/shared";
import { DEPLOYER_KEY, FORK, mintToken, SUBMITTER_KEY, startLocalStack, type LocalStack } from "../../api/test/helpers.js";

/**
 * Claim without Omniflow in a real browser: the static claim page, a local chain and the recipient's own wallet.
 * No Omniflow API, no database — only the link.
 */
const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..");
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

describe("claim page without Omniflow", () => {
  let stack: LocalStack;
  let preview: ChildProcess;
  let browser: Browser;
  const port = 5300 + Math.floor(Math.random() * 300);

  beforeAll(async () => {
    const approver = privateKeyToAccount(generatePrivateKey()).address;
    stack = await startLocalStack([approver], 1);
    execFileSync("npx", ["vite", "build", "--outDir", "dist-test"], { cwd: APP, env: { ...process.env, VITE_RPC_31337: stack.rpcUrl, VITE_RPC_421614: stack.rpcUrl }, stdio: "pipe" });
    preview = spawn("npx", ["vite", "preview", "--outDir", "dist-test", "--port", String(port), "--strictPort"], { cwd: APP, stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    browser = await chromium.launch({ executablePath: CHROMIUM });
  });

  afterAll(async () => {
    await browser?.close();
    preview?.kill();
    stack?.anvil.kill();
  });

  it("recipient opens the link and claims with their own wallet", async () => {
    // A depositor funds a deposit directly (the org account path is covered by the API e2e).
    const chainId = FORK ? 421614 : 31337;
    const chain = { id: chainId, name: "anvil", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [stack.rpcUrl] } } };
    const dep = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain, transport: http(stack.rpcUrl) });
    const pub = createPublicClient({ chain, transport: http(stack.rpcUrl) });
    const key = generateClaimKey();
    const id = depositId(dep.account.address, "page-test", "row-1");
    await mintToken(stack, dep.account.address, 3_000_000_000n);
    const symbol = await pub.readContract({ address: stack.token, abi: erc20Abi, functionName: "symbol" });
    for (const h of [
      await dep.writeContract({ address: stack.token, abi: erc20Abi, functionName: "approve", args: [stack.escrow, 3_000_000_000n] }),
      await dep.writeContract({ address: stack.escrow, abi: claimEscrowAbi, functionName: "deposit", args: [id, stack.token, 3_000_000_000n, 0n, key.address, 0] }),
    ]) {
      await pub.waitForTransactionReceipt({ hash: h });
    }

    const recipient = privateKeyToAccount(SUBMITTER_KEY).address as Address; // an unlocked anvil account = "own wallet"
    const url = formatClaimLink(`http://127.0.0.1:${port}/`, { chainId, escrow: stack.escrow, depositId: id, key: key.privateKey });
    const page = await browser.newPage();
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    // Minimal EIP-1193 wallet: forwards to anvil, where the account is unlocked.
    await page.addInitScript(
      ([rpc, addr, chainHex]) => {
        (window as unknown as { ethereum: unknown }).ethereum = {
          request: async ({ method, params }: { method: string; params?: unknown[] }) => {
            if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
            if (method === "eth_chainId") return chainHex;
            const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }) });
            const j = await r.json();
            if (j.error) throw new Error(j.error.message);
            return j.result;
          },
        };
      },
      [stack.rpcUrl, recipient, `0x${chainId.toString(16)}`] as const,
    );
    await page.goto(url);
    await expect.poll(async () => page.getByTestId("amount").textContent()).toBe(`3000 ${symbol}`);

    const before = await pub.readContract({ address: stack.token, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
    await page.getByTestId("claim-wallet").click();
    await page.getByTestId("done").waitFor({ timeout: 30_000 });
    const after = await pub.readContract({ address: stack.token, abi: erc20Abi, functionName: "balanceOf", args: [recipient] });
    expect(after - before).toBe(3_000_000_000n);

    // The key never left the browser: no request carried the fragment.
    expect(requests.some((u) => u.includes(key.privateKey.slice(2)))).toBe(false);

    // Reopening the used link says so.
    await page.reload();
    await expect.poll(async () => page.getByTestId("status").textContent()).toBe("Платёж уже получен.");
  });

  it("a broken link is reported, not crashed", async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/#c=1&e=0x1`);
    await expect.poll(async () => page.locator("h1").textContent()).toBe("Ссылка повреждена");
  });
});
