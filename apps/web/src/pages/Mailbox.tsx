import { useState } from "react";
import { apiUrl, call } from "../api";
import { Callout, dateTime, Err, Section, useLoad } from "../ui";

/** EMULATION ONLY: the dev mailbox (email provider not chosen). Links in letters are clickable. */
export function Mailbox() {
  const [to, setTo] = useState("");
  const list = useLoad(() => call<{ id: string; to_addr: string; from_name: string; subject: string; body: string; sent_at: string; attachments?: { filename: string; size: number }[] }[]>(null, "GET", `/dev/mailbox${to ? `?to=${encodeURIComponent(to)}` : ""}`), [to]);
  const linkify = (t: string) => t.split(/(https?:\/\/\S+)/g).map((p, i) => (p.startsWith("http") ? <a key={i} href={p} data-testid="mail-link">{p}</a> : p));
  return (
    <>
      <div className="page-head">
        <div><h1>Demo mailbox</h1><div className="sub">Demo mode delivers every email here: sign-in codes, invitations, payment links.</div></div>
        <a href="#/" className="btn secondary">← Dashboard</a>
      </div>
      <Callout tone="warn">Demo mode — these emails are not sent to anyone.</Callout>
      <Section flush testid="mailbox" title="Emails" actions={
        <>
          <input className="input-inline" style={{ width: 220 }} placeholder="filter by address" value={to} onChange={(e) => setTo(e.target.value.trim())} />
          <button className="secondary sm" onClick={() => list.reload()}>Refresh</button>
        </>
      }>
        {list.data?.length === 0 && <div className="empty">No emails yet.</div>}
        {list.data?.map((m) => (
          <article key={m.id} className="mail" data-testid="mail">
            <div className="mail-meta"><span>{dateTime(m.sent_at)}</span><span>{m.from_name} → <b>{m.to_addr}</b></span></div>
            <div className="mail-subject" data-testid="mail-subject">{m.subject}</div>
            <pre>{linkify(m.body)}</pre>
            {(m.attachments ?? []).map((f, n) => (
              <a key={n} className="chip" data-testid="mail-attachment" href={`${apiUrl()}/dev/mailbox/${m.id}/attachments/${n}`} download={f.filename}>📎 {f.filename} · {Math.ceil(f.size / 1024)} KB</a>
            ))}
          </article>
        ))}
        <div style={{ padding: "0 20px" }}><Err e={list.error} /></div>
      </Section>
    </>
  );
}
