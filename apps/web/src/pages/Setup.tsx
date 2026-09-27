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
      <a className="back" href="#/">← Организации</a>
      <div className="page-head"><div><h1>Новая организация</h1><div className="sub">Аккаунт в сети, с которого платят только подтверждающие — никто больше, включая Omniflow.</div></div></div>
      <Section testid="setup-new">
        <Field label="Название"><input data-testid="org-name" placeholder="Например, Acme DAO" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <h3>Подтверждающие выплат</h3>
        <p className="hint">Каждый войдёт по своей почте и подпишет состав. Вес — сколько голосов у человека.</p>
        <div className="stack" style={{ marginBottom: 12 }}>
          {approvers.map((ap, i) => (
            <div className="row" key={i}>
              <input className="grow" data-testid={`approver-${i}`} type="email" placeholder="почта подтверждающего" value={ap.email} onChange={(e) => setApprovers(approvers.map((x, j) => (j === i ? { ...x, email: e.target.value.trim() } : x)))} />
              <input className="input-inline" aria-label="вес" type="number" min={1} value={ap.weight} style={{ width: 72 }} onChange={(e) => setApprovers(approvers.map((x, j) => (j === i ? { ...x, weight: Math.max(1, Number(e.target.value)) } : x)))} />
              {approvers.length > 1 && <button className="ghost" aria-label="убрать" onClick={() => setApprovers(approvers.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
        </div>
        <button className="secondary sm" data-testid="add-approver" onClick={() => setApprovers([...approvers, { email: "", weight: 1 }])}>+ Подтверждающий</button>
        <h3>Порог</h3>
        <div className="row" style={{ marginBottom: 14 }}>
          <input className="input-inline" data-testid="threshold" type="number" min={1} max={total} value={threshold} style={{ width: 80 }} onChange={(e) => setThreshold(Number(e.target.value))} />
          <span className="hint">из {total} — столько голосов нужно, чтобы деньги ушли</span>
        </div>
        <Callout tone="warn">Если подтверждающие потеряют доступ так, что порог не набрать, деньги на аккаунте останутся недоступны навсегда — восстановления нет.</Callout>
        <Field label="Операторы" help="Готовят выплаты, но подписывать не могут. Через запятую, можно позже.">
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
            Пригласить подтверждающих
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
      <a className="back" href="#/">← Организации</a>
      <div className="page-head">
        <div><h1>{setup?.name ?? "…"}</h1><div className="sub">Создание аккаунта организации</div></div>
        {setup && <span data-testid="setup-status"><Badge s={setup.status} extra={setup.status === "deployed" ? " — аккаунт создан" : ""} /></span>}
      </div>
      <Section testid="setup-view">
        {setup && (
          <>
            <div className="progress" style={{ marginBottom: 16 }}><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <div className="row hint" style={{ justifyContent: "space-between", marginBottom: 16 }}>
              <span>Вошли: {joined} из {n}</span><span>Подписали состав: {confirmed} из {n}</span><span>Порог: {setup.threshold} из {setup.approvers.reduce((x, y) => x + y.weight, 0)}</span>
            </div>
            <div className="signers">
              {setup.approvers.map((x) => (
                <div key={x.email} className={`signer ${x.email === auth.user?.email ? "mine" : ""}`}>
                  <span className="avatar">{x.email.slice(0, 1).toUpperCase()}</span>
                  <div className="grow">
                    <div className="email">{x.email}{x.email === auth.user?.email ? " (вы)" : ""}</div>
                    <div className="mono small muted">{x.wallet ?? "ещё не вошёл"}</div>
                  </div>
                  <span className="chip">вес {x.weight}</span>
                  {x.confirmed ? <span className="badge ok">подписал</span> : x.wallet ? <span className="badge warn">ждём подпись</span> : <span className="badge">ждём вход</span>}
                </div>
              ))}
            </div>
            {setup.account && (
              <>
                <h3>Адрес аккаунта организации</h3>
                <div className="addr-box" data-testid="setup-account">{setup.account}</div>
              </>
            )}
            {me && !me.wallet && setup.status === "collecting" && (
              <div className="actions"><button data-testid="setup-join" onClick={a.run(async () => s.setData(await call<Setup>(auth.headers, "POST", `/org-setups/${id}/join`)))}>Присоединиться своим кошельком</button></div>
            )}
            {me && me.wallet && !me.confirmed && setup.status === "confirming" && (
              <>
                <div style={{ height: 16 }} />
                <Callout tone="warn" testid="confirm-check">
                  Проверьте: в составе есть ваш адрес <b className="mono">{auth.user?.wallet}</b>, остальные адреса — ваших коллег, порог верный. Подписывая, вы подтверждаете, что только эти люди смогут отправлять деньги с аккаунта.
                </Callout>
                <div className="actions">
                  <button
                    data-testid="setup-confirm"
                    onClick={a.run(async () => {
                      const sig = await auth.signTypedData(setup.typedData, `Подтвердить состав организации «${setup.name}» и адрес аккаунта ${setup.account}`);
                      s.setData(await call<Setup>(auth.headers, "POST", `/org-setups/${id}/confirm`, { signature: sig as Hex }));
                    })}
                  >
                    Подписать состав
                  </button>
                </div>
              </>
            )}
            <div className="actions">
              {setup.status === "deployed" && setup.orgId && <a className="btn" data-testid="open-org" href={`#/org/${setup.orgId}`}>Открыть организацию</a>}
              <button className="secondary" onClick={() => s.reload()}>Обновить</button>
            </div>
          </>
        )}
        <Err e={s.error || a.error} />
      </Section>
    </div>
  );
}
