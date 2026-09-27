import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { AuthProvider, LoginForm, useAuth } from "@omniflow/auth-client";
import { Home } from "./pages/Home";
import { SetupNew, SetupView } from "./pages/Setup";
import { OrgPage } from "./pages/Org";
import { PayoutPage } from "./pages/Payout";
import { ApprovePage } from "./pages/Approve";
import { FormPage } from "./pages/Form";
import { Mailbox } from "./pages/Mailbox";
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
    <div className="modal" data-testid="sign-modal">
      <div>
        <h3>Подпись кошельком</h3>
        <p className="emu">Окно эмулятора Privy. Настоящий Privy покажет своё.</p>
        <p>{what}</p>
        <button data-testid="sign-confirm" onClick={() => done(true)}>Подписать</button> <button className="secondary" onClick={() => done(false)}>Отмена</button>
      </div>
    </div>
  );
}

function Shell() {
  const auth = useAuth();
  const path = useHash();
  const parts = path.split("/").filter(Boolean);

  // Public pages: recipient details form, dev mailbox.
  if (parts[0] === "form") return <main><FormPage token={parts[1]!} /></main>;
  if (parts[0] === "dev" && parts[1] === "mailbox" && import.meta.env.VITE_DEV_TOOLS === "1") return <main><Mailbox /></main>;

  if (!auth.ready) return <main>…</main>;
  if (!auth.user) {
    return (
      <main>
        <h1>Omniflow</h1>
        <p>Выплаты в стейблкоинах: организация платит многим людям, каждый получает так, как удобно ему.</p>
        <LoginForm title="Вход" />
        {import.meta.env.VITE_DEV_TOOLS === "1" && <p><a href="#/dev/mailbox">dev-ящик</a></p>}
      </main>
    );
  }
  let page = <Home />;
  if (parts[0] === "setup" && parts[1] === "new") page = <SetupNew />;
  else if (parts[0] === "setup" && parts[1]) page = <SetupView id={parts[1]} />;
  else if (parts[0] === "org" && parts[1]) page = <OrgPage id={parts[1]} tab={parts[2] ?? "payouts"} />;
  else if (parts[0] === "payout" && parts[1]) page = <PayoutPage id={parts[1]} />;
  else if (parts[0] === "approve" && parts[1]) page = <ApprovePage batchId={parts[1]} />;
  return (
    <main>
      <header>
        <a href="#/"><b>Omniflow</b></a>
        <span className="me" data-testid="me">{auth.user.email} · {auth.user.wallet ? `${auth.user.wallet.slice(0, 6)}…${auth.user.wallet.slice(-4)}` : "без кошелька"}</span>
        {import.meta.env.VITE_DEV_TOOLS === "1" && <a href="#/dev/mailbox">dev-ящик</a>}
        <button className="secondary" onClick={() => auth.logout()}>Выйти</button>
      </header>
      {page}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <AuthProvider config={{ privyAppId: import.meta.env.VITE_PRIVY_APP_ID || undefined, emulatorUrl: import.meta.env.VITE_PRIVY_EMULATOR_URL || undefined, confirm: confirmSign }}>
    <Shell />
    <ConfirmDialog />
  </AuthProvider>,
);
