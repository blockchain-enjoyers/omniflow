import { DEMO, seedDemo } from "./seed.js";
import { startStack } from "./stack.js";

/**
 * EMULATION ONLY — `npm run dev:stack` from omniflow/.
 *   DEVSTACK_DATABASE_URL  postgres URL; the database name must end in _dev or _test (it is recreated on start)
 *   STACK=fork             anvil fork of Arbitrum Sepolia instead of a local chain from source
 *   FORK_URL               RPC for the fork (default: the public Arbitrum Sepolia RPC)
 *   SEED=0                 skip the demo organisation
 *   AA=self                the API bundles itself (default: ZeroDev emulator in front of the Alto bundler)
 */
const databaseUrl = process.env.DEVSTACK_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DEVSTACK_DATABASE_URL is not set (postgres://USER:PASSWORD@127.0.0.1:5432/omniflow_dev)");
  process.exit(1);
}
const log = (s: string) => console.log(`· ${s}`);
const stack = await startStack({ databaseUrl, fork: process.env.STACK === "fork", forkUrl: process.env.FORK_URL, aa: process.env.AA === "self" ? "self" : "zerodev", log });

let demo: Awaited<ReturnType<typeof seedDemo>> | null = null;
if (process.env.SEED !== "0") {
  log(`демо: организация «${DEMO.org}», ${DEMO.threshold} из ${DEMO.approvers.length}…`);
  demo = await seedDemo(stack);
}

console.log(`
Omniflow — всё эмулировано (Privy, ZeroDev, почта, он-рамп, сеть). Не Privy, не ZeroDev, не мейннет.

  кабинет         ${stack.urls.web}
  страница клейма ${stack.urls.claim}
  dev-ящик        ${stack.urls.web}/#/dev/mailbox   ← коды входа и все письма
  API             ${stack.urls.api}
  эмулятор Privy  ${stack.urls.privy}
  эмулятор он-рампа ${stack.urls.onramp}
  RPC ZeroDev (эмулятор) ${stack.urls.zerodev ?? "— API сам отправляет операции (AA=self)"}
  сеть (anvil)    ${stack.urls.rpc}  chainId ${stack.chain.chainId}
${
  demo
    ? `
  демо «${DEMO.org}»: аккаунт ${demo.account}, ${Number(DEMO.usdc) / 1e6} тестовых USDC
    оператор/админ   ${DEMO.operator}
    подтверждающие   ${DEMO.approvers.join(", ")}  (порог ${DEMO.threshold})
    вход: почта → код из dev-ящика`
    : ""
}
Ctrl+C — остановить.`);

const stop = async () => {
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
