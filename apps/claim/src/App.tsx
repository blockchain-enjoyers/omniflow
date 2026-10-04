import { useEffect, useMemo, useState, type ReactNode } from "react";
import { formatUnits, isAddress, type Address, type EIP1193Provider } from "viem";
import { DepositStatus, parseClaimLink, type ClaimLink } from "@omniflow/shared";
import { LoginForm, useAuth } from "@omniflow/auth-client";
import { DEMO, DEMO_MAILBOX_URL, defaultRpc, RELAYER_URL } from "./config";
import { CHAIN_NAMES, claimViaRelayer, claimWithOwnWallet, readDeposit, WrongNetworkError, type DepositView } from "./claim";

// window.ethereum is typed `any` by the Privy SDK's globals; narrow it here.
const injected = () => (window as unknown as { ethereum?: EIP1193Provider }).ethereum;

type Phase = { kind: "idle" } | { kind: "working" } | { kind: "done"; recipient: string; hash: string } | { kind: "error"; message: string } | { kind: "wrong-network"; cancelled: boolean };

export function App({ withLogin }: { withLogin: boolean }) {
  const link = useMemo<ClaimLink | Error>(() => {
    try {
      return parseClaimLink(window.location.href);
    } catch (e) {
      return e as Error;
    }
  }, []);
  const [rpc, setRpc] = useState(() => (link instanceof Error ? "" : defaultRpc(link.chainId)));
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
          <h1>This link is broken</h1>
          <p className="hint" style={{ marginTop: 8 }}>Open the link from the email in full, without changes.</p>
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
      if (e instanceof WrongNetworkError) return setPhase({ kind: "wrong-network", cancelled: e.cancelled });
      setPhase({ kind: "error", message: humanError(e) });
    }
  }

  const pending = deposit?.status === DepositStatus.Pending && phase.kind !== "done";
  return (
    <Frame>
      <section className="card hero">
        <p className="hint" style={{ marginBottom: 4 }}>You have been sent a payment</p>
        <h1 className="amount" data-testid="amount">{amount}</h1>
        {deposit?.status === DepositStatus.Pending && deposit.autoRefundAt > 0 && (
          <p className="small muted" style={{ margin: 0 }}>Claim by {new Date(deposit.autoRefundAt * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })} — after that the money returns to the sender.</p>
        )}
        {readError && <div className="callout bad" style={{ marginTop: 12 }}>Could not read the payment from the chain: {readError}. Set another RPC under Technical details.</div>}
        {deposit?.status === DepositStatus.Claimed && phase.kind !== "done" && <div className="callout ok" style={{ marginTop: 12 }} data-testid="status">This payment has already been claimed.</div>}
        {deposit?.status === DepositStatus.Refunded && <div className="callout" style={{ marginTop: 12 }} data-testid="status">The sender took this payment back.</div>}
        {deposit?.status === DepositStatus.None && <div className="callout" style={{ marginTop: 12 }} data-testid="status">No payment for this link on this chain.</div>}
      </section>

      {pending && (
        <>
          {RELAYER_URL && withLogin && (
            <EmbeddedClaim busy={phase.kind === "working"} onClaim={(wallet) => run(async () => ({ recipient: wallet, hash: await claimViaRelayer(RELAYER_URL!, link, wallet, rpc) }))} />
          )}
          {RELAYER_URL && (
            <section className="card">
              <h2>{withLogin ? "To my own address" : "Receive to an address"}</h2>
              <p className="hint" style={{ marginTop: 4 }}>A wallet address on {chainLabel(link.chainId)}. The sender pays the gas.</p>
              <div className="row">
                <input className="grow mono" data-testid="address" placeholder="0x…" value={address} onChange={(e) => setAddress(e.target.value.trim())} />
                <button
                  data-testid="claim-relayer"
                  disabled={!isAddress(address) || phase.kind === "working"}
                  onClick={() => run(async () => ({ recipient: address, hash: await claimViaRelayer(RELAYER_URL!, link, address as Address, rpc) }))}
                >
                  Receive
                </button>
              </div>
            </section>
          )}
          <section className="card">
            <h2>{RELAYER_URL ? "With my own wallet" : "Receive with my own wallet"}</h2>
            <p className="hint" style={{ marginTop: 4 }}>Your wallet sends the transaction itself — it needs a little ETH for gas. Works even if Omniflow is down.</p>
            <button className="secondary block" data-testid="claim-wallet" disabled={!injected() || phase.kind === "working"} onClick={() => run(() => claimWithOwnWallet(injected()!, link, rpc))}>
              {injected() ? "Connect wallet and receive" : "No wallet found in this browser"}
            </button>
          </section>
        </>
      )}

      {phase.kind === "working" && <div className="callout info">Sending…</div>}
      {phase.kind === "error" && <div className="callout bad" data-testid="error">Did not work: {phase.message}</div>}
      {phase.kind === "wrong-network" && (
        <div className="callout warn" data-testid="wrong-network">
          <p style={{ marginTop: 0 }}>
            Your wallet is on another network. This payment is on <b>{chainLabel(link.chainId)}</b>.{" "}
            {phase.cancelled ? "The switch was cancelled in your wallet." : `If your wallet cannot switch by itself, choose ${chainLabel(link.chainId)} in it and try again.`}
          </p>
          <button data-testid="switch-network" onClick={() => run(() => claimWithOwnWallet(injected()!, link, rpc))}>Switch network and receive</button>
        </div>
      )}
      {phase.kind === "done" && (
        <section className="card done" data-testid="done">
          <div className="check">✓</div>
          <h2>Done</h2>
          <p style={{ marginTop: 6 }}>{amount} sent to</p>
          <p className="mono small" style={{ overflowWrap: "anywhere" }}>{phase.recipient}</p>
          <p className="small muted" style={{ overflowWrap: "anywhere", marginBottom: 0 }}>Transaction {phase.hash}</p>
        </section>
      )}

      <details className="card tech">
        <summary>Technical details</summary>
        <p className="small" style={{ marginTop: 12, overflowWrap: "anywhere" }}>Chain {link.chainId}, contract {link.escrow}, payment {link.depositId}.</p>
        <label className="field"><span>RPC</span><input className="mono" value={rpc} onChange={(e) => setRpc(e.target.value.trim())} /></label>
        <p className="small muted" style={{ marginBottom: 0 }}>The link is the only key to this payment. Do not forward it. Omniflow will never ask for a seed phrase or a signature.</p>
      </details>
    </Frame>
  );
}

