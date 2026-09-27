import { useState } from "react";
import { call } from "../api";
import { Callout, dateTime, Err, Section, useLoad } from "../ui";

/** EMULATION ONLY: the dev mailbox (email provider not chosen). Links in letters are clickable. */
export function Mailbox() {
  const [to, setTo] = useState("");
  const list = useLoad(() => call<{ id: string; to_addr: string; from_name: string; subject: string; body: string; sent_at: string }[]>(null, "GET", `/dev/mailbox${to ? `?to=${encodeURIComponent(to)}` : ""}`), [to]);
  const linkify = (t: string) => t.split(/(https?:\/\/\S+)/g).map((p, i) => (p.startsWith("http") ? <a key={i} href={p} data-testid="mail-link">{p}</a> : p));
  return (
    <>
      <div className="page-head">
        <div><h1>Dev-ящик</h1><div className="sub">Все письма, которые отправило бы приложение: коды входа, приглашения, ссылки на платежи.</div></div>
        <a href="#/" className="btn secondary">← В кабинет</a>
      </div>
      <Callout tone="emu">Эмуляция почты: провайдер не выбран. Настоящих писем никто не получает.</Callout>
      <Section flush testid="mailbox" title="Письма" actions={
        <>
          <input className="input-inline" style={{ width: 220 }} placeholder="фильтр по адресу" value={to} onChange={(e) => setTo(e.target.value.trim())} />
          <button className="secondary sm" onClick={() => list.reload()}>Обновить</button>
        </>
      }>
        {list.data?.length === 0 && <div className="empty">Писем пока нет.</div>}
        {list.data?.map((m) => (
          <article key={m.id} className="mail" data-testid="mail">
            <div className="mail-meta"><span>{dateTime(m.sent_at)}</span><span>{m.from_name} → <b>{m.to_addr}</b></span></div>
            <div className="mail-subject" data-testid="mail-subject">{m.subject}</div>
            <pre>{linkify(m.body)}</pre>
          </article>
        ))}
        <div style={{ padding: "0 20px" }}><Err e={list.error} /></div>
      </Section>
    </>
  );
}
