import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { anvilKey, PAYMASTER_SIGNER_KEY, startAlto, startDevStack, SUBMITTER_KEY, type DevStack } from "@omniflow/devchain";
import { privateKeyToAccount } from "viem/accounts";
import { zerodevEmulator } from "@omniflow/zerodev-emulator";
import { PrivyEmulator } from "@omniflow/privy-emulator";
import { onrampEmulator } from "@omniflow/onramp-emulator";
import { compose } from "../../api/src/compose.js";
import { PrivyVerifier } from "../../api/src/auth/privy.js";
import { LiveExamples } from "./example.js";
import { startGateway } from "./gateway.js";

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
  ports?: Partial<Record<"anvil" | "api" | "privy" | "onramp" | "web" | "claim" | "bundler" | "zerodev", number>>;
  /**
   * "zerodev" (default): operations go the way they will in production — the ZeroDev EMULATOR's RPC in front of
   * a real bundler (Alto) on anvil. "self": the API calls EntryPoint.handleOps itself, with the local paymaster.
   */
  aa?: "zerodev" | "self";
  host?: string;
  /** scheduler period: indexer, keeper, schedules */
  tickMs?: number;
  log?: (s: string) => void;
  /** "Open a live example": per-visitor sandboxes (example.ts); `pool` = how many are kept ready in advance */
  liveExamples?: { pool: number; deferStart?: boolean };
  /** demo sign-in screen: ready accounts (email, role, what they will see) */
  demoAccounts?: { email: string; role: string; note?: string }[];
  /** local chain only: unix time of the first block (the demo history starts months ago and catches up to today) */
  chainStart?: number;
  /**
   * hosted demo: the public origin (https://…) and the port it reaches. Every browser-facing service is served from it
   * by path — dashboard at /, claim page /claim, API /api, sign-in /privy, on-ramp /onramp, chain RPC /rpc (read-only
   * methods; gateway.ts) — and links in emails point there.
   */
  publicUrl?: string;
  gatewayPort?: number;
  /** behind the hosting's own proxy: how many proxies sit in front of the gateway (so per-visitor limits see the visitor) */
  trustProxy?: number;
  /** another stack has claimed the database (prepareDatabase): this one's scheduler has stopped */
  onEvicted?: () => void;
}

