/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** real */
  readonly VITE_RPC_42161?: string;
  readonly VITE_RPC_421614?: string;
  readonly VITE_RPC_31337?: string;
  readonly VITE_RELAYER_URL?: string;
  readonly VITE_PRIVY_APP_ID?: string;
  /** demo mode (links with ?mode=demo) */
  readonly VITE_DEMO_RPC?: string;
  readonly VITE_DEMO_RELAYER_URL?: string;
  readonly VITE_DEMO_AUTH_URL?: string;
  readonly VITE_DEMO_MAILBOX_URL?: string;
}
