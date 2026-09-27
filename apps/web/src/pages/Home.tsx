import { useAuth } from "@omniflow/auth-client";
import { call, type Me } from "../api";
import { Err, Section, status, short, useLoad } from "../ui";

const ROLE: Record<string, string> = { admin: "администратор", operator: "оператор", approver: "подтверждающий" };

export function Home() {
  const auth = useAuth();
  const me = useLoad(() => call<Me>(auth.headers, "GET", "/me"), [auth.user?.did]);
  return (
    <>
      <Section title="Мои организации" testid="orgs">
        {me.data?.orgs.length === 0 && <p>Пока нет ни одной.</p>}
        <ul>
          {me.data?.orgs.map((o) => (
            <li key={o.id}>
              <a href={`#/org/${o.id}`} data-testid={`org-${o.name}`}>{o.name}</a> — аккаунт {short(o.account)} · {o.roles.map((r) => ROLE[r] ?? r).join(", ")}
            </li>
          ))}
        </ul>
        <a className="button" href="#/setup/new" data-testid="new-org">Создать организацию</a>
      </Section>
      {!!me.data?.setups.length && (
        <Section title="Ждут вашего участия" testid="setups">
          <ul>
            {me.data.setups.map((s) => (
              <li key={s.id}>
                <a href={`#/setup/${s.id}`} data-testid={`setup-${s.name}`}>{s.name}</a> — {status(s.status)}
                {s.joined === false && " · вы ещё не присоединились"}
                {s.joined && s.confirmed === false && " · ждёт вашего подтверждения состава"}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Err e={me.error} />
    </>
  );
}
