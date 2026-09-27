import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { importSPKI, jwtVerify, SignJWT, generateKeyPair } from "jose";
import { recoverMessageAddress, recoverTypedDataAddress, getAddress } from "viem";
import { readDevMailbox } from "@omniflow/devmail";
import { PrivyEmulator } from "../src/emulator.js";

const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("privy emulator", () => {
  let db: pg.Pool;
  let emu: PrivyEmulator;

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: DB_URL });
    await db.query("DROP TABLE IF EXISTS privy_emu_users, privy_emu_codes, dev_mailbox");
    emu = new PrivyEmulator(db, { appId: "app-test", walletEncryptionKey: randomBytes(32).toString("hex") });
    await emu.init();
  });
  afterAll(() => db?.end());

  const codeFor = async (email: string) => (await readDevMailbox(db, email))[0]!.subject.match(/\d{6}/)![0];

  it("logs in by emailed code and issues Privy-shaped tokens verifiable with the published key", async () => {
    await emu.startEmailLogin("Ann@Example.test");
    const r = await emu.verifyEmailLogin("ann@example.test", await codeFor("ann@example.test"));
    const key = await importSPKI(emu.verificationKey(), "ES256");
    const { payload } = await jwtVerify(r.accessToken, key, { issuer: "privy.io", audience: "app-test" });
    expect(payload.sub).toBe(r.user.did);
    expect(payload.sid).toBeTypeOf("string");
    const id = await jwtVerify(r.identityToken, key, { issuer: "privy.io", audience: "app-test" });
    const linked = JSON.parse(String(id.payload.linked_accounts));
    expect(linked).toContainEqual(expect.objectContaining({ type: "email", address: "ann@example.test" }));
    expect(linked).toContainEqual(expect.objectContaining({ type: "wallet", address: r.user.wallet }));
  });

  it("same email → same user and wallet", async () => {
    await emu.startEmailLogin("ann@example.test");
    const a = await emu.verifyEmailLogin("ann@example.test", await codeFor("ann@example.test"));
    await emu.startEmailLogin("ann@example.test");
    const b = await emu.verifyEmailLogin("ann@example.test", await codeFor("ann@example.test"));
    expect(b.user).toEqual(a.user);
  });

  it("rejects a wrong code and locks after 5 attempts", async () => {
    await emu.startEmailLogin("bob@example.test");
    const good = await codeFor("bob@example.test");
    const bad = good === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(emu.verifyEmailLogin("bob@example.test", bad)).rejects.toThrow();
    await expect(emu.verifyEmailLogin("bob@example.test", good)).rejects.toThrow("code expired");
  });

  it("the embedded wallet signs for its owner only (TEE-like)", async () => {
    await emu.startEmailLogin("cat@example.test");
    const r = await emu.verifyEmailLogin("cat@example.test", await codeFor("cat@example.test"));
    const td = { domain: { name: "X", version: "1", chainId: 1, verifyingContract: "0x0000000000000000000000000000000000000001" as const }, types: { A: [{ name: "a", type: "uint256" }] }, primaryType: "A" as const, message: { a: 1n } };
    const sig = await emu.sign(r.user.did, { kind: "typedData", typedData: td });
    expect(getAddress(await recoverTypedDataAddress({ ...td, signature: sig }))).toBe(getAddress(r.user.wallet));
    const raw = `0x${"ab".repeat(32)}` as const;
    const s2 = await emu.sign(r.user.did, { kind: "message", raw });
    expect(await recoverMessageAddress({ message: { raw }, signature: s2 })).toBe(getAddress(r.user.wallet));
  });

  it("refuses tokens not signed by the emulator", async () => {
    const other = await generateKeyPair("ES256");
    const forged = await new SignJWT({}).setProtectedHeader({ alg: "ES256" }).setSubject("did:privy:x").setIssuer("privy.io").setAudience("app-test").setExpirationTime("1h").sign(other.privateKey);
    await expect(emu.verifyAccess(forged)).rejects.toThrow();
  });
});
