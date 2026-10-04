import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";

/**
 * EMULATION of an email provider (not chosen yet): every service writes outgoing mail into one table,
 * and the dev mailbox page reads it. The real provider replaces this behind the same `send` signature.
 * Attachments are the recipient's inbox, not Omniflow's data: their bytes go to a directory on disk
 * (DEV_MAILBOX_FILES, default: the OS temp dir); the table keeps only name, type, size and SHA-256.
 */
export const DEV_MAILBOX_SQL = `
CREATE TABLE IF NOT EXISTS dev_mailbox (
  id         bigserial PRIMARY KEY,
  to_addr    text NOT NULL,
  from_name  text NOT NULL,
  subject    text NOT NULL,
  body       text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dev_mailbox ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]';`;

export interface Attachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  fromName?: string;
  attachments?: Attachment[];
}

export interface StoredAttachment {
  file: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
}

const filesDir = () => process.env.DEV_MAILBOX_FILES ?? join(tmpdir(), "omniflow-dev-mailbox");

export async function ensureDevMailbox(db: pg.Pool) {
  await db.query(DEV_MAILBOX_SQL);
}

export async function sendToDevMailbox(db: pg.Pool, m: OutgoingEmail) {
  const stored: StoredAttachment[] = [];
  for (const a of m.attachments ?? []) {
    const dir = filesDir();
    mkdirSync(dir, { recursive: true });
    const file = `${randomUUID()}.bin`;
    writeFileSync(join(dir, file), a.content);
    stored.push({ file, filename: a.filename, contentType: a.contentType, size: a.content.length, sha256: createHash("sha256").update(a.content).digest("hex") });
  }
  await db.query(`INSERT INTO dev_mailbox (to_addr, from_name, subject, body, attachments) VALUES ($1,$2,$3,$4,$5)`, [
    m.to.toLowerCase(),
    m.fromName ?? "Omniflow",
    m.subject,
    m.text,
    JSON.stringify(stored),
  ]);
}

export async function readDevMailbox(db: pg.Pool, to?: string, limit = 50) {
  const { rows } = to
    ? await db.query(`SELECT * FROM dev_mailbox WHERE to_addr=$1 ORDER BY id DESC LIMIT $2`, [to.toLowerCase(), limit])
    : await db.query(`SELECT * FROM dev_mailbox ORDER BY id DESC LIMIT $1`, [limit]);
  return rows as { id: string; to_addr: string; from_name: string; subject: string; body: string; sent_at: Date; attachments: StoredAttachment[] }[];
}

/** The newest attachment with this SHA-256: a received form, found by the fingerprint its payment row keeps. */
export async function findDevAttachment(db: pg.Pool, sha256: string) {
  const { rows } = await db.query(`SELECT id, attachments FROM dev_mailbox WHERE attachments @> $1::jsonb ORDER BY id DESC LIMIT 1`, [JSON.stringify([{ sha256 }])]);
  if (!rows[0]) return null;
  return readDevAttachment(db, rows[0].id, (rows[0].attachments as StoredAttachment[]).findIndex((a) => a.sha256 === sha256));
}

/** One attachment of one letter, from disk. */
export async function readDevAttachment(db: pg.Pool, id: string, n: number) {
  const { rows } = await db.query(`SELECT attachments FROM dev_mailbox WHERE id=$1`, [id]);
  const a = (rows[0]?.attachments as StoredAttachment[] | undefined)?.[n];
  if (!a) return null;
  return { ...a, content: readFileSync(join(filesDir(), a.file)) };
}
