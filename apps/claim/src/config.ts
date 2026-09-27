/**
 * The page is static and must work when Omniflow is gone. Everything below is optional.
 *
 * Demo or real: the recipient does not choose — links sent by the demo backend carry
 * `?mode=demo`, and such a payment lives on the demo network. Everything else is the real page.
 * - RPC: a public RPC per chain; the recipient can also paste their own (the field on the page).
 * - Relayer: Omniflow's relayer pays gas for the claim and earns the tip; without it the recipient's own wallet sends.
 * - Sign-in: the recipient signs in by email and receives into an embedded wallet.
 */
const env = import.meta.env;
const demoConfigured = Boolean(env.VITE_DEMO_RELAYER_URL && env.VITE_DEMO_AUTH_URL && env.VITE_DEMO_RPC);
export const DEMO = new URLSearchParams(window.location.search).get("mode") === "demo" && demoConfigured;

const REAL_RPC: Record<number, string | undefined> = {
  42161: env.VITE_RPC_42161 ?? "https://arb1.arbitrum.io/rpc",
  421614: env.VITE_RPC_421614 ?? "https://sepolia-rollup.arbitrum.io/rpc",
  // a local development chain, only when configured
  ...(env.VITE_RPC_31337 ? { 31337: env.VITE_RPC_31337 as string } : {}),
};
export const defaultRpc = (chainId: number): string => (DEMO ? env.VITE_DEMO_RPC! : (REAL_RPC[chainId] ?? ""));

export const RELAYER_URL: string | undefined = (DEMO ? env.VITE_DEMO_RELAYER_URL : env.VITE_RELAYER_URL) || undefined;
export const PRIVY_APP_ID: string | undefined = DEMO ? undefined : env.VITE_PRIVY_APP_ID || undefined;
export const DEMO_AUTH_URL: string | undefined = DEMO ? env.VITE_DEMO_AUTH_URL : undefined;
/** where demo sign-in codes can be read */
export const DEMO_MAILBOX_URL: string | undefined = DEMO ? env.VITE_DEMO_MAILBOX_URL || undefined : undefined;
