import type pg from "pg";

/**
 * EMULATION of an email provider (not chosen yet): every service writes outgoing mail into one table,
 * and the dev mailbox page reads it. The real provider replaces this behind the same `send` signature.
 */
export const DEV_MAILBOX_SQL = `
CREATE TABLE IF NOT EXISTS dev_mailbox (
  id         bigserial PRIMARY KEY,
  to_addr    text NOT NULL,
  from_name  text NOT NULL,
  subject    text NOT NULL,
  body       text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now()
);`;

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  fromName?: string;
}

export async function ensureDevMailbox(db: pg.Pool) {
  await db.query(DEV_MAILBOX_SQL);
}

export async function sendToDevMailbox(db: pg.Pool, m: OutgoingEmail) {
  await db.query(`INSERT INTO dev_mailbox (to_addr, from_name, subject, body) VALUES ($1,$2,$3,$4)`, [
    m.to.toLowerCase(),
    m.fromName ?? "Omniflow",
    m.subject,
    m.text,
  ]);
}

export async function readDevMailbox(db: pg.Pool, to?: string, limit = 50) {
  const { rows } = to
    ? await db.query(`SELECT * FROM dev_mailbox WHERE to_addr=$1 ORDER BY id DESC LIMIT $2`, [to.toLowerCase(), limit])
    : await db.query(`SELECT * FROM dev_mailbox ORDER BY id DESC LIMIT $1`, [limit]);
  return rows as { id: string; to_addr: string; from_name: string; subject: string; body: string; sent_at: Date }[];
}
