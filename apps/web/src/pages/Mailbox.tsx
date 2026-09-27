import { useState } from "react";
import { call } from "../api";
import { Err, Section, useLoad } from "../ui";

/** EMULATION ONLY: the dev mailbox (email provider not chosen). Links in letters are clickable. */
export function Mailbox() {
  const [to, setTo] = useState("");
  const list = useLoad(() => call<{ id: string; to_addr: string; from_name: string; subject: string; body: string; sent_at: string }[]>(null, "GET", `/dev/mailbox${to ? `?to=${encodeURIComponent(to)}` : ""}`), [to]);
  const linkify = (t: string) => t.split(/(https?:\/\/\S+)/g).map((p, i) => (p.startsWith("http") ? <a key={i} href={p} data-testid="mail-link">{p}</a> : p));
  return (
    <Section title="Dev-ящик (эмуляция почты)" testid="mailbox">
      <p><a href="#/">← кабинет</a> · <input placeholder="фильтр по адресу" value={to} onChange={(e) => setTo(e.target.value.trim())} /> <button className="secondary" onClick={() => list.reload()}>обновить</button></p>
      {list.data?.map((m) => (
        <article key={m.id} className="mail" data-testid="mail">
          <div className="small">{new Date(m.sent_at).toLocaleString("ru-RU")} · {m.from_name} → <b>{m.to_addr}</b></div>
          <div data-testid="mail-subject"><b>{m.subject}</b></div>
          <pre>{linkify(m.body)}</pre>
        </article>
      ))}
      <Err e={list.error} />
    </Section>
  );
}
