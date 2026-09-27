import { useAuth } from "@omniflow/auth-client";
import { call, type NextStep } from "../api";
import { Addr, Callout, Err, Section, Table, usdc, useAction, useLoad } from "../ui";

/**
 * Role B. What leaves the account, then one signature. NB: the wallet signs a hash; what it stands for is shown
 * by this page — the blind-signing risk, accepted for now.
 */
export function ApprovePage({ batchId }: { batchId: string }) {
  const auth = useAuth();
  const step = useLoad(() => call<NextStep>(auth.headers, "GET", `/batches/${batchId}/next-step`), [batchId]);
  const a = useAction();
  const s = step.data;
  const m = s && (s.step === "approve" || s.step === "final") ? s.manifest : null;
  const paying = m?.rows.filter((r) => r.kind === "transfer" || r.kind === "escrow") ?? [];
  const total = paying.reduce((x, r) => x + BigInt(r.amount.$big), 0n);
  const kind = m?.rows[0]?.kind;
  const what =
    kind === "refund" ? `Отозвать ${m!.rows.length} неполученных платежей — деньги вернутся на аккаунт организации`
      : kind === "rekey" ? `Выслать новые ссылки на ${m!.rows.length} неполученных платежей — старые ссылки перестанут работать`
        : `С аккаунта организации уходит ${usdc(total)}, ${paying.length} получателям`;
  const recipients = m?.rows.length ?? 0;
  return (
    <div className="narrow">
      <div className="page-head"><div><h1>Подтверждение</h1><div className="sub">{m ? `Партия ${m.batchNo + 1}` : "…"}</div></div></div>
      <Section testid="approve">
        {m && (
          <>
            <p className="hint" style={{ marginBottom: 2 }}>{kind === "refund" ? "Отзыв неполученных платежей" : kind === "rekey" ? "Новые ссылки на платежи" : "Сумма партии"}</p>
            {kind !== "refund" && kind !== "rekey" && <div className="approve-total">{usdc(total)}</div>}
            <p data-testid="what" style={{ fontWeight: 600 }}>{what}</p>
            <p className="small muted" style={{ marginBottom: 16 }}>Аккаунт <Addr value={m.account} /></p>
            <div className="card flush" style={{ boxShadow: "none", marginBottom: 16 }}>
              <Table
                cols={[{ label: "Кому", primary: true }, { label: "Сумма", className: "r" }]}
                rows={m.rows.map((r) => ({
                  key: r.rowId,
                  cells: [
                    r.kind === "transfer" ? <Addr value={r.to} full /> : <span>{r.kind === "escrow" ? "по ссылке на почту (эскроу)" : r.kind === "refund" ? "отзыв из эскроу" : "новая ссылка"}</span>,
                    <span className="num">{r.kind === "rekey" ? "—" : usdc(r.amount.$big)}</span>,
                  ],
                }))}
              />
            </div>
            <Callout tone="warn">Кошелёк покажет только хеш. Подписывайте, только если список выше ({recipients}) — тот, что вы ожидаете.</Callout>
            <div className="actions">
              <button
                className="block"
                data-testid="sign"
                disabled={a.busy}
                onClick={a.run(async () => {
                  if (s!.step === "approve") {
                    const sig = await auth.signTypedData(s!.typedData, what);
                    await call(auth.headers, "POST", `/batches/${batchId}/approvals`, { signature: sig });
                  } else if (s!.step === "final") {
                    const sig = await auth.signHash(s!.userOpHash, `${what} — ваша подпись последняя, операция уйдёт в сеть`);
                    await call(auth.headers, "POST", `/batches/${batchId}/final`, { signature: sig });
                  }
                  await step.reload();
                })}
              >
                {s!.step === "final" ? "Подписать и отправить" : "Подтвердить"}
              </button>
            </div>
          </>
        )}
        {s?.step === "done" && <Callout tone="ok" testid="done">Вы подписали. Ждём остальных подтверждающих.</Callout>}
        {s?.step === "closed" && <Callout tone="info" testid="closed">Подписывать нечего: партия уже {s.status === "mined" ? "исполнена" : s.status === "submitted" ? "отправлена в сеть" : s.status}.</Callout>}
        <Err e={step.error || a.error} />
      </Section>
    </div>
  );
}
