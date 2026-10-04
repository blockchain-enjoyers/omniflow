import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PrivyProvider, useIdentityToken, usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom, type Address, type Hex } from "viem";

export interface AuthUser {
  did: string;
  email: string | null;
  wallet: Address | null;
}

/** What the cabinet and the claim page need from "Privy", whichever implementation is behind it. */
export interface Auth {
  mode: "privy" | "emulator";
  ready: boolean;
  user: AuthUser | null;
  /** emulator: two steps (email → code); privy: opens Privy's own modal */
  startLogin(email?: string): Promise<void>;
  /** `email`: when the code is for an address just passed to startLogin (state may not have caught up yet) */
  verifyCode(code: string, email?: string): Promise<void>;
  needsCode: boolean;
  /** emulator: the email a code was sent to; go back to typing another email */
  pendingEmail?: string | null;
  resetLogin?(): void;
  logout(): Promise<void>;
  /** Authorization + privy-id-token headers for our API */
  headers(): Promise<Record<string, string>>;
  signTypedData(td: unknown, what: string): Promise<Hex>;
  signHash(hash: Hex, what: string): Promise<Hex>;
}

const Ctx = createContext<Auth | null>(null);
export const useAuth = () => {
  const a = useContext(Ctx);
  if (!a) throw new Error("AuthProvider missing");
  return a;
};

export interface AuthConfig {
  privyAppId?: string;
  emulatorUrl?: string;
  /** asks the person before a signature — the emulator's stand-in for Privy's confirmation modal */
  confirm?: (what: string) => Promise<boolean>;
}

export function AuthProvider({ config, children }: { config: AuthConfig; children: ReactNode }) {
  if (config.privyAppId) {
    return (
      <PrivyProvider
        appId={config.privyAppId}
        config={{
          loginMethods: ["email", "passkey"],
          // we keep Privy's confirmation modal ON. A compromised frontend could turn it off — accepted risk.
          embeddedWallets: { showWalletUIs: true, ethereum: { createOnLogin: "users-without-wallets" } },
        }}
      >
        <PrivyAuth>{children}</PrivyAuth>
      </PrivyProvider>
    );
  }
  if (config.emulatorUrl) return <EmulatorAuth url={config.emulatorUrl} confirm={config.confirm}>{children}</EmulatorAuth>;
  throw new Error("auth is not configured: neither a Privy app id nor a demo sign-in service");
}

// ------------------------------------------------------------------ real Privy (typed from SDK 3.45.0, untested live)

function PrivyAuth({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken();
  const { wallets } = useWallets();
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const client = useCallback(async () => {
    if (!embedded) throw new Error("no embedded wallet yet");
    const p = await embedded.getEthereumProvider();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return createWalletClient({ account: embedded.address as Address, transport: custom({ request: (a: any) => p.request(a) as any }) });
  }, [embedded?.address]);

  const auth: Auth = {
    mode: "privy",
    ready,
    needsCode: false,
    user: authenticated && user ? { did: user.id, email: user.email?.address?.toLowerCase() ?? null, wallet: (embedded?.address as Address) ?? null } : null,
    startLogin: async () => login(),
    verifyCode: async () => {},
    logout: async () => logout(),
    headers: async () => {
      const t = await getAccessToken();
      return { authorization: `Bearer ${t}`, ...(identityToken ? { "privy-id-token": identityToken } : {}) };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData: async (td) => (await client()).signTypedData({ account: embedded!.address as Address, ...(td as any) }),
    signHash: async (hash) => (await client()).signMessage({ account: embedded!.address as Address, message: { raw: hash } }),
  };
  return <Ctx.Provider value={auth}>{children}</Ctx.Provider>;
}

// ------------------------------------------------------------------ emulator

export interface Session {
  accessToken: string;
  identityToken: string;
  user: AuthUser;
}
const KEY = "omniflow-emulated-privy-session";

/**
 * Demo only: start this tab signed in with a session the demo backend issued (a live example's visitor).
 * The page reloads after this, and the emulator provider picks the session up.
 */
export function adoptEmulatedSession(s: Session) {
  sessionStorage.setItem(KEY, JSON.stringify(s));
}

function EmulatorAuth({ url, confirm, children }: { url: string; confirm?: (what: string) => Promise<boolean>; children: ReactNode }) {
  const base = url.replace(/\/$/, "");
  const [session, setSession] = useState<Session | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    } catch {
      return null;
    }
  });
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const sref = useRef(session);
  sref.current = session;

  useEffect(() => {
    try {
      if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
      else sessionStorage.removeItem(KEY);
    } catch {
      /* storage may be unavailable; the session then lives in memory only */
    }
  }, [session]);

  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    return j;
  };
  const ask = async (what: string) => {
    if (confirm && !(await confirm(what))) throw new Error("signature declined");
  };

  const auth = useMemo<Auth>(
    () => ({
      mode: "emulator",
      ready: true,
      needsCode: pendingEmail !== null,
      pendingEmail,
      resetLogin: () => setPendingEmail(null),
      user: session?.user ?? null,
      startLogin: async (email) => {
        if (!email) throw new Error("email required");
        await post("/auth/email/start", { email });
        setPendingEmail(email);
      },
      verifyCode: async (code, email) => {
        const r = await post("/auth/email/verify", { email: email ?? pendingEmail, code });
        setPendingEmail(null);
        setSession({ accessToken: r.accessToken, identityToken: r.identityToken, user: r.user });
      },
      logout: async () => setSession(null),
      headers: async () => {
        const s = sref.current;
        if (!s) throw new Error("not logged in");
        return { authorization: `Bearer ${s.accessToken}`, "privy-id-token": s.identityToken };
      },
      signTypedData: async (td, what) => {
        await ask(what);
        return (await post("/wallet/sign", { kind: "typedData", typedData: td }, sref.current!.accessToken)).signature;
      },
      signHash: async (raw, what) => {
        await ask(what);
        return (await post("/wallet/sign", { kind: "message", raw }, sref.current!.accessToken)).signature;
      },
    }),
    [session, pendingEmail],
  );
  return <Ctx.Provider value={auth}>{children}</Ctx.Provider>;
}

