import { useState } from "react";
import { formatUnits } from "viem";
import { api, type Receipt, type Review, type ReviewRow } from "./api";

const fmt = (units: string) => formatUnits(BigInt(units), 6);
const who = (r: ReviewRow) => `${r.name}${r.address ? ` · ${r.address}` : ""}${r.email ? ` · ${r.email}` : ""}`;
const REASON: Record<string, string> = { "no-address-no-email": "нет ни адреса, ни почты — ждёт реквизитов", "other-chain": "другая сеть — не уйдёт" };

/** Role A: collects, reviews, freezes. No signing rights (01-PRODUCT §2). */
export function Operator() {
  const [orgId, setOrgId] = useState("");
  const [title, setTitle] = useState("");
  const [csv, setCsv] = useState("name,email,address,chain_id,amount\n");
  const [payoutId, setPayoutId] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [batchId, setBatchId] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState("");

  const guard = (fn: () => Promise<void>) => async () => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <section>
        <h2>Новая выплата</h2>
        <input data-testid="org" placeholder="ID организации" value={orgId} onChange={(e) => setOrgId(e.target.value.trim())} />
        <input data-testid="title" placeholder="Название" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea data-testid="csv" value={csv} onChange={(e) => setCsv(e.target.value)} />
        <button
          data-testid="create"
          onClick={guard(async () => {
            const p = await api.createPayout(orgId, { title, csv });
            setPayoutId(p.id);
            setReview(await api.review(p.id));
          })}
        >
          Загрузить
        </button>
      </section>

      {review && (
        <section data-testid="review">
          <h2>Проверка перед отправкой</h2>
          <p>
            <b>Итого:</b> {review.summary.rows} строк, {fmt(review.summary.total)} USDC — на адрес {review.summary.toAddress}, письмом {review.summary.byEmail}.{" "}
            {review.summary.balanceSufficient ? "Баланса хватает." : <b className="warn">Баланса не хватает.</b>}
          </p>
          <p>Автовозврат неполученного: {review.autoRefundDays ? `через ${review.autoRefundDays} дн.` : "бессрочно"}</p>
          <div className="group">
            <b>Новые получатели: {review.summary.newRecipients.length}</b> — главный источник необратимой ошибки
            <ul>{review.summary.newRecipients.map((r) => <li key={r.rowId}>{who(r)} — {fmt(r.amount)}</li>)}</ul>
          </div>
          {review.summary.changedAmount.length > 0 && (
            <div className="group"><b>Сумма изменилась:</b><ul>{review.summary.changedAmount.map((c) => <li key={c.row.rowId}>{who(c.row)}: {fmt(c.previous)} → {fmt(c.row.amount)}</li>)}</ul></div>
          )}
          {review.summary.outliers.length > 0 && (
            <div className="group warn"><b>Выбросы:</b><ul>{review.summary.outliers.map((c) => <li key={c.row.rowId}>{who(c.row)}: было {fmt(c.previous)}, сейчас {fmt(c.row.amount)}</li>)}</ul></div>
          )}
          {[...review.summary.duplicateAddress, ...review.summary.duplicateEmail].length > 0 && (
            <div className="group warn"><b>Дубли:</b><ul>{[...review.summary.duplicateAddress, ...review.summary.duplicateEmail].map((g, i) => <li key={i}>{g.map(who).join(" | ")}</li>)}</ul></div>
          )}
          <div className="group">
            <b>Не уйдут: {review.summary.notSent.length}</b>
            <ul>{review.summary.notSent.map((n) => <li key={n.row.rowId}>{n.row.name}: {REASON[n.reason] ?? n.reason}</li>)}</ul>
          </div>
          <button
            data-testid="freeze"
            onClick={guard(async () => {
              const b = await api.freeze(payoutId);
              setBatchId(b.id);
            })}
          >
            Отправить на подтверждение
          </button>
          {batchId && <p>Партия на подтверждении: <span className="mono" data-testid="batch-id">{batchId}</span></p>}
        </section>
      )}

      {payoutId && (
        <section>
          <h2>Квитанция</h2>
          <button data-testid="refresh-receipt" onClick={guard(async () => setReceipt(await api.receipt(payoutId)))}>Обновить</button>{" "}
          <button onClick={guard(async () => { await api.close(payoutId); setReceipt(await api.receipt(payoutId)); })}>Закрыть выплату</button>
          {receipt && (
            <>
              <p data-testid="payout-status">Статус: {receipt.payout.status}</p>
              <table data-testid="receipt">
                <thead><tr><th>Кому</th><th>Сумма</th><th>Статус</th><th>Транзакция</th></tr></thead>
                <tbody>
                  {receipt.rows.map((r) => (
                    <tr key={r.row}><td>{r.name}</td><td>{fmt(r.amount)}</td><td data-testid={`status-${r.name}`}>{r.status}</td><td className="mono">{r.txHash?.slice(0, 12) ?? ""}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
      {error && <p className="warn" data-testid="error">{error}</p>}
    </div>
  );
}
