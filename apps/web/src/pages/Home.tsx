import { useAuth } from "@omniflow/auth-client";
import { call, type Me, type PendingApproval } from "../api";
import { Addr, Badge, chainName, dateTime, Err, Section, usdc, useLoad } from "../ui";

const ROLE: Record<string, string> = { admin: "admin", operator: "operator", approver: "approver" };

export function Home() {
  const auth = useAuth();
  const me = useLoadMe(auth.headers, auth.user?.did);
  const waiting = useLoad(() => call<PendingApproval[]>(auth.headers, "GET", "/me/approvals"), [auth.user?.did]);
  const KIND: Record<string, string> = { pay: "Payout", revoke: "Revoke", rekey: "New links" };
  return (
    <>
      {!!waiting.data?.length && (
        <Section title={`Waiting for your signature (${waiting.data.length})`} desc="Payouts that cannot leave until you approve them." testid="waiting">
          <div className="pending-list">
            {waiting.data.map((w) => (
              <div className="card pending" key={w.batchId} data-testid={`pending-${w.title}`}>
                <div className="grow">
                  <div className="cell-main">{w.title}</div>
                  <div className="hint small">{w.org} · {KIND[w.kind] ?? w.kind} · {w.rows} row{w.rows > 1 ? "s" : ""} · {dateTime(w.createdAt)}</div>
                </div>
                {w.kind !== "rekey" && w.kind !== "revoke" && <span className="amt">{usdc(w.total)}</span>}
                <a className="btn" href={`#/approve/${w.batchId}`}>Review and sign</a>
              </div>
            ))}
          </div>
        </Section>
      )}
      <div className="page-head">
        <div>
          <h1>Organizations</h1>
          <div className="sub">Accounts you pay from or approve payouts for.</div>
        </div>
        <a className="btn" href="#/setup/new" data-testid="new-org">+ New organization</a>
      </div>

      {!!me.data?.setups.length && (
        <Section title="Waiting for you" desc="The account is created once every approver has signed in and signed the approver set." testid="setups">
          <ul className="check-list">
            {me.data.setups.map((s) => (
              <li key={s.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a href={`#/setup/${s.id}`} data-testid={`setup-${s.name}`} className="cell-main">{s.name}</a>
                  <span className="cell-sub hint">
                    {s.joined === false ? "You have not joined yet" : s.joined && s.confirmed === false ? "Waiting for your signature on the approver set" : "Waiting for the others"}
                  </span>
                </div>
                <Badge s={s.status} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {me.data && me.data.orgs.length === 0 && (
        <section className="card empty" data-testid="orgs">
          <h2 style={{ marginBottom: 8 }}>No organizations yet</h2>
          <p className="hint">Create an organization account: name its approvers — only they will be able to send money from it.</p>
        </section>
      )}
      {!!me.data?.orgs.length && (
        <div className="org-list" data-testid="orgs">
          {me.data.orgs.map((o) => (
            <a key={o.id} className="card org-card" href={`#/org/${o.id}`} data-testid={`org-${o.name}`}>
              <div className="name">{o.name}</div>
              <div className="hint small" style={{ marginBottom: 10 }}>{chainName(o.chain_id)}</div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <Addr value={o.account} />
                <span className="row">{o.roles.map((r) => <span key={r} className="chip">{ROLE[r] ?? r}</span>)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
      <Err e={me.error} />
    </>
  );
}

function useLoadMe(headers: () => Promise<Record<string, string>>, did?: string) {
  return useLoad(() => call<Me>(headers, "GET", "/me"), [did]);
}
