/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** real mode */
  readonly VITE_API_URL?: string;
  readonly VITE_PRIVY_APP_ID?: string;
  /** demo mode */
  readonly VITE_DEMO_API_URL?: string;
  readonly VITE_DEMO_AUTH_URL?: string;
}
