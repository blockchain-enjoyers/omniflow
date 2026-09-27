import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useAuth } from "@omniflow/auth-client";
import { call, type Org, type PayoutListItem } from "../api";
import { chainName, Err, Section, short, status, usdc, useAction, useLoad } from "../ui";

const TABS: [string, string][] = [
  ["payouts", "Выплаты"], ["book", "Адресная книга"], ["schedules", "Регулярные"], ["topup", "Пополнить"],
  ["reports", "Отчёты"], ["members", "Участники"], ["settings", "Настройки"], ["audit", "Журнал"],
];

export function OrgPage({ id, tab }: { id: string; tab: string }) {
  const auth = useAuth();
  const org = useLoad(() => call<Org>(auth.headers, "GET", `/orgs/${id}`), [id]);
  const bal = useLoad(() => call<{ balance: string; reservedInEscrow: string; account: string }>(auth.headers, "GET", `/orgs/${id}/balance`), [id]);
  const o = org.data;
  return (
    <>
      <h1 data-testid="org-title">{o?.name ?? "…"}</h1>
      {o && (
        <p>
          Аккаунт <span className="mono">{o.account}</span> · порог {o.threshold} из {o.approvers.reduce((a, b) => a + b.weight, 0)}
          {bal.data && <> · баланс <b data-testid="balance">{usdc(bal.data.balance)}</b>{BigInt(bal.data.reservedInEscrow) > 0n && <> · из них по ссылкам, не получено: {usdc(bal.data.reservedInEscrow)} (это ваши деньги)</>}</>}
        </p>
      )}
      <nav>
        {TABS.map(([k, label]) => (
          <a key={k} className={`tab ${tab === k ? "active" : ""}`} href={`#/org/${id}/${k}`} data-testid={`tab-${k}`}>{label}</a>
        ))}
      </nav>
      {o && tab === "payouts" && <Payouts org={o} />}
      {o && tab === "book" && <Book org={o} />}
      {o && tab === "schedules" && <Schedules org={o} />}
      {o && tab === "topup" && <TopUp org={o} onDone={bal.reload} />}
      {o && tab === "reports" && <Reports org={o} />}
      {o && tab === "members" && <Members org={o} />}
      {o && tab === "settings" && <Settings org={o} onSaved={org.reload} />}
      {o && tab === "audit" && <Audit org={o} />}
      <Err e={org.error} />
    </>
  );
}

function Payouts({ org }: { org: Org }) {
  const auth = useAuth();
  const list = useLoad(() => call<PayoutListItem[]>(auth.headers, "GET", `/orgs/${org.id}/payouts`), [org.id]);
  const [title, setTitle] = useState("");
  const [csv, setCsv] = useState(`name,email,address,chain_id,amount,category\n`);
  const [override, setOverride] = useState("");
  const a = useAction();
  const isOp = org.myRoles.includes("operator");
  return (
    <>
      {isOp && (
        <Section title="Новая выплата из CSV" testid="new-payout">
          <p className="hint">Колонки: name,email,address,chain_id,amount[,category]. Адреса или почты может не быть — строка подождёт реквизитов. Сеть выплаты — {chainName(org.chain_id)}, в колонке chain_id — {org.chain_id}.</p>
          <input data-testid="payout-title" placeholder="Название" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea data-testid="payout-csv" value={csv} onChange={(e) => setCsv(e.target.value)} />
          <label>Автовозврат неполученного через, дней (пусто — как в настройках: {org.auto_refund_days ?? "бессрочно"}) <input value={override} style={{ width: 80 }} onChange={(e) => setOverride(e.target.value)} /></label>
          <button
            data-testid="payout-create"
            disabled={a.busy}
            onClick={a.run(async () => {
              const p = await call<{ id: string }>(auth.headers, "POST", `/orgs/${org.id}/payouts`, { title, csv, ...(override ? { autoRefundDays: Number(override) } : {}) });
              window.location.hash = `#/payout/${p.id}`;
            })}
          >
            Загрузить и проверить
          </button>
          <Err e={a.error} />
        </Section>
      )}
      <Section title="Выплаты" testid="payouts">
        <table>
          <thead><tr><th>Название</th><th>Строк</th><th>Сумма</th><th>Статус</th><th>Создана</th></tr></thead>
          <tbody>
            {list.data?.map((p) => (
              <tr key={p.id}><td><a href={`#/payout/${p.id}`}>{p.title}</a></td><td>{p.rows}</td><td>{usdc(p.total)}</td><td>{status(p.status)}</td><td>{new Date(p.created_at).toLocaleDateString("ru-RU")}</td></tr>
            ))}
          </tbody>
        </table>
        <Err e={list.error} />
      </Section>
    </>
  );
}

