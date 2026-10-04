import { DEMO, demoAccounts, HISTORY_DAYS, seedDemo } from "./seed.js";
import { startStack } from "./stack.js";

/**
 * EMULATION ONLY — `npm run dev:stack` from omniflow/.
 *   DEVSTACK_DATABASE_URL  postgres URL; the database name must end in _dev or _test (it is recreated on start)
 *   STACK=fork             anvil fork of Arbitrum Sepolia instead of a local chain from source
 *   FORK_URL               RPC for the fork (default: the public Arbitrum Sepolia RPC)
 *   SEED=0                 skip the demo organisation
 *   HISTORY=0              the demo organisation without its three months of payouts
 *   AA=self                the API bundles itself (default: ZeroDev emulator in front of the Alto bundler)
 *   EXAMPLES=0             no "Open a live example" (each example moves the demo chain's clock a day forward)
 *   EXAMPLE_POOL           live examples kept ready in advance (default 2)
 */
const databaseUrl = process.env.DEVSTACK_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DEVSTACK_DATABASE_URL is not set (postgres://USER:PASSWORD@127.0.0.1:5432/omniflow_dev)");
  process.exit(1);
}
const log = (s: string) => console.log(`· ${s}`);
const seeding = process.env.SEED !== "0";
const history = process.env.HISTORY !== "0";
const stack = await startStack({
  databaseUrl,
  fork: process.env.STACK === "fork",
  forkUrl: process.env.FORK_URL,
  aa: process.env.AA === "self" ? "self" : "zerodev",
  log,
  liveExamples: process.env.EXAMPLES === "0" ? undefined : { pool: Number(process.env.EXAMPLE_POOL ?? 2), deferStart: true },
  // the demo history happens on past dates: the local chain starts that many days ago and catches up to today
  chainStart: seeding && history ? Math.floor(Date.now() / 1000) - HISTORY_DAYS * 86_400 : undefined,
  demoAccounts: seeding ? demoAccounts(history) : undefined,
});

let demo: Awaited<ReturnType<typeof seedDemo>> | null = null;
if (process.env.SEED !== "0") {
  log(`demo: organisation "${DEMO.org}", ${DEMO.threshold} of ${DEMO.approvers.length}…`);
  demo = await seedDemo(stack, { history, travel: process.env.STACK !== "fork" });
}
stack.examples?.start();

console.log(`
Omniflow — everything is emulated (Privy, ZeroDev, mail, on-ramp, chain). Not Privy, not ZeroDev, not mainnet.

  dashboard          ${stack.urls.web}   (choose "Demo"; "Real" needs VITE_API_URL + VITE_PRIVY_APP_ID)
  claim page         ${stack.urls.claim}
  demo mailbox       ${stack.urls.web}/?mode=demo#/demo/mailbox   ← sign-in codes and every email
  API                ${stack.urls.api}
  Privy emulator     ${stack.urls.privy}
  on-ramp emulator   ${stack.urls.onramp}
  ZeroDev RPC (emu)  ${stack.urls.zerodev ?? "— the API sends operations itself (AA=self)"}
  chain (anvil)      ${stack.urls.rpc}  chainId ${stack.chain.chainId}
${
  demo
    ? `
  demo "${DEMO.org}": account ${demo.account}, ${Number(DEMO.usdc) / 1e6} test USDC${Object.keys(demo.payouts).length ? `
    history          ${Object.keys(demo.payouts).join(", ")}` : ""}
    operator/admin   ${DEMO.operator}
    approvers        ${DEMO.approvers.join(", ")}  (threshold ${DEMO.threshold})
    sign in: email → code from the dev mailbox`
    : ""
}
Ctrl+C — stop.`);

const stop = async () => {
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
