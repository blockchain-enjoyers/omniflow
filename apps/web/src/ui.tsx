import { useCallback, useEffect, useState, type ReactNode } from "react";
import { formatUnits } from "viem";
import { MODE } from "./mode";

export const usdc = (units: string | bigint) => `${Number(formatUnits(BigInt(units), 6)).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC`;
const CHAINS: Record<number, string> = { 42161: "Arbitrum One", 421614: "Arbitrum Sepolia (testnet)", 31337: "local chain (anvil)" };
export const chainName = (id: number) => (MODE === "demo" ? "Demo network" : CHAINS[id] ?? `chain ${id}`);
export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
export const date = (s: string) => new Date(s).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
export const dateTime = (s: string) => new Date(s).toLocaleString("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

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

export const Err = ({ e }: { e?: string }) => (e ? <p className="error" data-testid="error">{e}</p> : null);

/** A card. `flush` puts tables edge to edge. */
export function Section({ title, desc, actions, children, testid, flush }: { title?: ReactNode; desc?: ReactNode; actions?: ReactNode; children: ReactNode; testid?: string; flush?: boolean }) {
  return (
    <section className={`card${flush ? " flush" : ""}`} data-testid={testid}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {desc && <div className="desc">{desc}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

const STATUS: Record<string, [string, string]> = {
  draft: ["draft", ""], confirming: ["awaiting approval", "warn"], partially_executed: ["partially executed", "warn"], closed: ["closed", ""],
  waiting_details: ["needs details", "warn"], other_chain: ["other chain — won't be sent", "bad"], ready: ["ready", "accent"], in_batch: ["in batch", "info"],
  sent: ["sent", "ok"], in_escrow: ["link sent, not claimed", "info"], claimed: ["claimed", "ok"], refunded: ["returned", ""], failed: ["failed", "bad"],
  collecting: ["collecting signatures", "warn"], submitted: ["submitted", "info"], mined: ["executed", "ok"], deployed: ["deployed", "ok"],
};
export const status = (s: string) => STATUS[s]?.[0] ?? s;
export const Badge = ({ s, testid, extra }: { s: string; testid?: string; extra?: string }) => (
  <span className={`badge ${STATUS[s]?.[1] ?? ""}`} data-testid={testid}>{status(s)}{extra ?? ""}</span>
);

/** An address: shortened with a copy button, or in full. */
export function Addr({ value, full, testid }: { value?: string | null; full?: boolean; testid?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="muted">—</span>;
  return (
    <span className="addr" title={value}>
      <span className="v" data-testid={testid}>{full ? value : short(value)}</span>
      <button
        type="button"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

export interface Col { label: string; className?: string; primary?: boolean }
/** A table that becomes a list of cards on a phone: every cell carries its column label. */
export function Table({ cols, rows, empty, testid }: { cols: Col[]; rows: { key: string; cells: ReactNode[]; className?: string }[]; empty?: ReactNode; testid?: string }) {
  return (
    <div className="table-wrap">
      <table className="t stackable" data-testid={testid}>
        <thead>
          <tr>{cols.map((c, i) => <th key={i} className={c.className}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.className}>
              {r.cells.map((cell, i) => (
                <td key={i} data-label={cols[i]?.label ?? ""} className={`${cols[i]?.className ?? ""}${cols[i]?.primary ? " primary" : ""}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && empty && <div className="empty">{empty}</div>}
    </div>
  );
}

export const Field = ({ label, help, children }: { label: ReactNode; help?: ReactNode; children: ReactNode }) => (
  <label className="field">
    <span>{label}</span>
    {children}
    {help && <span className="help">{help}</span>}
  </label>
);

export const Callout = ({ tone, children, testid }: { tone?: "warn" | "bad" | "ok" | "info" | "emu"; children: ReactNode; testid?: string }) => (
  <div className={`callout ${tone ?? ""}`} data-testid={testid}>{children}</div>
);

export const Stat = ({ label, value, foot, sm, testid }: { label: string; value: ReactNode; foot?: ReactNode; sm?: boolean; testid?: string }) => (
  <div className="card stat">
    <span className="label">{label}</span>
    <span className={`value${sm ? " sm" : ""}`} data-testid={testid}>{value}</span>
    {foot && <span className="foot">{foot}</span>}
  </div>
);
