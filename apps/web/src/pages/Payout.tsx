import { useState } from "react";
import { useAuth } from "@omniflow/auth-client";
import { call, type Batch, type Receipt, type Review, type ReviewRow } from "../api";
import { Err, Section, short, status, usdc, useAction, useLoad } from "../ui";

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

  return (
    <>
      {receipt.data && <p><a href={`#/org/${receipt.data.payout.orgId}`}>← к организации</a></p>}
      <h1 data-testid="payout-title">{receipt.data?.payout.title ?? "…"}</h1>
      <p>Статус: <b data-testid="payout-status">{status(receipt.data?.payout.status ?? "")}</b></p>

      {s && s.rows > 0 && !closed && (
        <Section title="Проверка перед отправкой" testid="review">
          <p>
            <b>Уйдёт:</b> {s.toAddress + s.byEmail} строк, {usdc(s.total)} — на адрес {s.toAddress}, по ссылке на почту {s.byEmail}.{" "}
            {s.balanceSufficient ? "Баланса хватает." : <b className="warn">Баланса не хватает.</b>}
          </p>
          <p>Автовозврат неполученного: {review.data!.autoRefundDays ? `через ${review.data!.autoRefundDays} дн.` : "бессрочно"}</p>
          <div className="group"><b>Новые получатели: {s.newRecipients.length}</b> — главный источник необратимой ошибки
            <ul>{s.newRecipients.map((r) => <li key={r.rowId}>{who(r)} — {usdc(r.amount)}</li>)}</ul></div>
          {s.changedAmount.length > 0 && <div className="group"><b>Сумма изменилась:</b><ul>{s.changedAmount.map((c) => <li key={c.row.rowId}>{who(c.row)}: {usdc(c.previous)} → {usdc(c.row.amount)}</li>)}</ul></div>}
          {s.outliers.length > 0 && <div className="group warn"><b>Выбросы:</b><ul>{s.outliers.map((c) => <li key={c.row.rowId}>{who(c.row)}: было {usdc(c.previous)}, сейчас {usdc(c.row.amount)}</li>)}</ul></div>}
          {[...s.duplicateAddress, ...s.duplicateEmail].length > 0 && <div className="group warn"><b>Дубли:</b><ul>{[...s.duplicateAddress, ...s.duplicateEmail].map((g, i) => <li key={i}>{g.map(who).join(" | ")}</li>)}</ul></div>}
          <div className="group"><b>Не уйдут: {s.notSent.length}</b><ul>{s.notSent.map((n) => <li key={n.row.rowId}>{n.row.name}: {REASON[n.reason] ?? n.reason}</li>)}</ul></div>
          {openBatch ? (
            <p>Партия уже на подтверждении — <a href={`#/approve/${openBatch.id}`}>открыть</a>.</p>
          ) : (
            <button data-testid="freeze" disabled={a.busy || s.toAddress + s.byEmail === 0} onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/batches`); await reload(); })}>
              Отправить на подтверждение
            </button>
          )}
        </Section>
      )}

      <Section title="Строки" testid="rows">
        <table>
          <thead><tr><th /><th>Кому</th><th>Сумма</th><th>Статус</th><th>Транзакция</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.row}>
                <td>{r.status === "in_escrow" && <input type="checkbox" data-testid={`pick-${r.name}`} checked={picked.includes(r.row)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.row] : picked.filter((x) => x !== r.row))} />}</td>
                <td>{r.name}<br /><span className="mono small">{r.address ?? r.email ?? "—"}</span></td>
                <td>{edit[r.row] ? <input style={{ width: 90 }} value={edit[r.row]!.amount ?? ""} onChange={(e) => setEdit({ ...edit, [r.row]: { ...edit[r.row], amount: e.target.value } })} /> : usdc(r.amount)}</td>
                <td data-testid={`status-${r.name}`}>{status(r.status)}{r.failReason ? ` (${r.failReason})` : ""}</td>
                <td className="mono small">{short(r.txHash)}</td>
                <td>
                  {editable(r.status) && !closed && !edit[r.row] && <button className="secondary" onClick={() => setEdit({ ...edit, [r.row]: { amount: String(Number(r.amount) / 1e6), address: r.address ?? "", email: r.email ?? "" } })}>изменить</button>}
                  {edit[r.row] && (
                    <>
                      <input placeholder="адрес" value={edit[r.row]!.address ?? ""} onChange={(e) => setEdit({ ...edit, [r.row]: { ...edit[r.row], address: e.target.value.trim() } })} />
                      <input placeholder="почта" value={edit[r.row]!.email ?? ""} onChange={(e) => setEdit({ ...edit, [r.row]: { ...edit[r.row], email: e.target.value.trim() } })} />
                      <button onClick={a.run(async () => { const e = edit[r.row]!; await call(auth.headers, "PATCH", `/payouts/${id}/rows/${r.row}`, { amount: e.amount, address: e.address || null, email: e.email || null }); const n = { ...edit }; delete n[r.row]; setEdit(n); await reload(); })}>сохранить</button>
                      <button className="secondary" onClick={a.run(async () => { await call(auth.headers, "PATCH", `/payouts/${id}/rows/${r.row}`, { remove: true }); await reload(); })}>удалить строку</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!closed && (
          <div className="row">
            <input placeholder="имя" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
            <input placeholder="адрес" value={add.address} onChange={(e) => setAdd({ ...add, address: e.target.value.trim() })} />
            <input placeholder="или почта" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value.trim() })} />
            <input placeholder="сумма" style={{ width: 90 }} value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} />
            <button className="secondary" data-testid="add-row" onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/rows`, { name: add.name, address: add.address || undefined, email: add.email || undefined, amount: add.amount, chainId: receipt.data!.payout.chainId }); setAdd({ name: "", address: "", email: "", amount: "" }); await reload(); })}>+ строка</button>
          </div>
        )}
        {picked.length > 0 && (
          <p>
            Выбрано по ссылке, не получено: {picked.length}.{" "}
            <button data-testid="rekey" onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/rekey`, { rows: picked }); setPicked([]); await reload(); })}>Выслать новые ссылки</button>{" "}
            <button data-testid="revoke" className="danger" onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/revoke`, { rows: picked }); setPicked([]); await reload(); })}>Отозвать</button>
            <span className="hint"> Оба действия подтверждаются порогом, как выплата. Отозванные деньги вернутся на аккаунт организации.</span>
          </p>
        )}
      </Section>

      {!closed && rows.some((r) => !r.address && ["waiting_details", "ready"].includes(r.status)) && (
        <Section title="Форма реквизитов" testid="forms">
          <p className="hint">Получатель сам укажет адрес или почту. Это не ссылка на деньги. После заполнения строку нужно отправить на подтверждение.</p>
          <button data-testid="forms-create" onClick={a.run(async () => setLinks(await call(auth.headers, "POST", `/payouts/${id}/forms`, {})))}>Создать ссылки</button>
          <ul>{links.map((l) => <li key={l.row}>{l.name}: {l.emailed ? "отправлена на почту" : <><span className="mono small" data-testid={`form-link-${l.name}`}>{l.link}</span> — передайте получателю</>}</li>)}</ul>
        </Section>
      )}

      <Section title="Партии" testid="batches">
        <table>
          <thead><tr><th>№</th><th>Что</th><th>Статус</th><th>Транзакция</th></tr></thead>
          <tbody>
            {batches.data?.map((b) => (
              <tr key={b.id}><td>{b.batch_no + 1}</td><td>{BATCH_KIND[b.kind] ?? b.kind}</td><td><a href={`#/approve/${b.id}`} data-testid={`batch-${b.batch_no}`}>{status(b.status)}</a></td><td className="mono small">{short(b.tx_hash)}</td></tr>
            ))}
          </tbody>
        </table>
        <button className="secondary" data-testid="refresh" onClick={reload}>Обновить</button>
      </Section>

      <Section title="Ещё">
        <button className="secondary" data-testid="repeat" onClick={a.run(async () => { const p = await call<{ id: string }>(auth.headers, "POST", `/payouts/${id}/repeat`, {}); window.location.hash = `#/payout/${p.id}`; })}>Повторить с правкой</button>{" "}
        <select value={every} onChange={(e) => setEvery(e.target.value as "month" | "week")}><option value="month">раз в месяц</option><option value="week">раз в неделю</option></select>{" "}
        <button className="secondary" data-testid="schedule" onClick={a.run(async () => {
          const org = receipt.data!.payout.orgId;
          await call(auth.headers, "POST", `/orgs/${org}/schedules`, { title: receipt.data!.payout.title, templatePayoutId: id, every, firstRunAt: nextRun(every) });
          window.location.hash = `#/org/${org}/schedules`;
        })}>Сделать регулярной</button>{" "}
        {!closed && <button className="secondary" data-testid="close" onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/close`); await reload(); })}>Закрыть выплату</button>}
      </Section>
      <Err e={a.error || receipt.error} />
    </>
  );
}

function nextRun(every: "month" | "week") {
  const d = new Date();
  if (every === "week") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

