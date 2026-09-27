import { useAuth } from "@omniflow/auth-client";
import { call, type Me } from "../api";
import { Addr, Badge, chainName, Err, Section, useLoad } from "../ui";

const ROLE: Record<string, string> = { admin: "администратор", operator: "оператор", approver: "подтверждающий" };

export function Home() {
  const auth = useAuth();
  const me = useLoadMe(auth.headers, auth.user?.did);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Организации</h1>
          <div className="sub">Аккаунты, с которых вы платите или подтверждаете выплаты.</div>
        </div>
        <a className="btn" href="#/setup/new" data-testid="new-org">+ Создать организацию</a>
      </div>

      {!!me.data?.setups.length && (
        <Section title="Ждут вашего участия" desc="Аккаунт появится, когда все подтверждающие войдут и подпишут состав." testid="setups">
          <ul className="check-list">
            {me.data.setups.map((s) => (
              <li key={s.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a href={`#/setup/${s.id}`} data-testid={`setup-${s.name}`} className="cell-main">{s.name}</a>
                  <span className="cell-sub hint">
                    {s.joined === false ? "Вы ещё не присоединились" : s.joined && s.confirmed === false ? "Ждёт вашей подписи состава" : "Ждём остальных"}
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
          <h2 style={{ marginBottom: 8 }}>Пока нет ни одной организации</h2>
          <p className="hint">Создайте аккаунт организации: назначьте подтверждающих, и только они смогут отправлять с него деньги.</p>
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
