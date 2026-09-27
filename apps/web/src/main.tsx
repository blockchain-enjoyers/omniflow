import { createRoot } from "react-dom/client";
import { useEffect, useState, type ReactNode } from "react";
import { AuthProvider, LoginForm, useAuth } from "@omniflow/auth-client";
import { Home } from "./pages/Home";
import { SetupNew, SetupView } from "./pages/Setup";
import { OrgPage } from "./pages/Org";
import { PayoutPage } from "./pages/Payout";
import { ApprovePage } from "./pages/Approve";
import { FormPage } from "./pages/Form";
import { Mailbox } from "./pages/Mailbox";
import "@omniflow/ui/base.css";
import "./style.css";

function useHash() {
  const [h, setH] = useState(window.location.hash.replace(/^#/, "") || "/");
  useEffect(() => {
    const on = () => setH(window.location.hash.replace(/^#/, "") || "/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return h;
}

/** The emulator's stand-in for Privy's signature modal (Privy shows its own). */
let resolveConfirm: ((ok: boolean) => void) | null = null;
let showConfirm: ((what: string | null) => void) | null = null;
const confirmSign = (what: string) =>
  new Promise<boolean>((ok) => {
    resolveConfirm = ok;
    showConfirm?.(what);
  });

function ConfirmDialog() {
  const [what, setWhat] = useState<string | null>(null);
  showConfirm = setWhat;
  if (what === null) return null;
  const done = (ok: boolean) => {
    setWhat(null);
    resolveConfirm?.(ok);
  };
  return (
    <div className="modal" data-testid="sign-modal" role="dialog" aria-modal="true">
      <div className="sheet">
        <h2>Sign with your wallet</h2>
        <p className="hint" style={{ marginTop: 6 }}>You are approving:</p>
        <p style={{ fontWeight: 600 }}>{what}</p>
        <div className="callout emu">Privy emulator window. Real Privy will show its own confirmation window.</div>
        <div className="actions">
          <button className="secondary" onClick={() => done(false)}>Cancel</button>
          <button data-testid="sign-confirm" onClick={() => done(true)}>Sign</button>
        </div>
      </div>
    </div>
  );
}

const DEV = import.meta.env.VITE_DEV_TOOLS === "1";

const Brand = () => (
  <a href="#/" className="brand">
    <span className="logo">O</span> Omniflow
  </a>
);

/** Pages without the cabinet around them: the recipient's details form and the dev mailbox. */
function Bare({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar"><div className="topbar-inner"><Brand /></div></header>
      <main className="content">{children}</main>
    </div>
  );
}

function Shell() {
  const auth = useAuth();
  const path = useHash();
  const parts = path.split("/").filter(Boolean);

  if (parts[0] === "form") return <Bare><div className="narrow"><FormPage token={parts[1]!} /></div></Bare>;
  if (parts[0] === "dev" && parts[1] === "mailbox" && DEV) return <Bare><Mailbox /></Bare>;

  if (!auth.ready) return <div className="auth-wrap"><span className="muted">Loading…</span></div>;
  if (!auth.user) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="brand"><span className="logo">O</span> Omniflow</div>
          <p className="tagline">Stablecoin payouts: an organization pays many people, and each one receives the way that suits them.</p>
          <div className="card">
            <LoginForm title="Sign in to the dashboard" />
          </div>
          {DEV && <p className="hint" style={{ textAlign: "center", marginTop: 16 }}><a href="#/dev/mailbox">Open the dev mailbox</a> — login codes arrive there</p>}
        </div>
      </div>
    );
  }
  let page = <Home />;
  if (parts[0] === "setup" && parts[1] === "new") page = <SetupNew />;
  else if (parts[0] === "setup" && parts[1]) page = <SetupView id={parts[1]} />;
  else if (parts[0] === "org" && parts[1]) page = <OrgPage id={parts[1]} tab={parts[2] ?? "payouts"} />;
  else if (parts[0] === "payout" && parts[1]) page = <PayoutPage id={parts[1]} />;
  else if (parts[0] === "approve" && parts[1]) page = <ApprovePage batchId={parts[1]} />;
  const email = auth.user.email ?? auth.user.did;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Brand />
          <div className="spacer" />
          {DEV && <a href="#/dev/mailbox" className="chip">dev mailbox</a>}
          <div className="userchip">
            <span className="avatar">{email.slice(0, 1).toUpperCase()}</span>
            <span className="who" data-testid="me">
              <span>{auth.user.email}</span>
              <span className="mono small muted">{auth.user.wallet ? `${auth.user.wallet.slice(0, 6)}…${auth.user.wallet.slice(-4)}` : "no wallet"}</span>
            </span>
          </div>
          <button className="ghost sm" onClick={() => auth.logout()}>Sign out</button>
        </div>
      </header>
      <main className="content">{page}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AuthProvider config={{ privyAppId: import.meta.env.VITE_PRIVY_APP_ID || undefined, emulatorUrl: import.meta.env.VITE_PRIVY_EMULATOR_URL || undefined, confirm: confirmSign }}>
    <Shell />
    <ConfirmDialog />
  </AuthProvider>,
);