const chainLabel = (id: number) => (DEMO ? "the demo network" : CHAIN_NAMES[id] ?? `chain ${id}`);

/** Wallet and RPC errors in words a recipient can act on; the technical text only when nothing better is known. */
function humanError(e: unknown): string {
  const err = e as { code?: number; name?: string; shortMessage?: string; message?: string; cause?: { code?: number } };
  if (err.code === 4001 || err.cause?.code === 4001 || err.name === "UserRejectedRequestError") return "you cancelled it in your wallet.";
  if (/insufficient funds/i.test(err.message ?? "")) return "your wallet needs a little ETH on this network to pay for gas. The other ways to receive above need none.";
  return err.shortMessage ?? err.message ?? String(e);
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="claim-page">
      <div className="brand"><span className="logo">O</span> Omniflow{DEMO && <span className="badge warn" data-testid="demo-badge">Demo mode</span>}</div>
      {DEMO && <div className="callout warn" data-testid="demo-banner">Demo mode — this is test money on a demo network, not a real payment.</div>}
      <main className="claim-main">{children}</main>
      <p className="small muted" style={{ textAlign: "center" }}>Non-custodial payouts: the money stays in a contract until you claim it.</p>
    </div>
  );
}

/** sign in by email; the payment goes to the embedded wallet created at login. Gas is paid by the relayer. */
function EmbeddedClaim({ busy, onClaim }: { busy: boolean; onClaim: (wallet: Address) => void }) {
  const auth = useAuth();
  if (!auth.ready) return null;
  return (
    <section className="card recommended">
      <div className="row" style={{ justifyContent: "space-between" }}><h2>Receive with email</h2><span className="badge accent">easiest</span></div>
      {!auth.user ? (
        <>
          <p className="hint" style={{ marginTop: 4 }}>Sign in with your email — a wallet is created for you, nothing to install.</p>
          <LoginForm />
          {DEMO_MAILBOX_URL && <p className="hint small" style={{ marginTop: 8, marginBottom: 0 }}><a href={DEMO_MAILBOX_URL} target="_blank" rel="noreferrer">Open the demo mailbox</a> to read the code.</p>}
        </>
      ) : !auth.user.wallet ? (
        <p className="hint">Your wallet is still being created — refresh in a few seconds.</p>
      ) : (
        <>
          <p className="hint" style={{ marginTop: 4 }}>Signed in as <b>{auth.user.email ?? auth.user.did}</b>. The payment goes to your wallet:</p>
          <div className="addr-box small" data-testid="embedded-wallet">{auth.user.wallet}</div>
          <div className="actions">
            <button data-testid="claim-embedded" disabled={busy} onClick={() => onClaim(auth.user!.wallet!)}>Receive</button>
            <button className="ghost" onClick={() => void auth.logout()}>Sign out</button>
          </div>
        </>
      )}
    </section>
  );
}
