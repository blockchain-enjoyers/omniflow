import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { PAYMASTER_SIGNER_KEY, startDevStack, SUBMITTER_KEY, type DevStack } from "@omniflow/devchain";
import { PrivyEmulator } from "@omniflow/privy-emulator";
import { onrampEmulator } from "@omniflow/onramp-emulator";
import { compose } from "../../api/src/compose.js";
import { PrivyVerifier } from "../../api/src/auth/privy.js";

/**
 * EMULATION ONLY. Brings the whole application up on one machine: anvil (from source or a
 * fork of Arbitrum Sepolia), the contract stack, the Privy emulator, the on-ramp emulator, the API with its scheduler,
 * the cabinet and the claim page. Nothing here talks to a live network except the fork's read-only RPC.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const OMNIFLOW = resolve(here, "../../..");
const CONTRACTS = resolve(OMNIFLOW, "contracts");

export interface StackOptions {
  databaseUrl: string;
  fork?: boolean;
  forkUrl?: string;
  /** 0 = pick a free port (tests) */
  ports?: Partial<Record<"anvil" | "api" | "privy" | "onramp" | "web" | "claim", number>>;
  host?: string;
  /** scheduler period: indexer, keeper, schedules */
  tickMs?: number;
  log?: (s: string) => void;
}

export interface RunningStack {
  chain: DevStack;
  db: pg.Pool;
  emulator: PrivyEmulator;
  api: Awaited<ReturnType<typeof compose>>;
  urls: { rpc: string; api: string; privy: string; onramp: string; web: string; claim: string };
  stop(): Promise<void>;
}

const listen = (app: express.Express, port: number) =>
  new Promise<Server>((ok, fail) => {
    const s = app.listen(port, () => ok(s));
    s.on("error", fail);
  });
const portOf = (s: Server) => (s.address() as AddressInfo).port;

/**
 * The dev database is recreated on every start (the chain is fresh too, so old rows would point at nothing). To keep
 * a real database safe, only a database whose name ends in `_dev` or `_test` is ever dropped.
 */
export async function prepareDatabase(url: string): Promise<pg.Pool> {
  const u = new URL(url);
  const name = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!/_(dev|test)$/.test(name)) throw new Error(`refusing to reset database "${name}": the dev stack only resets databases named *_dev or *_test`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const a = new pg.Client({ connectionString: admin.toString() });
  await a.connect();
  try {
    const exists = await a.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
    if (!exists.rowCount) await a.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
  } finally {
    await a.end();
  }
  const db = new pg.Pool({ connectionString: url });
  await db.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  return db;
}

function buildFrontend(app: "web" | "claim", env: Record<string, string>) {
  execFileSync("npx", ["vite", "build", "--outDir", "dist-dev", "--emptyOutDir"], { cwd: resolve(OMNIFLOW, "apps", app), env: { ...process.env, ...env }, stdio: "pipe" });
  return resolve(OMNIFLOW, "apps", app, "dist-dev");
}

export async function startStack(o: StackOptions): Promise<RunningStack> {
  const log = o.log ?? (() => {});
  const host = o.host ?? "localhost";
  const p = { anvil: 8545, api: 3001, privy: 3010, onramp: 3020, web: 5173, claim: 5174, ...o.ports };
  const servers: Server[] = [];

  log(o.fork ? "anvil: форк Arbitrum Sepolia, развёртывание эскроу и paymaster…" : "anvil: локальная сеть, развёртывание стека из исходников…");
  const chain = await startDevStack({ fork: o.fork, forkUrl: o.forkUrl, port: p.anvil || undefined, contractsDir: CONTRACTS });
  const db = await prepareDatabase(o.databaseUrl);

  try {
    // Privy EMULATOR (never Privy): email + code, ES256 tokens, a server-held embedded wallet.
    const emulator = new PrivyEmulator(db, { appId: "omniflow-dev", walletEncryptionKey: randomBytes(32).toString("hex") });
    await emulator.init();
    const privyApp = express();
    privyApp.use(emulator.router());
    const privySrv = await listen(privyApp, p.privy);
    servers.push(privySrv);
    const privyUrl = `http://${host}:${portOf(privySrv)}`;

    // Static frontends: listen first so their URLs are known when the API and the bundles are configured.
    const webApp = express();
    const claimApp = express();
    const webSrv = await listen(webApp, p.web);
    const claimSrv = await listen(claimApp, p.claim);
    servers.push(webSrv, claimSrv);
    const webUrl = `http://${host}:${portOf(webSrv)}`;
    const claimUrl = `http://${host}:${portOf(claimSrv)}`;

    const onApp = express();
    const onSrv = await listen(onApp, p.onramp);
    servers.push(onSrv);
    const onrampUrl = `http://${host}:${portOf(onSrv)}`;
    onApp.use(onrampEmulator({ publicUrl: onrampUrl, rpcUrl: chain.rpcUrl, token: chain.token, decimals: 6, feePercent: 1.75 }));

    const api = await compose({
      db,
      chain: { chainId: chain.chainId, rpcUrl: chain.rpcUrl, entryPoint: chain.entryPoint, submitterKey: SUBMITTER_KEY },
      deployment: { factory: chain.factory, validator: chain.validator, escrow: chain.escrow, token: chain.token },
      privy: { verifier: await PrivyVerifier.fromPem(emulator.verificationKey(), "omniflow-dev") },
      claimKeyEncryptionKey: randomBytes(32).toString("hex"),
      urls: { app: `${webUrl}/`, claim: `${claimUrl}/`, form: `${webUrl}/` },
      paymaster: { local: { address: chain.paymaster, signerKey: PAYMASTER_SIGNER_KEY } },
      onramp: { emulatorUrl: onrampUrl },
      devEndpoints: true,
    });
    await api.app.listen(p.api);
    const apiUrl = `http://${host}:${(api.app.getHttpServer().address() as AddressInfo).port}`;

    log("сборка кабинета и страницы клейма…");
    webApp.use(
      express.static(
        buildFrontend("web", { VITE_API_URL: apiUrl, VITE_PRIVY_EMULATOR_URL: privyUrl, VITE_PRIVY_APP_ID: "", VITE_DEV_TOOLS: "1", VITE_CHAIN_NAME: o.fork ? "Arbitrum Sepolia (форк)" : "локальная сеть" }),
      ),
    );
    claimApp.use(
      express.static(
        buildFrontend("claim", { VITE_RELAYER_URL: apiUrl, VITE_PRIVY_EMULATOR_URL: privyUrl, VITE_PRIVY_APP_ID: "", [`VITE_RPC_${chain.chainId}`]: chain.rpcUrl }),
      ),
    );

    // Scheduler: indexer + keeper + recurring payouts. Every step is idempotent.
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await api.tick();
      } catch (e) {
        log(`tick: ${(e as Error).message}`);
      } finally {
        running = false;
      }
    }, o.tickMs ?? 3000);

    return {
      chain,
      db,
      emulator,
      api,
      urls: { rpc: chain.rpcUrl, api: apiUrl, privy: privyUrl, onramp: onrampUrl, web: webUrl, claim: claimUrl },
      async stop() {
        clearInterval(timer);
        await api.app.close();
        for (const s of servers) s.close();
        await db.end();
        chain.anvil.kill();
      },
    };
  } catch (e) {
    for (const s of servers) s.close();
    await db.end();
    chain.anvil.kill();
    throw e;
  }
}