export interface RunningStack {
  chain: DevStack;
  db: pg.Pool;
  emulator: PrivyEmulator;
  api: Awaited<ReturnType<typeof compose>>;
  urls: { rpc: string; api: string; privy: string; onramp: string; web: string; claim: string; zerodev: string | null; public: string | null };
  examples: LiveExamples | null;
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
 *
 * Two stacks on one database break each other: a host that starts the new one before it stops the old (a deploy)
 * lets the old scheduler write its own chain's state — the indexer cursor, refunds — into the new rows, and the new
 * stack's claims are never indexed. So the database has an owner, kept outside the schema that is dropped: the stack
 * that claims it last. A live owner (it checks in on every tick) gets `handoverMs` to notice and stop before the
 * schema goes.
 */
export async function prepareDatabase(url: string, owner = randomBytes(8).toString("hex"), handoverMs = 0): Promise<pg.Pool> {
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
  await db.query(
    `CREATE SCHEMA IF NOT EXISTS devstack;
     CREATE TABLE IF NOT EXISTS devstack.owner (one boolean PRIMARY KEY DEFAULT true CHECK (one), id text NOT NULL, seen timestamptz NOT NULL DEFAULT now())`,
  );
  const prev = await db.query(`SELECT id FROM devstack.owner WHERE seen > now() - interval '30 seconds'`);
  await db.query(`INSERT INTO devstack.owner (id) VALUES ($1) ON CONFLICT (one) DO UPDATE SET id=EXCLUDED.id, seen=now()`, [owner]);
  if (prev.rowCount && handoverMs) await new Promise((ok) => setTimeout(ok, handoverMs));
  await db.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  return db;
}

/** The owner checks in; false once another stack has claimed the database. */
async function stillOwner(db: pg.Pool, owner: string) {
  return Boolean((await db.query(`UPDATE devstack.owner SET seen=now() WHERE id=$1`, [owner])).rowCount);
}

function buildFrontend(app: "web" | "claim", env: Record<string, string>, base = "/") {
  // --base only when it is not the root: a shell on Windows may turn a bare "/" into a filesystem path
  execFileSync("npx", ["vite", "build", "--outDir", "dist-dev", "--emptyOutDir", ...(base === "/" ? [] : ["--base", base])], { cwd: resolve(OMNIFLOW, "apps", app), env: { ...process.env, ...env }, stdio: "pipe" });
  return resolve(OMNIFLOW, "apps", app, "dist-dev");
}

export async function startStack(o: StackOptions): Promise<RunningStack> {
  const log = o.log ?? (() => {});
  const host = o.host ?? "localhost";
  const p = { anvil: 8545, api: 3001, privy: 3010, onramp: 3020, web: 5173, claim: 5174, bundler: 4337, zerodev: 3030, ...o.ports };
  const servers: Server[] = [];
  const children: { kill(): void }[] = [];
  // what the browser and the emails see: the service's own port, or a path on the hosted demo's one origin
  const pub = o.publicUrl?.replace(/\/$/, "");
  const at = (path: string, port: number) => (pub ? `${pub}${path}` : `http://${host}:${port}`);
  const local = (port: number) => `http://127.0.0.1:${port}`;

  log(o.fork ? "anvil: Arbitrum Sepolia fork, deploying escrow and paymaster…" : "anvil: local chain, deploying the stack from source…");
  const chain = await startDevStack({ fork: o.fork, forkUrl: o.forkUrl, port: p.anvil || undefined, contractsDir: CONTRACTS, startTime: o.fork ? undefined : o.chainStart });
  const owner = randomBytes(8).toString("hex");
  const tickMs = o.tickMs ?? 3000;
  const db = await prepareDatabase(o.databaseUrl, owner, 2 * tickMs + 4000);

  try {
    // Privy EMULATOR (never Privy): email + code, ES256 tokens, a server-held embedded wallet.
    const emulator = new PrivyEmulator(db, { appId: "omniflow-dev", walletEncryptionKey: randomBytes(32).toString("hex") });
    await emulator.init();
    const privyApp = express();
    privyApp.use(emulator.router());
    const privySrv = await listen(privyApp, p.privy);
    servers.push(privySrv);
    const privyUrl = at("/privy", portOf(privySrv));

    // Static frontends: listen first so their URLs are known when the API and the bundles are configured.
    const webApp = express();
    const claimApp = express();
    const webSrv = await listen(webApp, p.web);
    const claimSrv = await listen(claimApp, p.claim);
    servers.push(webSrv, claimSrv);
    const webUrl = at("", portOf(webSrv));
    const claimUrl = at("/claim", portOf(claimSrv));
    if (o.trustProxy !== undefined) webApp.set("trust proxy", o.trustProxy + 1); // the hosting's proxies and the gateway

    const onApp = express();
    const onSrv = await listen(onApp, p.onramp);
    servers.push(onSrv);
    const onrampUrl = at("/onramp", portOf(onSrv));
    onApp.use(onrampEmulator({ publicUrl: onrampUrl, rpcUrl: chain.rpcUrl, token: chain.token, decimals: 6, feePercent: 1.75 }));

    let zerodevUrl: string | null = null;
    if ((o.aa ?? "zerodev") === "zerodev") {
      log("Alto bundler and ZeroDev RPC emulator…");
      // the demo chain clock is not the wall clock (a past history, examples moving it forward): no wall-clock expiry checks
      const alto = await startAlto(chain.rpcUrl, chain.entryPoint, { port: p.bundler || undefined, expirationCheck: false });
      children.push(alto.process);
      const zdApp = express();
      zdApp.use(zerodevEmulator({ bundlerUrl: alto.url, rpcUrl: chain.rpcUrl, paymaster: chain.paymaster, paymasterSignerKey: PAYMASTER_SIGNER_KEY, sponsorshipTtlSec: 0 }));
      const zdSrv = await listen(zdApp, p.zerodev);
      servers.push(zdSrv);
      zerodevUrl = `http://${host}:${portOf(zdSrv)}`;
    }

    const api = await compose({
      db,
      chain: { chainId: chain.chainId, rpcUrl: chain.rpcUrl, entryPoint: chain.entryPoint, submitterKey: SUBMITTER_KEY, bundlerUrl: zerodevUrl ?? undefined },
      deployment: { factory: chain.factory, validator: chain.validator, escrow: chain.escrow, token: chain.token },
      privy: { verifier: await PrivyVerifier.fromPem(emulator.verificationKey(), "omniflow-dev") },
      claimKeyEncryptionKey: randomBytes(32).toString("hex"),
      // every link this (demo) backend sends opens in demo mode
      urls: { app: `${webUrl}/?mode=demo`, claim: `${claimUrl}/?mode=demo`, form: `${webUrl}/?mode=demo` },
      paymaster: zerodevUrl ? { zerodev: { url: zerodevUrl } } : { local: { address: chain.paymaster, signerKey: PAYMASTER_SIGNER_KEY } },
      onramp: { emulatorUrl: local(portOf(onSrv)) }, // server to server; the widget link it returns is public
      devEndpoints: true,
      // no explorer: a demo chain's transactions exist nowhere else
      network: { name: "Demo network (test money)" },
      ...(o.trustProxy !== undefined ? { trustProxy: o.trustProxy + 1 } : {}),
    });
    await api.app.listen(p.api);
    const apiPort = (api.app.getHttpServer().address() as AddressInfo).port;
    const apiUrl = at("/api", apiPort);
    const anvilPort = Number(new URL(chain.rpcUrl).port);
    const rpcUrl = pub ? `${pub}/rpc` : chain.rpcUrl;

    // Same origin as the dashboard, so no CORS: the visitor's browser asks for a sandbox of its own.
    let examples: LiveExamples | null = null;
    if (o.liveExamples) {
      webApp.post("/demo/example", async (req, res) => {
        try {
          res.json(await examples!.take(req.ip ?? "?"));
        } catch (e) {
          res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message });
        }
      });
    }

