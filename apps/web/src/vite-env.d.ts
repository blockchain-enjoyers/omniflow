/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_PRIVY_APP_ID?: string;
  readonly VITE_PRIVY_EMULATOR_URL?: string;
  readonly VITE_DEV_TOOLS?: string;
  readonly VITE_CHAIN_NAME?: string;
}
