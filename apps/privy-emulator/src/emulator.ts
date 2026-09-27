import { createCipheriv, createDecipheriv, randomBytes, randomInt, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey } from "jose";
import type pg from "pg";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ensureDevMailbox, sendToDevMailbox } from "@omniflow/devmail";

/**
 * EMULATOR of Privy for development — not Privy. Mirrors what the rest of the system relies on:
 *  - email login with a one-time code (the code goes to the dev mailbox);
 *  - access token: ES256 JWT, claims sid, sub (DID), iss "privy.io", aud (app id), iat, exp
 *    (docs.privy.io/authentication/user-authentication/access-tokens, 27.09.2026);
 *  - identity token: ES256 JWT with `linked_accounts` as a stringified array
 *    (docs.privy.io/user-management/users/identity-tokens) — field names inside are OUR GUESS, unverified;
 *  - embedded wallet in "TEE" mode: the key never reaches the browser; the emulator signs on request
 *    authorised by the access token. Real Privy additionally shows its own confirmation UI (showWalletUIs).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS privy_emu_users (
  did        text PRIMARY KEY,
  email      text UNIQUE NOT NULL,
  wallet     text NOT NULL,
  key_iv     text NOT NULL,
  key_ct     text NOT NULL,
  key_tag    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS privy_emu_codes (
  email      text PRIMARY KEY,
  code       text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   integer NOT NULL DEFAULT 0
);`;

export interface EmulatorConfig {
  appId: string;
  /** 32 bytes hex — encrypts emulated wallet keys at rest */
  walletEncryptionKey: string;
}

export interface EmulatorUser {
  did: string;
  email: string;
  wallet: Hex;
}

export class PrivyEmulator {
  private keys!: { privateKey: CryptoKey; publicKey: CryptoKey };
  private spki!: string;
  private readonly enc: Buffer;

  constructor(private readonly db: pg.Pool, private readonly cfg: EmulatorConfig) {
    this.enc = Buffer.from(cfg.walletEncryptionKey.replace(/^0x/, ""), "hex");
    if (this.enc.length !== 32) throw new Error("walletEncryptionKey must be 32 bytes hex");
  }

  async init() {
    await this.db.query(SCHEMA);
    await ensureDevMailbox(this.db);
    this.keys = await generateKeyPair("ES256", { extractable: true });
    this.spki = await exportSPKI(this.keys.publicKey);
  }

  /** The "verification key" an app copies from the Privy dashboard — here served by the emulator. */
  verificationKey(): string {
    return this.spki;
  }

  async startEmailLogin(email: string) {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("invalid email");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.db.query(
      `INSERT INTO privy_emu_codes (email, code, expires_at) VALUES ($1,$2, now() + interval '10 minutes')
       ON CONFLICT (email) DO UPDATE SET code=EXCLUDED.code, expires_at=EXCLUDED.expires_at, attempts=0`,
      [e, code],
    );
    await sendToDevMailbox(this.db, { to: e, fromName: "Privy (эмулятор)", subject: `Код входа: ${code}`, text: `Ваш код входа: ${code}. Действует 10 минут.` });
  }

  async verifyEmailLogin(email: string, code: string) {
    const e = email.trim().toLowerCase();
    const { rows } = await this.db.query(`SELECT * FROM privy_emu_codes WHERE email=$1`, [e]);
    const row = rows[0];
    if (!row || new Date(row.expires_at) < new Date() || row.attempts >= 5) throw new Error("code expired");
    if (row.code !== code) {
      await this.db.query(`UPDATE privy_emu_codes SET attempts = attempts + 1 WHERE email=$1`, [e]);
      throw new Error("wrong code");
    }
    await this.db.query(`DELETE FROM privy_emu_codes WHERE email=$1`, [e]);
    const user = (await this.userByEmail(e)) ?? (await this.createUser(e));
    return { user, ...(await this.issueTokens(user)) };
  }

  async issueTokens(user: EmulatorUser) {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({ sid: randomUUID() })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setSubject(user.did)
      .setIssuer("privy.io")
      .setAudience(this.cfg.appId)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(this.keys.privateKey);
    const identityToken = await new SignJWT({
      linked_accounts: JSON.stringify([
        { type: "email", address: user.email },
        { type: "wallet", address: user.wallet, chain_type: "ethereum", wallet_client_type: "privy" },
      ]),
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setSubject(user.did)
      .setIssuer("privy.io")
      .setAudience(this.cfg.appId)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(this.keys.privateKey);
    return { accessToken, identityToken };
  }

  private async userByEmail(email: string): Promise<EmulatorUser | null> {
    const { rows } = await this.db.query(`SELECT did, email, wallet FROM privy_emu_users WHERE email=$1`, [email]);
    return rows[0] ?? null;
  }

  private async userByDid(did: string) {
    const { rows } = await this.db.query(`SELECT * FROM privy_emu_users WHERE did=$1`, [did]);
    return rows[0] ?? null;
  }

  private async createUser(email: string): Promise<EmulatorUser> {
    const key = generatePrivateKey();
    const wallet = privateKeyToAccount(key).address;
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.enc, iv);
    const ct = Buffer.concat([c.update(key, "utf8"), c.final()]);
    const did = `did:privy:emu${randomBytes(12).toString("hex")}`;
    await this.db.query(
      `INSERT INTO privy_emu_users (did, email, wallet, key_iv, key_ct, key_tag) VALUES ($1,$2,$3,$4,$5,$6)`,
      [did, email, wallet, iv.toString("hex"), ct.toString("hex"), c.getAuthTag().toString("hex")],
    );
    return { did, email, wallet };
  }

  /** "TEE" signing: the key is reconstructed only here, per request, for the authenticated user. */
  async sign(did: string, req: { kind: "typedData"; typedData: unknown } | { kind: "message"; raw: Hex }): Promise<Hex> {
    const u = await this.userByDid(did);
    if (!u) throw new Error("no such user");
    const d = createDecipheriv("aes-256-gcm", this.enc, Buffer.from(u.key_iv, "hex"));
    d.setAuthTag(Buffer.from(u.key_tag, "hex"));
    const key = Buffer.concat([d.update(Buffer.from(u.key_ct, "hex")), d.final()]).toString("utf8") as Hex;
    const acc = privateKeyToAccount(key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (req.kind === "typedData") return acc.signTypedData(req.typedData as any);
    return acc.signMessage({ message: { raw: req.raw } });
  }

  async verifyAccess(token: string) {
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(token, this.keys.publicKey, { issuer: "privy.io", audience: this.cfg.appId });
    return payload;
  }

  router() {
    const r = express.Router();
    r.use(cors({ origin: true }));
    r.use(express.json());
    const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
      try {
        res.json((await fn(req, res)) ?? { ok: true });
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    };
    r.get("/verification-key", wrap(async () => ({ key: this.verificationKey(), appId: this.cfg.appId })));
    r.post("/auth/email/start", wrap(async (req) => this.startEmailLogin(req.body.email)));
    r.post("/auth/email/verify", wrap(async (req) => this.verifyEmailLogin(req.body.email, req.body.code)));
    r.post("/auth/refresh", wrap(async (req) => {
      const p = await this.verifyAccess(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
      const u = await this.userByDid(String(p.sub));
      return { user: { did: u.did, email: u.email, wallet: u.wallet }, ...(await this.issueTokens(u)) };
    }));
    r.post("/wallet/sign", wrap(async (req) => {
      const p = await this.verifyAccess(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
      return { signature: await this.sign(String(p.sub), req.body) };
    }));
    return r;
  }
}
