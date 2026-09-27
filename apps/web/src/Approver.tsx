import { useState } from "react";
import { formatUnits, type Hex } from "viem";
import { api, type NextStep } from "./api";
import type { ApproverSigner } from "./signer";

/**
 * Role B: sees what leaves the account and signs. NB: the approver signs a hash; what it stands for is shown
 * by this page — the blind-signing risk, accepted for now.
 */
export function Approver({ signer }: { signer: ApproverSigner | null }) {
  const [batchId, setBatchId] = useState("");
  const [step, setStep] = useState<NextStep | null>(null);
  const [msg, setMsg] = useState("");

  if (!signer) return <section><p>Войдите, чтобы подтверждать выплаты.</p></section>;

  const load = async () => {
    setMsg("");
    try {
      setStep(await api.nextStep(batchId, signer.address));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const sign = async () => {
    if (!step || step.step === "done" || step.step === "closed") return;
    try {
      if (step.step === "approve") {
        await api.approve(batchId, await signer.signTypedData(step.typedData));
        setMsg("Подтверждение принято. Ждём остальных.");
      } else {
        const r = await api.final(batchId, await signer.signHash(step.userOpHash));
        setMsg(`Отправлено: ${r.txHash}`);
      }
      setStep(await api.nextStep(batchId, signer.address));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const m = step && (step.step === "approve" || step.step === "final") ? step.manifest : null;
  const total = m ? m.rows.reduce((s, r) => s + BigInt(r.amount.$big), 0n) : 0n;

  return (
    <section>
      <h2>Подтверждение выплаты</h2>
      <p>Вы: <span className="mono" data-testid="me">{signer.address}</span></p>
      <input data-testid="batch" placeholder="ID партии" value={batchId} onChange={(e) => setBatchId(e.target.value.trim())} />
      <button data-testid="load" onClick={load}>Открыть</button>
      {m && (
        <>
          <p data-testid="what">С аккаунта организации уходит <b>{formatUnits(total, 6)} USDC</b>, {m.rows.length} получателям:</p>
          <ul>{m.rows.map((r) => <li key={r.rowId}>{r.kind === "transfer" ? r.to : r.kind === "escrow" ? "по ссылке на почту" : "отзыв из эскроу"} — {formatUnits(BigInt(r.amount.$big), 6)}</li>)}</ul>
          <button data-testid="sign" onClick={sign}>{step?.step === "final" ? "Подписать и отправить" : "Подтвердить"}</button>
        </>
      )}
      {step?.step === "done" && <p data-testid="done">Вы уже подписали эту партию.</p>}
      {step?.step === "closed" && <p data-testid="closed">Подписывать нечего: партия уже {step.status === "mined" ? "исполнена" : step.status}.</p>}
      {msg && <p data-testid="msg">{msg}</p>}
    </section>
  );
}

export type { Hex };