    log("building the dashboard and the claim page…");
    webApp.use(
      express.static(
        // demo mode is served here; real mode appears when VITE_API_URL and VITE_PRIVY_APP_ID are in the environment
        buildFrontend("web", { VITE_DEMO_API_URL: apiUrl, VITE_DEMO_AUTH_URL: privyUrl, ...(o.demoAccounts ? { VITE_DEMO_ACCOUNTS: JSON.stringify(o.demoAccounts) } : {}), ...(o.liveExamples ? { VITE_DEMO_EXAMPLE_URL: `${webUrl}/demo/example` } : {}) }),
      ),
    );
    claimApp.use(
      express.static(
        buildFrontend("claim", { VITE_DEMO_RELAYER_URL: apiUrl, VITE_DEMO_AUTH_URL: privyUrl, VITE_DEMO_RPC: rpcUrl, VITE_DEMO_MAILBOX_URL: `${webUrl}/?mode=demo#/demo/mailbox` }, pub ? "/claim/" : "/"),
      ),
    );

    // the hosted demo's one public port, opened last: until then the hosting sees nothing listening
    if (pub) {
      const gw = await startGateway(
        o.gatewayPort ?? 8080,
        [
          { prefix: "/api", port: apiPort },
          { prefix: "/privy", port: portOf(privySrv) },
          { prefix: "/onramp", port: portOf(onSrv) },
          { prefix: "/claim", port: portOf(claimSrv) },
          // the stack's own accounts (deployer, submitter, paymaster signer, bundler…): anvil's first development keys
          { prefix: "/rpc", port: anvilPort, rpc: { blockedSenders: Array.from({ length: 10 }, (_, i) => privateKeyToAccount(anvilKey(i)).address) } },
        ],
        portOf(webSrv),
      );
      servers.push(gw);
      log(`public demo: ${pub} (gateway on port ${portOf(gw)})`);
    }

    // Scheduler: indexer + keeper + recurring payouts. Every step is idempotent.
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        if (!(await stillOwner(db, owner))) {
          clearInterval(timer);
          examples?.stop();
          log("another stack has claimed the database: this one stops writing to it");
          o.onEvicted?.();
          return;
        }
        await api.tick();
      } catch (e) {
        log(`tick: ${(e as Error).message}`);
      } finally {
        running = false;
      }
    }, tickMs);

    const result: RunningStack = {
      chain,
      db,
      emulator,
      api,
      // api and privy: how this process (the seed, live examples) reaches them — inside the machine when hosted
      urls: { rpc: chain.rpcUrl, api: pub ? local(apiPort) : apiUrl, privy: pub ? local(portOf(privySrv)) : privyUrl, onramp: onrampUrl, web: webUrl, claim: claimUrl, zerodev: zerodevUrl, public: pub ?? null },
      examples: null,
      async stop() {
        clearInterval(timer);
        examples?.stop();
        await api.app.close();
        for (const s of servers) s.close();
        for (const c of children) c.kill();
        await db.end();
        chain.anvil.kill();
      },
    };
    if (o.liveExamples) {
      examples = new LiveExamples(result, { pool: o.liveExamples.pool, log });
      result.examples = examples;
      // a seeded history moves the chain clock; examples move it too, so they start after it
      if (!o.liveExamples.deferStart) examples.start();
    }
    return result;
  } catch (e) {
    for (const s of servers) s.close();
    for (const c of children) c.kill();
    await db.end();
    chain.anvil.kill();
    throw e;
  }
}
