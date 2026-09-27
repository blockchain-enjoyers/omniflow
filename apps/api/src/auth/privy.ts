import { importSPKI, jwtVerify, type CryptoKey } from "jose";
import { getAddress, isAddress, type Address } from "viem";

export interface AuthUser {
  did: string;
  email: string | null;
  wallet: Address | null;
}

/**
 * Verifies Privy tokens as docs.privy.io describes (27.09.2026): ES256 JWT, iss "privy.io", aud = app id.
 * NB the same page also says the verification key is "a standard Ed25519 public key" while its own code sample
 * imports it as ES256 — the docs contradict each other; we follow the code sample. Works identically against
 * the emulator (apps/privy-emulator), whose key is fetched at startup.
 */
export class PrivyVerifier {
  private constructor(private readonly key: CryptoKey, private readonly appId: string) {}

  static async fromPem(pem: string, appId: string) {
    return new PrivyVerifier(await importSPKI(pem, "ES256"), appId);
  }

  static async fromEmulator(url: string) {
    const r = await fetch(`${url.replace(/\/$/, "")}/verification-key`);
    const j = await r.json();
    return PrivyVerifier.fromPem(j.key, j.appId);
  }

  async verify(accessToken: string, identityToken?: string): Promise<AuthUser> {
    const opts = { issuer: "privy.io", audience: this.appId };
    const { payload } = await jwtVerify(accessToken, this.key, opts);
    const did = String(payload.sub);
    if (!identityToken) return { did, email: null, wallet: null };
    const id = await jwtVerify(identityToken, this.key, opts);
    if (id.payload.sub !== did) throw new Error("identity token belongs to another user");
    return { did, ...parseLinkedAccounts(id.payload.linked_accounts) };
  }
}

/**
 * `linked_accounts` is documented only as "a stringified array containing a lightweight version of the current
 * user's linkedAccounts". The field names below are what the emulator emits and are UNVERIFIED against real
 * Privy — this is the one place to fix on the real setup.
 */
export function parseLinkedAccounts(raw: unknown): { email: string | null; wallet: Address | null } {
  let list: Array<Record<string, unknown>> = [];
  try {
    list = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
  } catch {
    list = [];
  }
  const email = list.find((a) => a.type === "email")?.address;
  const wallet = list.find(
    (a) => a.type === "wallet" && (a.wallet_client_type ?? a.walletClientType) === "privy" && (a.chain_type ?? a.chainType ?? "ethereum") === "ethereum",
  )?.address;
  return {
    email: typeof email === "string" ? email.toLowerCase() : null,
    wallet: typeof wallet === "string" && isAddress(wallet) ? getAddress(wallet) : null,
  };
}
