import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatUnits } from "viem";

export const usdc = (units: string | bigint) => `${Number(formatUnits(BigInt(units), 6)).toLocaleString("ru-RU", { maximumFractionDigits: 6 })} USDC`;
export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setError("");
    try {
      setData(await fn());
    } catch (e) {
      setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setData };
}

/** Wraps an action: shows its error, disables while running. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = (fn: () => Promise<unknown>) => async () => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export const Err = ({ e }: { e?: string }) => (e ? <p className="warn" data-testid="error">{e}</p> : null);
export const Section = ({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) => (
  <section data-testid={testid}>
    <h2>{title}</h2>
    {children}
  </section>
);

const STATUS: Record<string, string> = {
  draft: "черновик", confirming: "на подтверждении", partially_executed: "частично исполнена", closed: "закрыта",
  waiting_details: "ждёт реквизитов", other_chain: "другая сеть — не уйдёт", ready: "готова", in_batch: "в партии",
  sent: "отправлено", in_escrow: "по ссылке, не получено", claimed: "получено", refunded: "возвращено", failed: "не прошла",
  collecting: "собираем подписи", submitted: "отправлена в сеть", mined: "исполнена",
};
export const status = (s: string) => STATUS[s] ?? s;
