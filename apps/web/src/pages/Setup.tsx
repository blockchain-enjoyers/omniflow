import { useState } from "react";
import { useAuth } from "@omniflow/auth-client";
import type { Hex } from "viem";
import { call, type Setup } from "../api";
import { Badge, Callout, Err, Field, Section, useAction, useLoad } from "../ui";

/** Flow 1: name approvers by email, set the threshold. */
export function SetupNew() {
  const auth = useAuth();
  const [name, setName] = useState("");
  const [approvers, setApprovers] = useState([{ email: "", weight: 1 }]);
  const [threshold, setThreshold] = useState(1);
  const [operators, setOperators] = useState("");
  const a = useAction();
  const total = approvers.reduce((s, x) => s + x.weight, 0);
  return (
    <div className="narrow">
      <a className="back" href="#/">← Organizations</a>
      <div className="page-head"><div><h1>New organization</h1><div className="sub">An on-chain account that only its approvers can pay from — nobody else, Omniflow included.</div></div></div>
      <Section testid="setup-new">
        <Field label="Name"><input data-testid="org-name" placeholder="e.g. Acme DAO" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <h3>Payout approvers</h3>
        <p className="hint">Each signs in with their own email and signs the approver set. Weight is how many votes a person has.</p>
        <div className="stack" style={{ marginBottom: 12 }}>
          {approvers.map((ap, i) => (
            <div className="row" key={i}>
              <input className="grow" data-testid={`approver-${i}`} type="email" placeholder="approver email" value={ap.email} onChange={(e) => setApprovers(approvers.map((x, j) => (j === i ? { ...x, email: e.target.value.trim() } : x)))} />
              <input className="input-inline" aria-label="weight" type="number" min={1} value={ap.weight} style={{ width: 72 }} onChange={(e) => setApprovers(approvers.map((x, j) => (j === i ? { ...x, weight: Math.max(1, Number(e.target.value)) } : x)))} />
              {approvers.length > 1 && <button className="ghost" aria-label="remove" onClick={() => setApprovers(approvers.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
        </div>
        <button className="secondary sm" data-testid="add-approver" onClick={() => setApprovers([...approvers, { email: "", weight: 1 }])}>+ Approver</button>
        <h3>Threshold</h3>
        <div className="row" style={{ marginBottom: 14 }}>
          <input className="input-inline" data-testid="threshold" type="number" min={1} max={total} value={threshold} style={{ width: 80 }} onChange={(e) => setThreshold(Number(e.target.value))} />
          <span className="hint">of {total} — votes needed for money to leave</span>
        </div>
        <Callout tone="warn">If approvers lose access so that the threshold can no longer be reached, the money on the account is locked forever — there is no recovery.</Callout>
        <Field label="Operators" help="Prepare payouts but cannot sign. Comma-separated; can be added later.">
          <input value={operators} placeholder="ops@company.com" onChange={(e) => setOperators(e.target.value)} />
        </Field>
        <div className="actions">
          <button
            data-testid="setup-start"
            disabled={a.busy || !name}
            onClick={a.run(async () => {
              const s = await call<Setup>(auth.headers, "POST", "/org-setups", { name, threshold, approvers, operators: operators.split(",").map((x) => x.trim()).filter(Boolean) });
              window.location.hash = `#/setup/${s.id}`;
            })}
          >
            Invite approvers
          </button>
        </div>
        <Err e={a.error} />
      </Section>
    </div>
  );
}

/** Approvers join (their wallet is recorded), then each confirms the whole set by signing it. */
export function SetupView({ id }: { id: string }) {
  const auth = useAuth();
  const s = useLoad(() => call<Setup>(auth.headers, "GET", `/org-setups/${id}`), [id]);
  const a = useAction();
  const me = s.data?.approvers.find((x) => x.email === auth.user?.email);
  const setup = s.data;
  const joined = setup?.approvers.filter((x) => x.wallet).length ?? 0;
  const confirmed = setup?.approvers.filter((x) => x.confirmed).length ?? 0;
  const n = setup?.approvers.length ?? 1;
  const progress = setup?.status === "deployed" ? 1 : (joined + confirmed) / (2 * n);
  return (
    <div className="narrow">
      <a className="back" href="#/">← Organizations</a>
      <div className="page-head">
        <div><h1>{setup?.name ?? "…"}</h1><div className="sub">Creating the organization account</div></div>
        {setup && <span data-testid="setup-status"><Badge s={setup.status} extra={setup.status === "deployed" ? " — account created" : ""} /></span>}
      </div>
      <Section testid="setup-view">
        {setup && (
          <>
            <div className="progress" style={{ marginBottom: 16 }}><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <div className="row hint" style={{ justifyContent: "space-between", marginBottom: 16 }}>
              <span>Signed in: {joined} of {n}</span><span>Signed the set: {confirmed} of {n}</span><span>Threshold: {setup.threshold} of {setup.approvers.reduce((x, y) => x + y.weight, 0)}</span>
            </div>
            <div className="signers">
              {setup.approvers.map((x) => (
                <div key={x.email} className={`signer ${x.email === auth.user?.email ? "mine" : ""}`}>
                  <span className="avatar">{x.email.slice(0, 1).toUpperCase()}</span>
                  <div className="grow">
                    <div className="email">{x.email}{x.email === auth.user?.email ? " (you)" : ""}</div>
                    <div className="mono small muted">{x.wallet ?? "not signed in yet"}</div>
                  </div>
                  <span className="chip">weight {x.weight}</span>
                  {x.confirmed ? <span className="badge ok">signed</span> : x.wallet ? <span className="badge warn">awaiting signature</span> : <span className="badge">awaiting sign-in</span>}
                </div>
              ))}
            </div>
            {setup.account && (
              <>
                <h3>Organization account address</h3>
                <div className="addr-box" data-testid="setup-account">{setup.account}</div>
              </>
            )}
            {me && !me.wallet && setup.status === "collecting" && (
              <div className="actions"><button data-testid="setup-join" onClick={a.run(async () => s.setData(await call<Setup>(auth.headers, "POST", `/org-setups/${id}/join`)))}>Join with my wallet</button></div>
            )}
            {me && me.wallet && !me.confirmed && setup.status === "confirming" && (
              <>
                <div style={{ height: 16 }} />
                <Callout tone="warn" testid="confirm-check">
                  Check: the set contains your address <b className="mono">{auth.user?.wallet}</b>, the other addresses belong to your colleagues, and the threshold is right. By signing you confirm that only these people will be able to send money from the account.
                </Callout>
                <div className="actions">
                  <button
                    data-testid="setup-confirm"
                    onClick={a.run(async () => {
                      const sig = await auth.signTypedData(setup.typedData, `Confirm the approver set of "${setup.name}" and the account address ${setup.account}`);
                      s.setData(await call<Setup>(auth.headers, "POST", `/org-setups/${id}/confirm`, { signature: sig as Hex }));
                    })}
                  >
                    Sign the approver set
                  </button>
                </div>
              </>
            )}
            <div className="actions">
              {setup.status === "deployed" && setup.orgId && <a className="btn" data-testid="open-org" href={`#/org/${setup.orgId}`}>Open organization</a>}
              <button className="secondary" onClick={() => s.reload()}>Refresh</button>
            </div>
          </>
        )}
        <Err e={s.error || a.error} />
      </Section>
    </div>
  );
}