interface BookEntry { id: string; name: string; email: string | null; address: string | null; chainId: number; category: string | null; lastAmount: string | null }

function Book({ org }: { org: Org }) {
  const auth = useAuth();
  const book = useLoad(() => call<BookEntry[]>(auth.headers, "GET", `/orgs/${org.id}/address-book`), [org.id]);
  const [form, setForm] = useState({ name: "", email: "", address: "", category: "" });
  const [pick, setPick] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const a = useAction();
  const isOp = org.myRoles.includes("operator");
  return (
    <Section title="Адресная книга" testid="book">
      <p className="hint">Пополняется сама из оплаченных строк. Изменение адреса здесь не меняет уже отправленного.</p>
      <table>
        <thead><tr>{isOp && <th>Сумма</th>}<th>Имя</th><th>Адрес / почта</th><th>Категория</th><th>Прошлая сумма</th>{isOp && <th />}</tr></thead>
        <tbody>
          {book.data?.map((e) => (
            <tr key={e.id}>
              {isOp && <td><input data-testid={`pick-${e.name}`} style={{ width: 90 }} placeholder="—" value={pick[e.id] ?? ""} onChange={(x) => setPick({ ...pick, [e.id]: x.target.value })} /></td>}
              <td>{e.name}</td><td className="mono">{e.address ?? e.email}</td><td>{e.category}</td><td>{e.lastAmount ? usdc(e.lastAmount) : ""}</td>
              {isOp && <td><button className="secondary" onClick={a.run(async () => { await call(auth.headers, "DELETE", `/orgs/${org.id}/address-book/${e.id}`); await book.reload(); })}>удалить</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {isOp && (
        <>
          <p>
            <input data-testid="book-payout-title" placeholder="Название выплаты" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button
              data-testid="book-payout"
              onClick={a.run(async () => {
                const items = Object.entries(pick).filter(([, v]) => v).map(([id, amount]) => ({ id, amount }));
                const p = await call<{ id: string }>(auth.headers, "POST", `/orgs/${org.id}/payouts/from-book`, { title, items });
                window.location.hash = `#/payout/${p.id}`;
              })}
            >
              Выплата выбранным
            </button>
          </p>
          <h3>Добавить</h3>
          <div className="row">
            <input placeholder="имя" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input placeholder="адрес 0x…" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value.trim() })} />
            <input placeholder="или почта" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value.trim() })} />
            <input placeholder="категория" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <button onClick={a.run(async () => { await call(auth.headers, "POST", `/orgs/${org.id}/address-book`, { ...form, chainId: org.chain_id, address: form.address || null, email: form.email || null }); setForm({ name: "", email: "", address: "", category: "" }); await book.reload(); })}>Сохранить</button>
          </div>
        </>
      )}
      <Err e={book.error || a.error} />
    </Section>
  );
}

