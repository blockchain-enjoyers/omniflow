import { useState } from "react";
import { useAuth } from "@omniflow/auth-client";
import { call, type Batch, type Receipt, type Review, type ReviewRow } from "../api";
import { Addr, Badge, Callout, Err, Section, short, Table, usdc, useAction, useLoad } from "../ui";

const who = (r: ReviewRow) => `${r.name}${r.address ? ` · ${short(r.address)}` : ""}${r.email ? ` · ${r.email}` : ""}`;
const REASON: Record<string, string> = { "no-address-no-email": "нет ни адреса, ни почты — ждёт реквизитов", "other-chain": "другая сеть — не уйдёт" };
const BATCH_KIND: Record<string, string> = { pay: "выплата", revoke: "отзыв", rekey: "новые ссылки" };

export function PayoutPage({ id }: { id: string }) {
  const auth = useAuth();
  const receipt = useLoad(() => call<Receipt>(auth.headers, "GET", `/payouts/${id}/receipt`), [id]);
  const review = useLoad(() => call<Review>(auth.headers, "GET", `/payouts/${id}/review`), [id]);
  const batches = useLoad(() => call<Batch[]>(auth.headers, "GET", `/payouts/${id}/batches`), [id]);
  const [links, setLinks] = useState<{ row: string; name: string; link: string; emailed: boolean }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [edit, setEdit] = useState<Record<string, { amount?: string; address?: string; email?: string }>>({});
  const [add, setAdd] = useState({ name: "", address: "", email: "", amount: "" });
  const [every, setEvery] = useState<"month" | "week">("month");
  const a = useAction();
  const reload = async () => {
    await Promise.all([receipt.reload(), review.reload(), batches.reload()]);
  };
  const rows = receipt.data?.rows ?? [];
  const editable = (s: string) => ["ready", "waiting_details", "other_chain"].includes(s);
  const openBatch = batches.data?.find((b) => ["collecting", "submitted"].includes(b.status));
  const s = review.data?.summary;
  const closed = receipt.data?.payout.status === "closed";

  const rowCells = (r: (typeof rows)[number]) => {
    const e = edit[r.row];
    const setE = (patch: { amount?: string; address?: string; email?: string }) => setEdit({ ...edit, [r.row]: { ...e, ...patch } });
    return [
      r.status === "in_escrow" ? <input type="checkbox" aria-label={`выбрать ${r.name}`} data-testid={`pick-${r.name}`} checked={picked.includes(r.row)} onChange={(x) => setPicked(x.target.checked ? [...picked, r.row] : picked.filter((y) => y !== r.row))} /> : null,
      <span>
        <span className="cell-main">{r.name}</span>
        <span className="cell-sub">{r.address ? <Addr value={r.address} /> : <span className="small muted">{r.email ?? "нет реквизитов"}</span>}</span>
        {e && (
          <span className="edit-row">
            <input aria-label="сумма" data-testid={`row-amount-${r.name}`} inputMode="decimal" placeholder="сумма" value={e.amount ?? ""} onChange={(x) => setE({ amount: x.target.value })} />
            <input aria-label="адрес" className="mono" data-testid={`row-address-${r.name}`} placeholder="адрес 0x…" value={e.address ?? ""} onChange={(x) => setE({ address: x.target.value.trim() })} />
            <input aria-label="почта" data-testid={`row-email-${r.name}`} placeholder="почта" value={e.email ?? ""} onChange={(x) => setE({ email: x.target.value.trim() })} />
            <span className="row">
              <button className="sm" data-testid={`row-save-${r.name}`} onClick={a.run(async () => { await call(auth.headers, "PATCH", `/payouts/${id}/rows/${r.row}`, { amount: e.amount, address: e.address || null, email: e.email || null }); const n = { ...edit }; delete n[r.row]; setEdit(n); await reload(); })}>Сохранить</button>
              <button className="ghost sm" data-testid={`row-remove-${r.name}`} onClick={a.run(async () => { await call(auth.headers, "PATCH", `/payouts/${id}/rows/${r.row}`, { remove: true }); await reload(); })}>Удалить строку</button>
              <button className="ghost sm" onClick={() => { const n = { ...edit }; delete n[r.row]; setEdit(n); }}>Отмена</button>
            </span>
          </span>
        )}
      </span>,
      <span className="num">{usdc(r.amount)}</span>,
      <Badge s={r.status} testid={`status-${r.name}`} extra={r.failReason ? ` (${r.failReason})` : ""} />,
      <Addr value={r.txHash} />,
      editable(r.status) && !closed && !e ? <button className="ghost sm" data-testid={`edit-${r.name}`} onClick={() => setEdit({ ...edit, [r.row]: { amount: String(Number(r.amount) / 1e6), address: r.address ?? "", email: r.email ?? "" } })}>Изменить</button> : null,
    ];
  };
  const orgId = receipt.data?.payout.orgId;
  const selectable = rows.some((r) => r.status === "in_escrow");

  return (
    <>
      {orgId && <a className="back" href={`#/org/${orgId}`}>← К организации</a>}
      <div className="page-head">
        <div>
          <h1 data-testid="payout-title">{receipt.data?.payout.title ?? "…"}</h1>
          <div className="sub row">{receipt.data && <span data-testid="payout-status"><Badge s={receipt.data.payout.status} /></span>}<span>{rows.length} строк · {usdc(rows.reduce((x, r) => x + BigInt(r.amount), 0n))}</span></div>
        </div>
        <div className="row">
          <button className="secondary" data-testid="repeat" onClick={a.run(async () => { const p = await call<{ id: string }>(auth.headers, "POST", `/payouts/${id}/repeat`, {}); window.location.hash = `#/payout/${p.id}`; })}>Повторить с правкой</button>
          {!closed && <button className="secondary" data-testid="close" onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/close`); await reload(); })}>Закрыть выплату</button>}
        </div>
      </div>

      {s && !closed && s.toAddress + s.byEmail === 0 && s.notSent.length > 0 && (
        <Callout tone="warn">Отправлять нечего. Не уйдут: {s.notSent.map((n) => `${n.row.name} — ${REASON[n.reason] ?? n.reason}`).join("; ")}.</Callout>
      )}
      {s && s.toAddress + s.byEmail > 0 && !closed && (
        <Section title="Проверка перед отправкой" desc="Посмотрите на новых получателей и изменения — это главный источник необратимой ошибки." testid="review">
          <div className="grid grid-3" style={{ marginBottom: 16 }}>
            <div className="stat"><span className="label">Уйдёт</span><span className="value sm">{s.toAddress + s.byEmail} строк</span><span className="foot">на адрес {s.toAddress} · по ссылке на почту {s.byEmail}</span></div>
            <div className="stat"><span className="label">Сумма</span><span className="value sm">{usdc(s.total)}</span><span className="foot">Автовозврат: {review.data!.autoRefundDays ? `через ${review.data!.autoRefundDays} дн.` : "бессрочно"}</span></div>
            <div className="stat"><span className="label">Баланс</span><span className="value sm">{s.balanceSufficient ? <span className="badge ok">хватает</span> : <span className="badge bad">не хватает</span>}</span></div>
          </div>
          <div className={`review-group ${s.newRecipients.length ? "warn" : ""}`}><h4>Новые получатели: {s.newRecipients.length}</h4>
            {s.newRecipients.length > 0 && <ul>{s.newRecipients.map((r) => <li key={r.rowId}>{who(r)} — <b className="num">{usdc(r.amount)}</b></li>)}</ul>}</div>
          {s.changedAmount.length > 0 && <div className="review-group"><h4>Сумма изменилась</h4><ul>{s.changedAmount.map((c) => <li key={c.row.rowId}>{who(c.row)}: {usdc(c.previous)} → <b>{usdc(c.row.amount)}</b></li>)}</ul></div>}
          {s.outliers.length > 0 && <div className="review-group warn"><h4>Выбросы</h4><ul>{s.outliers.map((c) => <li key={c.row.rowId}>{who(c.row)}: было {usdc(c.previous)}, сейчас {usdc(c.row.amount)}</li>)}</ul></div>}
          {[...s.duplicateAddress, ...s.duplicateEmail].length > 0 && <div className="review-group warn"><h4>Дубли</h4><ul>{[...s.duplicateAddress, ...s.duplicateEmail].map((g, i) => <li key={i}>{g.map(who).join(" | ")}</li>)}</ul></div>}
          {s.notSent.length > 0 && <div className="review-group"><h4>Не уйдут: {s.notSent.length}</h4><ul>{s.notSent.map((n) => <li key={n.row.rowId}>{n.row.name}: {REASON[n.reason] ?? n.reason}</li>)}</ul></div>}
          <div className="actions">
            {openBatch ? (
              <a className="btn secondary" href={`#/approve/${openBatch.id}`}>Партия на подтверждении — открыть</a>
            ) : (
              <button data-testid="freeze" disabled={a.busy || s.toAddress + s.byEmail === 0} onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/batches`); await reload(); })}>
                Отправить на подтверждение
              </button>
            )}
          </div>
        </Section>
      )}

      <Section flush title="Строки" testid="rows" actions={<button className="ghost sm" data-testid="refresh" onClick={reload}>Обновить</button>}>
        <Table
          cols={[...(selectable ? [{ label: "" }] : []), { label: "Кому", primary: true }, { label: "Сумма", className: "r" }, { label: "Статус" }, { label: "Транзакция" }, { label: "" }]}
          rows={rows.map((r) => ({ key: r.row, cells: selectable ? rowCells(r) : rowCells(r).slice(1) }))}
        />
        {picked.length > 0 && (
          <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
            <p style={{ marginBottom: 8 }}><b>Выбрано неполученных платежей: {picked.length}.</b> <span className="hint">Оба действия подтверждаются порогом, как выплата. Отозванные деньги вернутся на аккаунт организации.</span></p>
            <div className="row">
              <button data-testid="rekey" onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/rekey`, { rows: picked }); setPicked([]); await reload(); })}>Выслать новые ссылки</button>
              <button data-testid="revoke" className="danger" onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/revoke`, { rows: picked }); setPicked([]); await reload(); })}>Отозвать</button>
            </div>
          </div>
        )}
        {!closed && (
          <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
            <h3 style={{ marginTop: 0 }}>Добавить строку</h3>
            <div className="row">
              <input className="grow" data-testid="add-name" placeholder="имя" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
              <input className="grow mono" data-testid="add-address" placeholder="адрес 0x…" value={add.address} onChange={(e) => setAdd({ ...add, address: e.target.value.trim() })} />
              <input className="grow" data-testid="add-email" placeholder="или почта" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value.trim() })} />
              <input className="w-amount" data-testid="add-amount" inputMode="decimal" placeholder="сумма" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} />
              <button className="secondary" data-testid="add-row" disabled={!add.name || !add.amount} onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/rows`, { name: add.name, address: add.address || undefined, email: add.email || undefined, amount: add.amount, chainId: receipt.data!.payout.chainId }); setAdd({ name: "", address: "", email: "", amount: "" }); await reload(); })}>+ Строка</button>
            </div>
          </div>
        )}
        <div style={{ padding: "0 20px" }}><Err e={a.error || receipt.error} /></div>
      </Section>

      {!closed && rows.some((r) => !r.address && ["waiting_details", "ready"].includes(r.status)) && (
        <Section title="Форма реквизитов" desc="Получатель сам укажет адрес или почту. Это не ссылка на деньги; после заполнения строку нужно отправить на подтверждение." testid="forms">
          <button data-testid="forms-create" onClick={a.run(async () => setLinks(await call(auth.headers, "POST", `/payouts/${id}/forms`, {})))}>Создать ссылки</button>
          {links.length > 0 && (
            <ul className="check-list" style={{ marginTop: 12 }}>
              {links.map((l) => (
                <li key={l.row}>
                  <span className="cell-main" style={{ minWidth: 80 }}>{l.name}</span>
                  {l.emailed ? <span className="badge ok">отправлена на почту</span> : <span style={{ minWidth: 0 }}><span className="mono small" data-testid={`form-link-${l.name}`}>{l.link}</span><span className="cell-sub hint">Передайте получателю</span></span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <div className="grid grid-2">
        <Section flush title="Партии" desc="Каждая партия подтверждается порогом отдельно." testid="batches">
          <Table
            cols={[{ label: "№" }, { label: "Что", primary: true }, { label: "Статус" }, { label: "Транзакция" }]}
            rows={(batches.data ?? []).map((b) => ({ key: b.id, cells: [b.batch_no + 1, BATCH_KIND[b.kind] ?? b.kind, <a href={`#/approve/${b.id}`} data-testid={`batch-${b.batch_no}`}><Badge s={b.status} /></a>, <Addr value={b.tx_hash} />] }))}
            empty="Ещё не отправлялась."
          />
        </Section>
        <Section title="Сделать регулярной" desc="Расписание создаёт черновик по образцу этой выплаты; отправка — как всегда, после проверки и подписей.">
          <div className="row">
            <select className="input-inline" data-testid="every" value={every} onChange={(e) => setEvery(e.target.value as "month" | "week")}><option value="month">раз в месяц</option><option value="week">раз в неделю</option></select>
            <button className="secondary" data-testid="schedule" onClick={a.run(async () => {
              await call(auth.headers, "POST", `/orgs/${orgId}/schedules`, { title: receipt.data!.payout.title, templatePayoutId: id, every, firstRunAt: nextRun(every) });
              window.location.hash = `#/org/${orgId}/schedules`;
            })}>Создать расписание</button>
          </div>
        </Section>
      </div>
    </>
  );
}

function nextRun(every: "month" | "week") {
  const d = new Date();
  if (every === "week") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

