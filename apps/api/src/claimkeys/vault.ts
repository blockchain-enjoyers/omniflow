import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Hex } from "viem";

/**
 * Encrypts claim keys at rest between batch freeze and the claim email (deleted after sending).
 * The 32-byte key comes from the environment / secret manager — never from the repository.
 */
export class ClaimKeyVault {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    const k = Buffer.from(hexKey.replace(/^0x/, ""), "hex");
    if (k.length !== 32) throw new Error("CLAIM_KEY_ENCRYPTION_KEY must be 32 bytes hex");
    this.key = k;
  }

  seal(privateKey: Hex): { iv: string; ciphertext: string; tag: string } {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([c.update(privateKey, "utf8"), c.final()]);
    return { iv: iv.toString("hex"), ciphertext: ciphertext.toString("hex"), tag: c.getAuthTag().toString("hex") };
  }

  open(s: { iv: string; ciphertext: string; tag: string }): Hex {
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(s.iv, "hex"));
    d.setAuthTag(Buffer.from(s.tag, "hex"));
    return Buffer.concat([d.update(Buffer.from(s.ciphertext, "hex")), d.final()]).toString("utf8") as Hex;
  }
}
