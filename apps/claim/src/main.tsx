import { createRoot } from "react-dom/client";
import { AuthProvider } from "@omniflow/auth-client";
import { App } from "./App";
import { PRIVY_APP_ID, PRIVY_EMULATOR_URL } from "./config";
import "@omniflow/ui/base.css";
import "./style.css";

const withLogin = Boolean(PRIVY_APP_ID || PRIVY_EMULATOR_URL);
// Receiving needs no signature from the embedded wallet (the link's key signs the claim), so no confirm dialog here.
createRoot(document.getElementById("root")!).render(
  withLogin ? (
    <AuthProvider config={{ privyAppId: PRIVY_APP_ID, emulatorUrl: PRIVY_EMULATOR_URL }}>
      <App withLogin />
    </AuthProvider>
  ) : (
    <App withLogin={false} />
  ),
);
