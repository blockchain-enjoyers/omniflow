import { useAuth } from "@omniflow/auth-client";
import { call, type NextStep } from "../api";
import { Err, Section, usdc, useAction, useLoad } from "../ui";

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
  return (
    <Section title="Подтверждение" testid="approve">
      {m && (
        <>
          <p data-testid="what"><b>{what}</b></p>
          <p className="mono small">Аккаунт {m.account}</p>
          <table>
            <thead><tr><th>Кому</th><th>Сумма</th></tr></thead>
            <tbody>
              {m.rows.map((r) => (
                <tr key={r.rowId}>
                  <td className="mono">{r.kind === "transfer" ? r.to : r.kind === "escrow" ? "по ссылке на почту (эскроу)" : r.kind === "refund" ? "отзыв из эскроу" : "новая ссылка"}</td>
                  <td>{r.kind === "rekey" ? "—" : usdc(r.amount.$big)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="warn-soft">Кошелёк покажет только хеш. Подписывайте, только если список выше — тот, что вы ожидаете.</p>
          <button
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
        </>
      )}
      {s?.step === "done" && <p data-testid="done">Вы подписали. Ждём остальных подтверждающих.</p>}
      {s?.step === "closed" && <p data-testid="closed">Подписывать нечего: партия уже {s.status === "mined" ? "исполнена" : s.status === "submitted" ? "отправлена в сеть" : s.status}.</p>}
      <Err e={step.error || a.error} />
    </Section>
  );
}
