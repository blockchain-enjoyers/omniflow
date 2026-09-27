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
    kind === "refund" ? `Revoke ${m!.rows.length} unclaimed payments — the money returns to the organization account`
      : kind === "rekey" ? `Send new links for ${m!.rows.length} unclaimed payments — the old links stop working`
        : `${usdc(total)} leaves the organization account to ${paying.length} recipients`;
  const recipients = m?.rows.length ?? 0;
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
                  await step.reload();
                })}
              >
                {s!.step === "final" ? "Sign and send" : "Approve"}
              </button>
            </div>
          </>
        )}
        {s?.step === "done" && <Callout tone="ok" testid="done">You have signed. Waiting for the other approvers.</Callout>}
        {s?.step === "closed" && <Callout tone="info" testid="closed">Nothing to sign: the batch is already {s.status === "mined" ? "executed" : s.status === "submitted" ? "submitted on chain" : s.status}.</Callout>}
        <Err e={step.error || a.error} />
      </Section>
    </div>
  );
}
