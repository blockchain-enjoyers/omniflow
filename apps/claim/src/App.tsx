import { useEffect, useMemo, useState, type ReactNode } from "react";
import { formatUnits, isAddress, type Address, type EIP1193Provider } from "viem";
import { DepositStatus, parseClaimLink, type ClaimLink } from "@omniflow/shared";
import { LoginForm, useAuth } from "@omniflow/auth-client";
import { DEFAULT_RPC, RELAYER_URL } from "./config";
import { claimViaRelayer, claimWithOwnWallet, readDeposit, type DepositView } from "./claim";

// window.ethereum is typed `any` by the Privy SDK's globals; narrow it here.
const injected = () => (window as unknown as { ethereum?: EIP1193Provider }).ethereum;

type Phase = { kind: "idle" } | { kind: "working" } | { kind: "done"; recipient: string; hash: string } | { kind: "error"; message: string };

export function App({ withLogin }: { withLogin: boolean }) {
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
      <Frame>
        <section className="card">
          <h1>Ссылка повреждена</h1>
          <p className="hint" style={{ marginTop: 8 }}>Откройте ссылку из письма целиком, без изменений.</p>
        </section>
      </Frame>
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

  const pending = deposit?.status === DepositStatus.Pending && phase.kind !== "done";
  return (
    <Frame>
      <section className="card hero">
        <p className="hint" style={{ marginBottom: 4 }}>Вам отправлен платёж</p>
        <h1 className="amount" data-testid="amount">{amount}</h1>
        {deposit?.status === DepositStatus.Pending && deposit.autoRefundAt > 0 && (
          <p className="small muted" style={{ margin: 0 }}>Получите до {new Date(deposit.autoRefundAt * 1000).toLocaleDateString("ru-RU")} — потом деньги вернутся отправителю.</p>
        )}
        {readError && <div className="callout bad" style={{ marginTop: 12 }}>Не удалось прочитать платёж из сети: {readError}. Укажите другой RPC в технических деталях.</div>}
        {deposit?.status === DepositStatus.Claimed && phase.kind !== "done" && <div className="callout ok" style={{ marginTop: 12 }} data-testid="status">Платёж уже получен.</div>}
        {deposit?.status === DepositStatus.Refunded && <div className="callout" style={{ marginTop: 12 }} data-testid="status">Отправитель вернул этот платёж себе.</div>}
        {deposit?.status === DepositStatus.None && <div className="callout" style={{ marginTop: 12 }} data-testid="status">Платёж по этой ссылке не найден в этой сети.</div>}
      </section>

      {pending && (
        <>
          {RELAYER_URL && withLogin && (
            <EmbeddedClaim busy={phase.kind === "working"} onClaim={(wallet) => run(async () => ({ recipient: wallet, hash: await claimViaRelayer(RELAYER_URL!, link, wallet, rpc) }))} />
          )}
          {RELAYER_URL && (
            <section className="card">
              <h2>{withLogin ? "На свой адрес" : "Получить на адрес"}</h2>
              <p className="hint" style={{ marginTop: 4 }}>Адрес кошелька в сети {chainLabel(link.chainId)}. Газ за получение платит отправитель.</p>
              <div className="row">
                <input className="grow mono" data-testid="address" placeholder="0x…" value={address} onChange={(e) => setAddress(e.target.value.trim())} />
                <button
                  data-testid="claim-relayer"
                  disabled={!isAddress(address) || phase.kind === "working"}
                  onClick={() => run(async () => ({ recipient: address, hash: await claimViaRelayer(RELAYER_URL!, link, address as Address, rpc) }))}
                >
                  Получить
                </button>
              </div>
            </section>
          )}
          <section className="card">
            <h2>{RELAYER_URL ? "Своим кошельком" : "Получить своим кошельком"}</h2>
            <p className="hint" style={{ marginTop: 4 }}>Кошелёк отправит транзакцию сам — нужно немного ETH на газ. Работает, даже если сервисы Omniflow недоступны.</p>
            <button className="secondary block" data-testid="claim-wallet" disabled={!injected() || phase.kind === "working"} onClick={() => run(() => claimWithOwnWallet(injected()!, link, rpc))}>
              {injected() ? "Подключить кошелёк и получить" : "Кошелёк в браузере не найден"}
            </button>
          </section>
        </>
      )}

      {phase.kind === "working" && <div className="callout info">Отправляем…</div>}
      {phase.kind === "error" && <div className="callout bad" data-testid="error">Не получилось: {phase.message}</div>}
      {phase.kind === "done" && (
        <section className="card done" data-testid="done">
          <div className="check">✓</div>
          <h2>Готово</h2>
          <p style={{ marginTop: 6 }}>{amount} отправлено на</p>
          <p className="mono small" style={{ overflowWrap: "anywhere" }}>{phase.recipient}</p>
          <p className="small muted" style={{ overflowWrap: "anywhere", marginBottom: 0 }}>Транзакция {phase.hash}</p>
        </section>
      )}

      <details className="card tech">
        <summary>Технические детали</summary>
        <p className="small" style={{ marginTop: 12, overflowWrap: "anywhere" }}>Сеть {link.chainId}, контракт {link.escrow}, платёж {link.depositId}.</p>
        <label className="field"><span>RPC</span><input className="mono" value={rpc} onChange={(e) => setRpc(e.target.value.trim())} /></label>
        <p className="small muted" style={{ marginBottom: 0 }}>Ссылка — единственный ключ к платежу. Не пересылайте её. Omniflow никогда не попросит сид-фразу или подпись.</p>
      </details>
    </Frame>
  );
}

const chainLabel = (id: number) => ({ 42161: "Arbitrum One", 421614: "Arbitrum Sepolia", 31337: "локальная (anvil)" })[id] ?? String(id);

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="claim-page">
      <div className="brand"><span className="logo">O</span> Omniflow</div>
      <main className="claim-main">{children}</main>
      <p className="small muted" style={{ textAlign: "center" }}>Некастодиальные выплаты: деньги лежат в контракте, пока вы их не заберёте.</p>
    </div>
  );
}

/** sign in by email; the payment goes to the embedded wallet created at login. Gas is paid by the relayer. */
function EmbeddedClaim({ busy, onClaim }: { busy: boolean; onClaim: (wallet: Address) => void }) {
  const auth = useAuth();
  if (!auth.ready) return null;
  return (
    <section className="card recommended">
      <div className="row" style={{ justifyContent: "space-between" }}><h2>Получить по почте</h2><span className="badge accent">проще всего</span></div>
      {!auth.user ? (
        <>
          <p className="hint" style={{ marginTop: 4 }}>Войдите по почте — кошелёк создастся сам, ничего устанавливать не нужно.</p>
          <LoginForm />
        </>
      ) : !auth.user.wallet ? (
        <p className="hint">Кошелёк ещё создаётся — обновите страницу через несколько секунд.</p>
      ) : (
        <>
          <p className="hint" style={{ marginTop: 4 }}>Вы вошли как <b>{auth.user.email ?? auth.user.did}</b>. Платёж придёт на ваш кошелёк:</p>
          <div className="addr-box small" data-testid="embedded-wallet">{auth.user.wallet}</div>
          <div className="actions">
            <button data-testid="claim-embedded" disabled={busy} onClick={() => onClaim(auth.user!.wallet!)}>Получить</button>
            <button className="ghost" onClick={() => void auth.logout()}>Выйти</button>
          </div>
        </>
      )}
    </section>
  );
}
