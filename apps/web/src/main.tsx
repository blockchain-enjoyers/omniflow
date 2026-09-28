import { createRoot } from "react-dom/client";
import { useEffect, useState, type ReactNode } from "react";
import { AuthProvider, LoginForm, useAuth } from "@omniflow/auth-client";
import { Home } from "./pages/Home";
import { SetupNew, SetupView } from "./pages/Setup";
import { OrgPage } from "./pages/Org";
import { NewPayout } from "./pages/NewPayout";
import { ConfirmHost, Toaster } from "./ui";
import { PayoutPage } from "./pages/Payout";
import { ApprovePage } from "./pages/Approve";
import { FormPage } from "./pages/Form";
import { Mailbox } from "./pages/Mailbox";
import { AVAILABLE, chooseMode, CONFIG, MODE } from "./mode";
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
        <div className="row" style={{ justifyContent: "space-between" }}><h2>Sign with your wallet</h2><span className="badge warn">Demo mode</span></div>
        <p className="hint" style={{ marginTop: 6 }}>You are approving:</p>
        <p style={{ fontWeight: 600 }}>{what}</p>
        <div className="actions">
          <button className="secondary" onClick={() => done(false)}>Cancel</button>
          <button data-testid="sign-confirm" onClick={() => done(true)}>Sign</button>
        </div>
      </div>
    </div>
  );
}

const Brand = () => (
  <a href="#/" className="brand">
    <span className="logo">O</span> Omniflow
  </a>
);

const DemoBanner = () =>
  MODE === "demo" ? (
    <div className="demo-banner" data-testid="demo-banner">
      <b>Demo mode</b> — test money on a demo network. Nothing here is real.
    </div>
  ) : null;

/** Pages without the dashboard around them: the recipient's details form and the demo mailbox. */
function Bare({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <header className="topbar"><div className="topbar-inner"><Brand /><div className="spacer" />{MODE === "demo" && <span className="badge warn">Demo mode</span>}</div></header>
      <DemoBanner />
      <main className="content">{children}</main>
    </div>
  );
}

/** Always a choice between demo and real. */
function ModeChooser() {
  return (
    <div className="auth-wrap">
      <div className="auth-card wide">
        <div className="brand"><span className="logo">O</span> Omniflow</div>
        <p className="tagline">Stablecoin payouts: an organization pays many people, and each one receives the way that suits them.</p>
        <div className="grid grid-2 modes">
          <section className="card mode-card" data-testid="mode-card-demo">
            <span className="badge warn">Demo mode</span>
            <h2>Try the demo</h2>
            <p className="hint">Test money on a demo network. Create an organization, pay people, approve and claim — nothing real is moved. Sign-in codes arrive in the demo mailbox.</p>
            <button className="block" data-testid="mode-demo" disabled={!AVAILABLE.demo} onClick={() => chooseMode("demo")}>{AVAILABLE.demo ? "Open demo" : "Demo is not available here"}</button>
          </section>
          <section className="card mode-card" data-testid="mode-card-real">
            <span className="badge ok">Real</span>
            <h2>Use Omniflow</h2>
            <p className="hint">Real sign-in with email or passkey, a real network and real USDC. For your organization's actual payouts.</p>
            <button className="block secondary" data-testid="mode-real" disabled={!AVAILABLE.real} onClick={() => chooseMode("real")}>{AVAILABLE.real ? "Sign in" : "Not set up yet"}</button>
          </section>
        </div>
      </div>
    </div>
  );
}

const ModeSwitch = ({ onBefore }: { onBefore?: () => Promise<void> }) => (
  <button className="ghost sm" data-testid="mode-switch" onClick={async () => { await onBefore?.(); chooseMode(null); }}><span className="hide-phone">Switch mode</span><span className="show-phone">Mode</span></button>
);

function Shell() {
  const auth = useAuth();
  const path = useHash();
  const parts = path.split("/").filter(Boolean);

  if (!auth.ready)
    return (
      <div className="auth-wrap">
        <p className="muted" style={{ textAlign: "center" }}>
          Loading sign-in…
          <br />
          <a href="#" data-testid="mode-change" onClick={(e) => { e.preventDefault(); chooseMode(null); }}>Change mode</a>
        </p>
      </div>
    );
  if (!auth.user) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="brand"><span className="logo">O</span> Omniflow</div>
          <p className="tagline">Stablecoin payouts: an organization pays many people, and each one receives the way that suits them.</p>
          <div className="card">
            {MODE === "demo" && <span className="badge warn" style={{ marginBottom: 10 }}>Demo mode</span>}
            <LoginForm title="Sign in to the dashboard" />
          </div>
          <p className="hint" style={{ textAlign: "center", marginTop: 16 }}>
            {MODE === "demo" && <><a href="#/demo/mailbox" data-testid="mailbox-link">Open the demo mailbox</a> · </>}
            <a href="#" data-testid="mode-change" onClick={(e) => { e.preventDefault(); chooseMode(null); }}>Change mode</a>
          </p>
        </div>
      </div>
    );
  }
  let page = <Home />;
  if (parts[0] === "setup" && parts[1] === "new") page = <SetupNew />;
  else if (parts[0] === "setup" && parts[1]) page = <SetupView id={parts[1]} />;
  else if (parts[0] === "org" && parts[1] && parts[2] === "new") page = <NewPayout orgId={parts[1]} />;
  else if (parts[0] === "org" && parts[1]) page = <OrgPage id={parts[1]} tab={parts[2] ?? "payouts"} />;
  else if (parts[0] === "payout" && parts[1]) page = <PayoutPage id={parts[1]} />;
  else if (parts[0] === "approve" && parts[1]) page = <ApprovePage batchId={parts[1]} />;
  const email = auth.user.email ?? auth.user.did;
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Brand />
          {MODE === "demo" && <span className="badge warn hide-phone" data-testid="mode-badge">Demo mode</span>}
          <div className="spacer" />
          {MODE === "demo" && <a href="#/demo/mailbox" className="chip hide-phone">Demo mailbox</a>}
          <div className="userchip">
            <span className="avatar">{email.slice(0, 1).toUpperCase()}</span>
            <span className="who" data-testid="me">
              <span>{auth.user.email}</span>
              <span className="mono small muted">{auth.user.wallet ? `${auth.user.wallet.slice(0, 6)}…${auth.user.wallet.slice(-4)}` : "no wallet"}</span>
            </span>
          </div>
          <ModeSwitch onBefore={() => auth.logout()} />
          <button className="ghost sm" onClick={() => auth.logout()}>Sign out</button>
        </div>
      </header>
      <DemoBanner />
      <main className="content">{page}</main>
    </div>
  );
}

function App() {
  const path = useHash();
  const parts = path.split("/").filter(Boolean);
  // public pages: no sign-in, no choice to make — a details-form link already belongs to one mode
  if (parts[0] === "form") return <Bare><div className="narrow"><FormPage token={parts[1]!} /></div></Bare>;
  if (parts[0] === "demo" && parts[1] === "mailbox" && MODE === "demo") return <Bare><Mailbox /></Bare>;
  if (!MODE) return <ModeChooser />;
  return (
    <AuthProvider config={MODE === "demo" ? { emulatorUrl: CONFIG.demo.authUrl, confirm: confirmSign } : { privyAppId: CONFIG.real.privyAppId }}>
      <Shell />
      <ConfirmDialog />
      <ConfirmHost />
      <Toaster />
    </AuthProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
