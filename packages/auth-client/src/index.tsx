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
  verifyCode(code: string): Promise<void>;
  needsCode: boolean;
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
  throw new Error("configure VITE_PRIVY_APP_ID (real Privy) or VITE_PRIVY_EMULATOR_URL (emulator)");
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

interface Session {
  accessToken: string;
  identityToken: string;
  user: AuthUser;
}
const KEY = "omniflow-emulated-privy-session";

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
      user: session?.user ?? null,
      startLogin: async (email) => {
        if (!email) throw new Error("email required");
        await post("/auth/email/start", { email });
        setPendingEmail(email);
      },
      verifyCode: async (code) => {
        const r = await post("/auth/email/verify", { email: pendingEmail, code });
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
export function LoginForm({ title, subtitle }: { title?: string; subtitle?: string }) {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
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
        <form onSubmit={run(() => auth.startLogin(email))} style={{ marginTop: 12 }}>
          <label className="field"><span>Email</span><input data-testid="login-email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value.trim())} /></label>
          <div className="actions"><button className="block" type="submit" data-testid="login-start" disabled={busy || !email}>Send code</button></div>
        </form>
      ) : (
        <form onSubmit={run(() => auth.verifyCode(code))} style={{ marginTop: 12 }}>
          <label className="field"><span>Code from the email</span><input data-testid="login-code" inputMode="numeric" autoComplete="one-time-code" placeholder="6 digits" value={code} onChange={(e) => setCode(e.target.value.trim())} /></label>
          <div className="actions"><button className="block" type="submit" data-testid="login-verify" disabled={busy || !code}>Sign in</button></div>
        </form>
      )}
      {auth.mode === "emulator" && <div className="callout emu" style={{ marginTop: 16, marginBottom: 0 }}>Privy emulator sign-in — the code arrives in the dev mailbox.</div>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