function Schedules({ org }: { org: Org }) {
  const auth = useAuth();
  const list = useLoad(() => call<{ id: string; title: string; every: string; nextRunAt: string; active: boolean; templatePayoutId: string }[]>(auth.headers, "GET", `/orgs/${org.id}/schedules`), [org.id]);
  const a = useAction();
  return (
    <Section title="Регулярные выплаты" testid="schedules">
      <p className="hint">Расписание создаёт черновик по образцу прошлой выплаты и пишет операторам. Без проверки и подтверждения ничего не уходит. Создать — на странице выплаты-образца.</p>
      <table>
        <thead><tr><th>Название</th><th>Период</th><th>Следующий черновик</th><th>Активно</th></tr></thead>
        <tbody>
          {list.data?.map((s) => (
            <tr key={s.id}>
              <td>{s.title} (<a href={`#/payout/${s.templatePayoutId}`}>образец</a>)</td>
              <td>{s.every === "month" ? "раз в месяц" : "раз в неделю"}</td>
              <td>{new Date(s.nextRunAt).toLocaleString("ru-RU")}</td>
              <td>
                {org.myRoles.includes("operator") ? (
                  <button className="secondary" onClick={a.run(async () => { await call(auth.headers, "PATCH", `/orgs/${org.id}/schedules/${s.id}`, { active: !s.active }); await list.reload(); })}>{s.active ? "приостановить" : "возобновить"}</button>
                ) : s.active ? "да" : "нет"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Err e={list.error || a.error} />
    </Section>
  );
}

/** The account address as a QR code — the plain address, the same string as above (no payment URI). */
function AddressQr({ address }: { address: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(address, { margin: 1, width: 180 }).then(setSrc, () => setSrc(""));
  }, [address]);
  return src ? <img src={src} alt={`QR: ${address}`} width={180} height={180} data-testid="topup-qr" /> : null;
}

function TopUp({ org, onDone }: { org: Org; onDone: () => void }) {
  const auth = useAuth();
  const [amount, setAmount] = useState("1000");
  const [session, setSession] = useState<{ url: string; destination: string; provider: string } | null>(null);
  const a = useAction();
  const canBuy = org.myRoles.includes("admin") || org.myRoles.includes("approver");
  return (
    <>
      <Section title="Пополнить из Safe или с кошелька" testid="topup">
        <p>Отправьте USDC в сети <b>{chainName(org.chain_id)}</b> на адрес аккаунта организации:</p>
        <p className="mono big" data-testid="topup-address">{org.account}</p>
        <AddressQr address={org.account} />
        <ul className="hint">
          <li>В Safe: «New transaction» → «Send tokens» → USDC → этот адрес. Подписывают подписанты Safe, как обычно.</li>
          <li>Сверьте адрес с тем, что подтверждали подтверждающие при создании. Первый раз — пробный перевод на небольшую сумму.</li>
          <li>Только {chainName(org.chain_id)}. USDC из другой сети на этот адрес не дойдёт.</li>
          <li>Газ за выплаты платит Omniflow — ETH на аккаунте не нужен.</li>
        </ul>
      </Section>
      {canBuy && (
        <Section title="Купить USDC за деньги" testid="onramp">
          <p className="hint">Покупка у партнёра, KYC у партнёра. Деньги приходят на аккаунт организации.</p>
          <input data-testid="onramp-amount" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 120 }} /> USD{" "}
          <button data-testid="onramp-start" onClick={a.run(async () => setSession(await call(auth.headers, "POST", `/orgs/${org.id}/onramp`, { fiatAmount: Number(amount), returnUrl: window.location.href })))}>Купить</button>
          {session && (
            <p>
              {session.provider}: адрес назначения <span className="mono">{short(session.destination)}</span> — {session.destination === org.account ? "совпадает с аккаунтом организации" : "НЕ СОВПАДАЕТ — не платите"}.{" "}
              <a data-testid="onramp-open" href={session.url} target="_blank" rel="noreferrer">Открыть окно оплаты</a> · <button className="secondary" onClick={onDone}>обновить баланс</button>
            </p>
          )}
          <Err e={a.error} />
        </Section>
      )}
    </>
  );
}

function Reports({ org }: { org: Org }) {
  const auth = useAuth();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const q = `${from ? `from=${from}&` : ""}${to ? `to=${to}&` : ""}`;
  const lines = useLoad(() => call<{ date: string; payout: string; recipient: string; amount: string; usdValue: string; category: string | null; status: string; txHash: string | null; priceSource: string }[]>(auth.headers, "GET", `/orgs/${org.id}/reports/payments?${q}`), [org.id, q]);
  const a = useAction();
  return (
    <Section title="Отчёт по выплатам" testid="reports">
      <p>С <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /> по <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />{" "}
        <button
          data-testid="csv"
          onClick={a.run(async () => {
            const text = await call<string>(auth.headers, "GET", `/orgs/${org.id}/reports/payments?${q}format=csv`);
            const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = `omniflow-${org.name}-payments.csv`;
            link.click();
            URL.revokeObjectURL(url);
          })}
        >
          Выгрузить CSV
        </button>
      </p>
      {lines.data?.[0] && <p className="hint">Стоимость в USD: {lines.data[0].priceSource}.</p>}
      <table data-testid="report-table">
        <thead><tr><th>Дата</th><th>Выплата</th><th>Получатель</th><th>Сумма</th><th>USD</th><th>Категория</th><th>Статус</th><th>Хеш</th></tr></thead>
        <tbody>
          {lines.data?.map((l, i) => (
            <tr key={i}><td>{new Date(l.date).toLocaleString("ru-RU")}</td><td>{l.payout}</td><td>{l.recipient}</td><td>{l.amount}</td><td>{l.usdValue}</td><td>{l.category}</td><td>{l.status}</td><td className="mono">{short(l.txHash)}</td></tr>
          ))}
        </tbody>
      </table>
      <Err e={lines.error || a.error} />
    </Section>
  );
}

function Members({ org }: { org: Org }) {
  const auth = useAuth();
  const list = useLoad(() => call<{ email: string; roles: string[]; status: string; joined: boolean }[]>(auth.headers, "GET", `/orgs/${org.id}/members`), [org.id]);
  const [email, setEmail] = useState("");
  const a = useAction();
  const isAdmin = org.myRoles.includes("admin");
  return (
    <Section title="Участники" testid="members">
      <table>
        <thead><tr><th>Почта</th><th>Роли</th><th>Статус</th>{isAdmin && <th />}</tr></thead>
        <tbody>
          {list.data?.map((m) => (
            <tr key={m.email}>
              <td>{m.email}</td><td>{m.roles.join(", ")}</td><td>{m.status === "active" ? "вошёл" : "приглашён"}</td>
              {isAdmin && <td>{m.roles.includes("operator") && <button className="secondary" onClick={a.run(async () => { await call(auth.headers, "DELETE", `/orgs/${org.id}/members/${encodeURIComponent(m.email)}`); await list.reload(); })}>убрать оператора</button>}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Состав подтверждающих записан в контракте аккаунта. Сменить его может только операция, подтверждённая порогом.</p>
      {isAdmin && (
        <p>
          <input data-testid="invite-email" placeholder="почта оператора" value={email} onChange={(e) => setEmail(e.target.value.trim())} />
          <button data-testid="invite" onClick={a.run(async () => { await call(auth.headers, "POST", `/orgs/${org.id}/members`, { email }); setEmail(""); await list.reload(); })}>Пригласить оператора</button>
        </p>
      )}
      <Err e={list.error || a.error} />
    </Section>
  );
}

function Settings({ org, onSaved }: { org: Org; onSaved: () => void }) {
  const auth = useAuth();
  const [days, setDays] = useState(org.auto_refund_days ? String(org.auto_refund_days) : "");
  const a = useAction();
  const isAdmin = org.myRoles.includes("admin");
  return (
    <Section title="Настройки" testid="settings">
      <label>
        Автовозврат неполученных платежей через, дней (пусто — бессрочно):{" "}
        <input data-testid="autorefund" disabled={!isAdmin} value={days} style={{ width: 80 }} onChange={(e) => setDays(e.target.value)} />
      </label>
      <p className="hint">Значение по умолчанию для новых выплат; в каждой выплате его можно изменить. По истечении срока деньги возвращаются на аккаунт организации.</p>
      {isAdmin && <button data-testid="settings-save" onClick={a.run(async () => { await call(auth.headers, "PATCH", `/orgs/${org.id}/settings`, { autoRefundDays: days ? Number(days) : null }); onSaved(); })}>Сохранить</button>}
      <Err e={a.error} />
    </Section>
  );
}

function Audit({ org }: { org: Org }) {
  const auth = useAuth();
  const log = useLoad(() => call<{ at: string; action: string; actor: string | null; details: unknown }[]>(auth.headers, "GET", `/orgs/${org.id}/audit`), [org.id]);
  return (
    <Section title="Журнал действий" testid="audit">
      <table>
        <thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Детали</th></tr></thead>
        <tbody>
          {log.data?.map((l, i) => (
            <tr key={i}><td>{new Date(l.at).toLocaleString("ru-RU")}</td><td>{l.actor}</td><td>{l.action}</td><td className="mono small">{l.details ? JSON.stringify(l.details) : ""}</td></tr>
          ))}
        </tbody>
      </table>
      <Err e={log.error} />
    </Section>
  );
}
