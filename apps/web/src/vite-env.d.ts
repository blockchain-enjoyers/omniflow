/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** real mode */
  readonly VITE_API_URL?: string;
  readonly VITE_PRIVY_APP_ID?: string;
  /** demo mode */
  readonly VITE_DEMO_API_URL?: string;
  readonly VITE_DEMO_AUTH_URL?: string;
  /** demo mode: "Open a live example" — the demo backend builds a sandbox organisation per visitor */
  readonly VITE_DEMO_EXAMPLE_URL?: string;
  /** the landing page links to the source code when this is set (the repository must be public for visitors) */
  readonly VITE_SOURCE_URL?: string;
}
