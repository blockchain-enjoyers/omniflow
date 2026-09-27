/**
 * The page is static and must work when Omniflow is gone. Everything below is optional:
 * - RPC: a public RPC per chain; the recipient can also paste their own (`?rpc=` after the fragment is not used —
 *   the field on the page).
 * - Relayer: Omniflow's relayer pays gas for the claim and earns the tip; without it the recipient's own wallet sends.
 */
export const DEFAULT_RPC: Record<number, string> = {
  42161: import.meta.env.VITE_RPC_42161 ?? "https://arb1.arbitrum.io/rpc",
  421614: import.meta.env.VITE_RPC_421614 ?? "https://sepolia-rollup.arbitrum.io/rpc",
  31337: import.meta.env.VITE_RPC_31337 ?? "http://127.0.0.1:8545",
};

export const RELAYER_URL: string | undefined = import.meta.env.VITE_RELAYER_URL || undefined;

/**
 * Optional login: the recipient signs in by email and receives into their embedded wallet — via Privy, or the
 * Privy emulator in development. Without either the page still works: paste an address or use your own wallet.
 */
export const PRIVY_APP_ID: string | undefined = import.meta.env.VITE_PRIVY_APP_ID || undefined;
export const PRIVY_EMULATOR_URL: string | undefined = import.meta.env.VITE_PRIVY_EMULATOR_URL || undefined;
