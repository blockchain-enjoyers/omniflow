/**
 * Demo or real (always a choice). Two backends, one dashboard:
 *  - demo: everything emulated — sign-in, wallet, network, email, on-ramp. Shown to people only as "Demo mode".
 *  - real: Privy, a real network, ZeroDev.
 * The choice comes from `?mode=` (links in demo emails carry it), else from this browser's last choice.
 */
import { adoptEmulatedSession } from "@omniflow/auth-client";

export type Mode = "demo" | "real";

const env = import.meta.env;
export const CONFIG = {
  demo: { api: env.VITE_DEMO_API_URL || "", authUrl: env.VITE_DEMO_AUTH_URL || "", exampleUrl: env.VITE_DEMO_EXAMPLE_URL || "" },
  real: { api: env.VITE_API_URL || "", privyAppId: env.VITE_PRIVY_APP_ID || "" },
};
export const AVAILABLE: Record<Mode, boolean> = {
  demo: Boolean(CONFIG.demo.api && CONFIG.demo.authUrl),
  real: Boolean(CONFIG.real.api && CONFIG.real.privyAppId),
};

const KEY = "omniflow-mode";
const isMode = (m: unknown): m is Mode => m === "demo" || m === "real";

function read(): Mode | null {
  const q = new URLSearchParams(window.location.search).get("mode");
  if (isMode(q) && AVAILABLE[q]) {
    try {
      localStorage.setItem(KEY, q);
    } catch {
      /* storage may be unavailable: the query still decides for this page */
    }
    return q;
  }
  try {
    const s = localStorage.getItem(KEY);
    if (isMode(s) && AVAILABLE[s]) return s;
  } catch {
    /* no storage: ask again */
  }
  return null;
}

/** Decided once per page load; switching reloads the page so the right sign-in provider starts clean. */
export const MODE: Mode | null = read();

export function chooseMode(m: Mode | null) {
  try {
    if (m) localStorage.setItem(KEY, m);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  // drop ?mode= so it does not override the new choice; keep the page (hash). A hash-only change would not reload,
  // and the sign-in provider must start clean — so rewrite the URL and reload explicitly.
  window.history.replaceState(null, "", `${window.location.pathname}${m ? `?mode=${m}` : ""}${window.location.hash}`);
  window.location.reload();
}

export const apiBase = () => (MODE === "demo" ? CONFIG.demo.api : CONFIG.real.api).replace(/\/$/, "");

const EXAMPLE = "omniflow-live-example";

/** This tab was opened as a live example (its other approvers are simulated). */
export const isLiveExample = () => {
  try {
    return MODE === "demo" && sessionStorage.getItem(EXAMPLE) === "1";
  } catch {
    return false;
  }
};

/**
 * "Open a live example": no sign-up — the demo backend builds an organisation with a payout already carried through
 * and signs this tab in as its admin. Then the page opens on that payout.
 */
export async function openLiveExample() {
  const r = await fetch(CONFIG.demo.exampleUrl, { method: "POST" });
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(j.error ?? "the example could not be prepared");
  adoptEmulatedSession({ accessToken: j.accessToken, identityToken: j.identityToken, user: j.user });
  try {
    localStorage.setItem(KEY, "demo");
    sessionStorage.setItem(EXAMPLE, "1");
  } catch {
    /* without storage the session cannot survive the reload; the error below says so */
  }
  window.history.replaceState(null, "", `${window.location.pathname}?mode=demo#/payout/${j.payoutId}`);
  window.location.reload();
}

export const EXAMPLE_AVAILABLE = AVAILABLE.demo && Boolean(CONFIG.demo.exampleUrl);
