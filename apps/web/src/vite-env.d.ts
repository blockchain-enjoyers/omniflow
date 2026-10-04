/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** real mode */
  readonly VITE_API_URL?: string;
  readonly VITE_PRIVY_APP_ID?: string;
  /** real mode: block explorer for transaction and address links, e.g. https://sepolia.arbiscan.io */
  readonly VITE_EXPLORER_URL?: string;
  /** demo mode */
  readonly VITE_DEMO_API_URL?: string;
  readonly VITE_DEMO_AUTH_URL?: string;
  /** demo mode: "Open a live example" — the demo backend builds a sandbox organisation per visitor */
  readonly VITE_DEMO_EXAMPLE_URL?: string;
  /** demo mode: ready accounts for the sign-in screen, JSON [{ email, role, note? }] (the demo backend fills it) */
  readonly VITE_DEMO_ACCOUNTS?: string;
  /** the landing page links to the source code when this is set (the repository must be public for visitors) */
  readonly VITE_SOURCE_URL?: string;
}
