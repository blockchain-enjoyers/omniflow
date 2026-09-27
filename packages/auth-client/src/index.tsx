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

/** Login form that works for both modes. */
export function LoginForm({ title }: { title?: string }) {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const run = (fn: () => Promise<void>) => async () => {
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (auth.mode === "privy") return <button onClick={run(() => auth.startLogin())}>Войти (почта или passkey)</button>;
  return (
    <div className="login">
      {title && <h2>{title}</h2>}
      {auth.mode === "emulator" && <p className="emu">Вход через эмулятор Privy — код придёт в dev-ящик.</p>}
      {!auth.needsCode ? (
        <>
          <input data-testid="login-email" type="email" placeholder="почта" value={email} onChange={(e) => setEmail(e.target.value.trim())} />
          <button data-testid="login-start" onClick={run(() => auth.startLogin(email))}>Получить код</button>
        </>
      ) : (
        <>
          <input data-testid="login-code" placeholder="код из письма" value={code} onChange={(e) => setCode(e.target.value.trim())} />
          <button data-testid="login-verify" onClick={run(() => auth.verifyCode(code))}>Войти</button>
        </>
      )}
      {err && <p className="warn">{err}</p>}
    </div>
  );
}
