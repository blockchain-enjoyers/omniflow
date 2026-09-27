import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

/** Provider not chosen. The slice writes emails to a directory — the "test mailbox". */
export interface Mailer {
  send(m: OutgoingEmail): Promise<void>;
}

export class DirectoryMailer implements Mailer {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async send(m: OutgoingEmail): Promise<void> {
    const name = `${Date.now()}-${m.to.replace(/[^a-z0-9@.]/gi, "_")}.eml`;
    writeFileSync(join(this.dir, name), `To: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`);
  }
}

/** Keeps emails in memory — for tests. */
export class MemoryMailer implements Mailer {
  readonly sent: OutgoingEmail[] = [];
  async send(m: OutgoingEmail): Promise<void> {
    this.sent.push(m);
  }
}