/** Login form that works for both modes. Styled by @omniflow/ui/base.css. */
/**
 * Demo mode only: ready accounts to sign in with one click, and the sign-in code taken from the demo mailbox
 * (no real email is sent in demo mode). `code` returns the newest code sent to an address, or null.
 */
export interface DemoLogin {
  accounts?: { email: string; role: string; note?: string }[];
  code: (email: string) => Promise<string | null>;
  mailboxUrl?: string;
}

export function LoginForm({ title, subtitle, demo }: { title?: string; subtitle?: string; demo?: DemoLogin }) {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // demo: once a code has been sent, fill it in from the demo mailbox
  useEffect(() => {
    if (!demo || !auth.needsCode || !auth.pendingEmail || code) return;
    let alive = true;
    void demo.code(auth.pendingEmail).then((c) => {
      if (alive && c) setCode(c);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, auth.needsCode, auth.pendingEmail]);
  const oneClick = (email: string) =>
    run(async () => {
      await auth.startLogin(email);
      const c = await demo!.code(email);
      if (!c) throw new Error("no code in the demo mailbox yet — try again");
      await auth.verifyCode(c, email);
    });
  const run = (fn: () => Promise<void>) => async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await fn();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      {title && <h2 style={{ marginBottom: 4 }}>{title}</h2>}
      {subtitle && <p className="hint">{subtitle}</p>}
      {auth.mode === "privy" ? (
        <div className="actions"><button className="block" onClick={run(() => auth.startLogin())}>Sign in with email or passkey</button></div>
      ) : !auth.needsCode ? (
        <>
        {demo?.accounts && demo.accounts.length > 0 && (
          <div className="demo-accounts" data-testid="demo-accounts">
            <p className="demo-accounts-head"><b>Demo accounts</b> — no sign-up and no real email. Pick one to sign in:</p>
            {demo.accounts.map((a) => (
              <button key={a.email} type="button" className="demo-account" data-testid={`demo-account-${a.email}`} disabled={busy} onClick={() => void oneClick(a.email)()}>
                <span className="demo-account-role">{a.role}</span>
                <span className="demo-account-email">{a.email}</span>
                {a.note && <span className="demo-account-note">{a.note}</span>}
              </button>
            ))}
            <p className="hint small" style={{ margin: "8px 0 0" }}>Or type any email below — a new person with no organization yet.</p>
          </div>
        )}
        <form onSubmit={run(() => auth.startLogin(email))} style={{ marginTop: 12 }}>
          <label className="field"><span>Email</span><input data-testid="login-email" type="email" autoComplete="email" autoFocus placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value.trim())} /></label>
          <div className="actions"><button className="block" type="submit" data-testid="login-start" disabled={busy || !email}>Send code</button></div>
        </form>
        </>
      ) : (
        <form onSubmit={run(() => auth.verifyCode(code))} style={{ marginTop: 12 }}>
          <p className="hint" style={{ marginBottom: 10 }}>We sent a 6-digit code to <b>{auth.pendingEmail}</b>.</p>
          <label className="field"><span>Code from the email</span><input data-testid="login-code" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="6 digits" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
          <div className="actions"><button className="block" type="submit" data-testid="login-verify" disabled={busy || code.length !== 6}>Sign in</button></div>
          <p className="hint small" style={{ marginTop: 12, marginBottom: 0, textAlign: "center" }}>
            <a href="#" data-testid="login-resend" onClick={(e) => { e.preventDefault(); void run(async () => { await auth.startLogin(auth.pendingEmail ?? email); setCode(""); setNote("A new code is on its way."); })(); }}>Send the code again</a>
            {" · "}
            <a href="#" data-testid="login-change" onClick={(e) => { e.preventDefault(); setCode(""); setNote(""); auth.resetLogin?.(); }}>Use a different email</a>
          </p>
          {note && <p className="hint small" style={{ textAlign: "center", marginBottom: 0 }}>{note}</p>}
        </form>
      )}
      {auth.mode === "emulator" && (
        <p className="hint" style={{ marginTop: 12, marginBottom: 0 }} data-testid="demo-mail-note">
          Demo mode: no real email is sent. The code and every letter the app sends go to the {demo?.mailboxUrl ? <a href={demo.mailboxUrl} target="_blank" rel="noreferrer">demo mailbox</a> : "demo mailbox"}
          {demo ? " — the code is filled in for you." : "."} In real mode the code arrives by email.
        </p>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
