import { useEffect, useMemo, useState } from "react";
import { formatUnits, isAddress, type Address, type EIP1193Provider } from "viem";
import { DepositStatus, parseClaimLink, type ClaimLink } from "@omniflow/shared";
import { DEFAULT_RPC, RELAYER_URL } from "./config";
import { claimViaRelayer, claimWithOwnWallet, readDeposit, type DepositView } from "./claim";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type Phase = { kind: "idle" } | { kind: "working" } | { kind: "done"; recipient: string; hash: string } | { kind: "error"; message: string };

export function App() {
  const link = useMemo<ClaimLink | Error>(() => {
    try {
      return parseClaimLink(window.location.href);
    } catch (e) {
      return e as Error;
    }
  }, []);
  const [rpc, setRpc] = useState(() => (link instanceof Error ? "" : (DEFAULT_RPC[link.chainId] ?? "")));
  const [deposit, setDeposit] = useState<DepositView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    if (link instanceof Error || !rpc) return;
    readDeposit(link, rpc).then(setDeposit, (e) => setReadError(String(e?.shortMessage ?? e?.message ?? e)));
  }, [link, rpc, phase.kind === "done"]);

  if (link instanceof Error) {
    return (
      <main>
        <h1>Ссылка повреждена</h1>
        <p>Откройте ссылку из письма целиком, без изменений.</p>
      </main>
    );
  }

  const amount = deposit ? `${formatUnits(deposit.amount, deposit.decimals)} ${deposit.symbol}` : "…";

  async function run(fn: () => Promise<{ recipient: string; hash: string }>) {
    setPhase({ kind: "working" });
    try {
      setPhase({ kind: "done", ...(await fn()) });
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      setPhase({ kind: "error", message: err.shortMessage ?? err.message ?? String(e) });
    }
  }

  return (
    <main>
      <h1>Вам отправлен платёж</h1>
      <p className="amount" data-testid="amount">{amount}</p>

      {readError && <p className="warn">Не удалось прочитать платёж из сети: {readError}. Укажите другой RPC ниже.</p>}
      {deposit?.status === DepositStatus.Claimed && <p data-testid="status">Платёж уже получен.</p>}
      {deposit?.status === DepositStatus.Refunded && <p data-testid="status">Отправитель вернул этот платёж себе.</p>}
      {deposit?.status === DepositStatus.None && <p data-testid="status">Платёж по этой ссылке не найден в этой сети.</p>}

      {deposit?.status === DepositStatus.Pending && phase.kind !== "done" && (
        <>
          {RELAYER_URL && (
            <section>
              <h2>Получить на адрес</h2>
              <p>Вставьте адрес своего кошелька в сети {link.chainId}. Газ за получение платит отправитель.</p>
              <input data-testid="address" placeholder="0x…" value={address} onChange={(e) => setAddress(e.target.value.trim())} />
              <button
                data-testid="claim-relayer"
                disabled={!isAddress(address) || phase.kind === "working"}
                onClick={() => run(async () => ({ recipient: address, hash: await claimViaRelayer(RELAYER_URL!, link, address as Address) }))}
              >
                Получить
              </button>
            </section>
          )}
          <section>
            <h2>{RELAYER_URL ? "Или своим кошельком" : "Получить своим кошельком"}</h2>
            <p>Кошелёк отправит транзакцию сам — нужен немного ETH на газ. Работает, даже если сервисы Omniflow недоступны.</p>
            <button data-testid="claim-wallet" disabled={!window.ethereum || phase.kind === "working"} onClick={() => run(() => claimWithOwnWallet(window.ethereum!, link, rpc))}>
              {window.ethereum ? "Подключить кошелёк и получить" : "Кошелёк в браузере не найден"}
            </button>
          </section>
        </>
      )}

      {phase.kind === "working" && <p>Отправляем…</p>}
      {phase.kind === "error" && <p className="warn" data-testid="error">Не получилось: {phase.message}</p>}
      {phase.kind === "done" && (
        <p data-testid="done">
          Готово. {amount} отправлено на {phase.recipient}. Транзакция {phase.hash}
        </p>
      )}

      <details>
        <summary>Технические детали</summary>
        <p>Сеть {link.chainId}, контракт {link.escrow}, платёж {link.depositId}.</p>
        <label>
          RPC: <input value={rpc} onChange={(e) => setRpc(e.target.value.trim())} />
        </label>
        <p>Ссылка — единственный ключ к платежу. Не пересылайте её. Omniflow никогда не попросит сид-фразу или подпись.</p>
      </details>
    </main>
  );
}
