import { useState } from "react";
import { useAuth } from "@omniflow/auth-client";
import type { Hex } from "viem";
import { call, type Setup } from "../api";
import { Err, Section, status, useAction, useLoad } from "../ui";

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
    <Section title="Новая организация" testid="setup-new">
      <label>Название <input data-testid="org-name" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <h3>Подтверждающие выплат</h3>
      <p>Только они смогут отправить деньги с аккаунта организации — никто больше, включая Omniflow. Каждый войдёт по своей почте.</p>
      {approvers.map((ap, i) => (
        <div className="row" key={i}>
          <input data-testid={`approver-${i}`} type="email" placeholder="почта подтверждающего" value={ap.email} onChange={(e) => setApprovers(approvers.map((x, j) => (j === i ? { ...x, email: e.target.value.trim() } : x)))} />
          <label>вес <input type="number" min={1} value={ap.weight} style={{ width: 60 }} onChange={(e) => setApprovers(approvers.map((x, j) => (j === i ? { ...x, weight: Math.max(1, Number(e.target.value)) } : x)))} /></label>
          {approvers.length > 1 && <button className="secondary" onClick={() => setApprovers(approvers.filter((_, j) => j !== i))}>×</button>}
        </div>
      ))}
      <button className="secondary" data-testid="add-approver" onClick={() => setApprovers([...approvers, { email: "", weight: 1 }])}>+ подтверждающий</button>
      <p>
        Порог: <input data-testid="threshold" type="number" min={1} max={total} value={threshold} style={{ width: 60 }} onChange={(e) => setThreshold(Number(e.target.value))} /> из {total}
      </p>
      <p className="warn-soft">Если подтверждающие потеряют доступ так, что порог не набрать, деньги на аккаунте останутся недоступны навсегда — восстановления нет.</p>
      <label>Операторы (готовят выплаты, подписывать не могут), через запятую <input value={operators} onChange={(e) => setOperators(e.target.value)} /></label>
      <button
        data-testid="setup-start"
        disabled={a.busy}
        onClick={a.run(async () => {
          const s = await call<Setup>(auth.headers, "POST", "/org-setups", { name, threshold, approvers, operators: operators.split(",").map((x) => x.trim()).filter(Boolean) });
          window.location.hash = `#/setup/${s.id}`;
        })}
      >
        Пригласить подтверждающих
      </button>
      <Err e={a.error} />
    </Section>
  );
}

/** Approvers join (their wallet is recorded), then each confirms the whole set by signing it. */
export function SetupView({ id }: { id: string }) {
  const auth = useAuth();
  const s = useLoad(() => call<Setup>(auth.headers, "GET", `/org-setups/${id}`), [id]);
  const a = useAction();
  const me = s.data?.approvers.find((x) => x.email === auth.user?.email);
  const setup = s.data;
  return (
    <Section title={`Организация «${setup?.name ?? "…"}»`} testid="setup-view">
      {setup && (
        <>
          <p data-testid="setup-status">Статус: {status(setup.status)}{setup.status === "deployed" ? " — аккаунт создан" : ""}</p>
          <table>
            <thead><tr><th>Подтверждающий</th><th>Вес</th><th>Кошелёк</th><th>Состав подтверждён</th></tr></thead>
            <tbody>
              {setup.approvers.map((x) => (
                <tr key={x.email} className={x.email === auth.user?.email ? "mine" : ""}>
                  <td>{x.email}</td><td>{x.weight}</td><td className="mono">{x.wallet ?? "ещё не вошёл"}</td><td>{x.confirmed ? "да" : "нет"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Порог: {setup.threshold} из {setup.approvers.reduce((a, b) => a + b.weight, 0)}.</p>
          {setup.account && <p>Адрес аккаунта организации: <span className="mono" data-testid="setup-account">{setup.account}</span></p>}
          {me && !me.wallet && setup.status === "collecting" && (
            <button data-testid="setup-join" onClick={a.run(async () => s.setData(await call<Setup>(auth.headers, "POST", `/org-setups/${id}/join`)))}>Присоединиться своим кошельком</button>
          )}
          {me && me.wallet && !me.confirmed && setup.status === "confirming" && (
            <>
              <p className="warn-soft" data-testid="confirm-check">
                Проверьте: в составе есть ваш адрес <b className="mono">{auth.user?.wallet}</b>, остальные адреса — ваших коллег, порог верный. Подписывая, вы подтверждаете, что только эти люди смогут отправлять деньги с аккаунта {setup.account}.
              </p>
              <button
                data-testid="setup-confirm"
                onClick={a.run(async () => {
                  const sig = await auth.signTypedData(setup.typedData, `Подтвердить состав организации «${setup.name}» и адрес аккаунта ${setup.account}`);
                  s.setData(await call<Setup>(auth.headers, "POST", `/org-setups/${id}/confirm`, { signature: sig as Hex }));
                })}
              >
                Подписать состав
              </button>
            </>
          )}
          {setup.status === "deployed" && setup.orgId && <a className="button" data-testid="open-org" href={`#/org/${setup.orgId}`}>Открыть организацию</a>}
          <button className="secondary" onClick={() => s.reload()}>Обновить</button>
        </>
      )}
      <Err e={s.error || a.error} />
    </Section>
  );
}
