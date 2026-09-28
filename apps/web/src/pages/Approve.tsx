import { useAuth } from "@omniflow/auth-client";
import { call, type Batch, type NextStep } from "../api";
import { Addr, Callout, Err, Section, short, Table, toast, usdc, useAction, useLoad, usePoll } from "../ui";

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
    kind === "refund" ? `Revoke ${m!.rows.length} unclaimed payments — the money returns to the organization account`
      : kind === "rekey" ? `Send new links for ${m!.rows.length} unclaimed payments — the old links stop working`
        : `${usdc(total)} leaves the organization account to ${paying.length} recipients`;
  const recipients = m?.rows.length ?? 0;
  const payoutId = s && "payoutId" in s ? s.payoutId : m?.payoutId;
  const batches = useLoad(() => (payoutId ? call<Batch[]>(auth.headers, "GET", `/payouts/${payoutId}/batches`) : Promise.resolve([])), [payoutId]);
  const b = batches.data?.find((x) => x.id === batchId);
  usePoll(async () => { await step.reload(); await batches.reload(); }, s?.step === "done" || (s?.step === "closed" && s.status === "submitted"), 3000);
  return (
    <div className="narrow">
      <div className="page-head"><div><h1>Approval</h1><div className="sub">{m ? `Batch ${m.batchNo + 1}` : "…"}</div></div></div>
      <Section testid="approve">
        {m && (
          <>
            <p className="hint" style={{ marginBottom: 2 }}>{kind === "refund" ? "Revoking unclaimed payments" : kind === "rekey" ? "New links for payments" : "Batch total"}</p>
            {kind !== "refund" && kind !== "rekey" && <div className="approve-total">{usdc(total)}</div>}
            <p data-testid="what" style={{ fontWeight: 600 }}>{what}</p>
            <p className="small muted" style={{ marginBottom: 16 }}>Account <Addr value={m.account} /></p>
            <div className="card flush" style={{ boxShadow: "none", marginBottom: 16 }}>
              <Table
                cols={[{ label: "To", primary: true }, { label: "Amount", className: "r" }]}
                rows={m.rows.map((r) => ({
                  key: r.rowId,
                  cells: [
                    r.kind === "transfer" ? <Addr value={r.to} full /> : <span>{r.kind === "escrow" ? "by email link (escrow)" : r.kind === "refund" ? "revoke from escrow" : "new link"}</span>,
                    <span className="num">{r.kind === "rekey" ? "—" : usdc(r.amount.$big)}</span>,
                  ],
                }))}
              />
            </div>
            <Callout tone="warn">Your wallet will show only a hash. Sign only if the list above ({recipients}) is what you expect.</Callout>
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
                    const sig = await auth.signHash(s!.userOpHash, `${what} — yours is the last signature; the operation goes on chain`);
                    await call(auth.headers, "POST", `/batches/${batchId}/final`, { signature: sig });
                  }
                  toast(s!.step === "final" ? "Signed — sending to the network" : "Signed");
                  await step.reload();
                  await batches.reload();
                })}
              >
                {s!.step === "final" ? "Sign and send" : "Approve"}
              </button>
            </div>
          </>
        )}
        {s?.step === "done" && <Callout tone="ok" testid="done">You have signed. Waiting for the other approvers{b ? ` — ${b.signedWeight} of ${b.threshold} so far` : ""}.</Callout>}
        {s?.step === "closed" && <Callout tone={s.status === "mined" ? "ok" : "info"} testid="closed">{s.status === "mined" ? "Done — this batch was executed on chain." : s.status === "submitted" ? "All signatures are in — sending to the network…" : `Nothing to sign: the batch is ${s.status}.`}</Callout>}
        {b && (s?.step === "done" || s?.step === "closed") && (
          <ul className="signer-list">
            {b.signers.map((x) => (
              <li key={x.address}><span className={`tick ${x.signed ? "yes" : "no"}`}>{x.signed ? "✓" : ""}</span><span>{x.email ?? short(x.address)}</span></li>
            ))}
          </ul>
        )}
        {payoutId && (s?.step === "done" || s?.step === "closed") && <div className="actions"><a className="btn secondary" href={`#/payout/${payoutId}`}>Open the payout</a><a className="btn secondary" href="#/">Back to home</a></div>}
        <Err e={step.error || a.error} />
      </Section>
    </div>
  );
}
