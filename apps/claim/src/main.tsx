import { createRoot } from "react-dom/client";
import { AuthProvider } from "@omniflow/auth-client";
import { App } from "./App";
import { DEMO_AUTH_URL, PRIVY_APP_ID } from "./config";
import "@omniflow/ui/base.css";
import "./style.css";

const withLogin = Boolean(PRIVY_APP_ID || DEMO_AUTH_URL);
// Receiving needs no signature from the embedded wallet (the link's key signs the claim), so no confirm dialog here.
createRoot(document.getElementById("root")!).render(
  withLogin ? (
    <AuthProvider config={{ privyAppId: PRIVY_APP_ID, emulatorUrl: DEMO_AUTH_URL }}>
      <App withLogin />
    </AuthProvider>
  ) : (
    <App withLogin={false} />
  ),
);
