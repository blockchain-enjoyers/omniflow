import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useAuth } from "@omniflow/auth-client";
import { call, type Org, type PayoutListItem } from "../api";
import { Addr, Badge, Callout, chainName, date, dateTime, Err, Field, Section, Stat, Table, usdc, useAction, useLoad } from "../ui";

const TABS: [string, string][] = [
  ["payouts", "Выплаты"], ["book", "Адресная книга"], ["schedules", "Регулярные"], ["topup", "Пополнить"],
  ["reports", "Отчёты"], ["members", "Участники"], ["settings", "Настройки"], ["audit", "Журнал"],
];
const ROLE: Record<string, string> = { admin: "администратор", operator: "оператор", approver: "подтверждающий" };

export function OrgPage({ id, tab }: { id: string; tab: string }) {
  const auth = useAuth();
  const org = useLoad(() => call<Org>(auth.headers, "GET", `/orgs/${id}`), [id]);
  const bal = useLoad(() => call<{ balance: string; reservedInEscrow: string; account: string }>(auth.headers, "GET", `/orgs/${id}/balance`), [id]);
  const o = org.data;
  const weight = o?.approvers.reduce((a, b) => a + b.weight, 0) ?? 0;
  return (
    <>
      <a className="back" href="#/">← Организации</a>
      <div className="org-head">
        <h1 data-testid="org-title">{o?.name ?? "…"}</h1>
        {o && (
          <div className="meta">
            <span className="chip">{chainName(o.chain_id)}</span>
            <Addr value={o.account} />
            <span className="row">{o.myRoles.map((r) => <span key={r} className="chip">{ROLE[r] ?? r}</span>)}</span>
          </div>
        )}
      </div>
      {o && (
        <div className="grid grid-3 stats">
          <Stat label="Баланс аккаунта" value={bal.data ? usdc(bal.data.balance) : "…"} testid="balance" foot="Газ платит Omniflow — ETH не нужен" />
          <Stat label="По ссылкам, ещё не получено" sm value={bal.data ? usdc(bal.data.reservedInEscrow) : "…"} foot="Это всё ещё ваши деньги: их можно отозвать" />
          <Stat label="Подтверждение" sm value={`${o.threshold} из ${weight}`} foot={`${o.approvers.length} подтверждающих, записаны в контракте`} />
        </div>
      )}
      <nav className="tabs">
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
  const [open, setOpen] = useState(false);
  const a = useAction();
  const isOp = org.myRoles.includes("operator");
  return (
    <>
      <Section flush title="Выплаты" testid="payouts" actions={isOp && <button className={open ? "secondary" : ""} data-testid="new-payout-toggle" onClick={() => setOpen(!open)}>{open ? "Скрыть" : "+ Новая выплата"}</button>}>
        <Table
          cols={[{ label: "Название", primary: true }, { label: "Строк", className: "r" }, { label: "Сумма", className: "r" }, { label: "Статус" }, { label: "Создана" }]}
          rows={(list.data ?? []).map((p) => ({ key: p.id, cells: [<a href={`#/payout/${p.id}`} className="cell-main">{p.title}</a>, <span className="num">{p.rows}</span>, <span className="num">{usdc(p.total)}</span>, <Badge s={p.status} />, date(p.created_at)] }))}
          empty="Выплат пока нет."
        />
        <div style={{ padding: "0 20px" }}><Err e={list.error} /></div>
      </Section>
      {isOp && open && (
        <Section title="Новая выплата из CSV" desc={<>Колонки: <code>name,email,address,chain_id,amount[,category]</code>. Без адреса и почты строка подождёт реквизитов. Сеть — {chainName(org.chain_id)}, <code>chain_id</code> = {org.chain_id}.</>} testid="new-payout">
          <Field label="Название"><input data-testid="payout-title" placeholder="Например, гранты за сентябрь" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Строки CSV"><textarea data-testid="payout-csv" value={csv} onChange={(e) => setCsv(e.target.value)} /></Field>
          <Field label="Автовозврат неполученного, дней" help={`Пусто — как в настройках: ${org.auto_refund_days ?? "бессрочно"}.`}>
            <input className="w-amount" inputMode="numeric" value={override} onChange={(e) => setOverride(e.target.value)} />
          </Field>
          <div className="actions">
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
          </div>
          <Err e={a.error} />
        </Section>
      )}
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
  const picked = Object.values(pick).filter(Boolean).length;
  return (
    <>
      <Section flush title="Адресная книга" desc="Пополняется сама из оплаченных строк. Изменение здесь не меняет уже отправленного." testid="book">
        <Table
          cols={[{ label: "Имя", primary: true }, { label: "Адрес / почта" }, { label: "Категория" }, { label: "Прошлая сумма", className: "r" }, ...(isOp ? [{ label: "Сумма сейчас" }, { label: "" }] : [])]}
          rows={(book.data ?? []).map((e) => ({
            key: e.id,
            cells: [
              <span className="cell-main">{e.name}</span>,
              e.address ? <Addr value={e.address} /> : <span className="small">{e.email}</span>,
              e.category ? <span className="chip">{e.category}</span> : <span className="muted">—</span>,
              <span className="num">{e.lastAmount ? usdc(e.lastAmount) : "—"}</span>,
              ...(isOp
                ? [
                    <input data-testid={`pick-${e.name}`} className="w-amount" inputMode="decimal" placeholder="USDC" value={pick[e.id] ?? ""} onChange={(x) => setPick({ ...pick, [e.id]: x.target.value })} />,
                    <button className="ghost sm" data-testid={`book-delete-${e.name}`} onClick={a.run(async () => { await call(auth.headers, "DELETE", `/orgs/${org.id}/address-book/${e.id}`); await book.reload(); })}>Удалить</button>,
                  ]
                : []),
            ],
          }))}
          empty="Книга пуста — получатели появятся после первой выплаты."
        />
        {isOp && (
          <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
            <div className="row">
              <input className="grow" data-testid="book-payout-title" placeholder="Название выплаты" value={title} onChange={(e) => setTitle(e.target.value)} />
              <button
                data-testid="book-payout"
                disabled={!picked || !title}
                onClick={a.run(async () => {
                  const items = Object.entries(pick).filter(([, v]) => v).map(([id, amount]) => ({ id, amount }));
                  const p = await call<{ id: string }>(auth.headers, "POST", `/orgs/${org.id}/payouts/from-book`, { title, items });
                  window.location.hash = `#/payout/${p.id}`;
                })}
              >
                Выплата выбранным{picked ? ` (${picked})` : ""}
              </button>
            </div>
          </div>
        )}
      </Section>
      {isOp && (
        <Section title="Добавить получателя">
          <div className="grid grid-2">
            <Field label="Имя"><input data-testid="book-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Категория"><input data-testid="book-category" placeholder="гранты, подрядчики…" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
            <Field label="Адрес кошелька"><input className="mono" data-testid="book-address" placeholder="0x…" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value.trim() })} /></Field>
            <Field label="или почта"><input data-testid="book-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value.trim() })} /></Field>
          </div>
          <div className="actions" style={{ marginTop: 0 }}>
            <button data-testid="book-save" disabled={!form.name || (!form.address && !form.email)} onClick={a.run(async () => { await call(auth.headers, "POST", `/orgs/${org.id}/address-book`, { ...form, chainId: org.chain_id, address: form.address || null, email: form.email || null }); setForm({ name: "", email: "", address: "", category: "" }); await book.reload(); })}>Сохранить</button>
          </div>
        </Section>
      )}
      <Err e={book.error || a.error} />
    </>
  );
}

function Schedules({ org }: { org: Org }) {
  const auth = useAuth();
  const list = useLoad(() => call<{ id: string; title: string; every: string; nextRunAt: string; active: boolean; templatePayoutId: string }[]>(auth.headers, "GET", `/orgs/${org.id}/schedules`), [org.id]);
  const a = useAction();
  const isOp = org.myRoles.includes("operator");
  return (
    <Section flush title="Регулярные выплаты" desc="Расписание создаёт черновик по образцу и пишет операторам. Без проверки и подтверждения ничего не уходит. Создать — на странице выплаты-образца." testid="schedules">
      <Table
        cols={[{ label: "Название", primary: true }, { label: "Период" }, { label: "Следующий черновик" }, { label: "Статус" }, { label: "" }]}
        rows={(list.data ?? []).map((s) => ({
          key: s.id,
          cells: [
            <span><span className="cell-main">{s.title}</span> <a className="small" href={`#/payout/${s.templatePayoutId}`}>образец</a></span>,
            s.every === "month" ? "раз в месяц" : "раз в неделю",
            dateTime(s.nextRunAt),
            <span className={`badge ${s.active ? "ok" : ""}`} data-testid={`schedule-state-${s.title}`}>{s.active ? "активно" : "на паузе"}</span>,
            isOp ? <button className="secondary sm" data-testid={`schedule-toggle-${s.title}`} onClick={a.run(async () => { await call(auth.headers, "PATCH", `/orgs/${org.id}/schedules/${s.id}`, { active: !s.active }); await list.reload(); })}>{s.active ? "Приостановить" : "Возобновить"}</button> : null,
          ],
        }))}
        empty="Регулярных выплат нет."
      />
      <div style={{ padding: "0 20px" }}><Err e={list.error || a.error} /></div>
    </Section>
  );
}

/** The account address as a QR code — the plain address, the same string as above (no payment URI). */
function AddressQr({ address }: { address: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(address, { margin: 1, width: 360 }).then(setSrc, () => setSrc(""));
  }, [address]);
  return src ? <img className="qr" src={src} alt={`QR: ${address}`} data-testid="topup-qr" /> : null;
}

function TopUp({ org, onDone }: { org: Org; onDone: () => void }) {
  const auth = useAuth();
  const [amount, setAmount] = useState("1000");
  const [session, setSession] = useState<{ url: string; destination: string; provider: string } | null>(null);
  const a = useAction();
  const canBuy = org.myRoles.includes("admin") || org.myRoles.includes("approver");
  return (
    <div className={canBuy ? "grid grid-2" : ""}>
      <Section title="Перевести USDC" desc="Из Safe, с биржи или со своего кошелька" testid="topup">
        <div className="topup-grid">
          <div>
            <p className="hint" style={{ marginBottom: 6 }}>Адрес аккаунта организации, сеть <b>{chainName(org.chain_id)}</b></p>
            <div className="addr-box" data-testid="topup-address">{org.account}</div>
          </div>
          <AddressQr address={org.account} />
        </div>
        <ul className="hint" style={{ marginTop: 14 }}>
          <li>В Safe: New transaction → Send tokens → USDC → этот адрес.</li>
          <li>Сверьте адрес с тем, что подписывали подтверждающие. Первый раз — пробный перевод.</li>
        </ul>
        <Callout tone="warn">Только {chainName(org.chain_id)}. USDC из другой сети на этот адрес не дойдёт.</Callout>
      </Section>
      {canBuy && (
        <Section title="Купить USDC за деньги" desc="Покупка и KYC — у партнёра. Деньги приходят на аккаунт организации." testid="onramp">
          <Field label="Сумма, USD">
            <input data-testid="onramp-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <div className="actions" style={{ marginTop: 0 }}>
            <button data-testid="onramp-start" onClick={a.run(async () => setSession(await call(auth.headers, "POST", `/orgs/${org.id}/onramp`, { fiatAmount: Number(amount), returnUrl: window.location.href })))}>Продолжить</button>
          </div>
          {session && (
            <div style={{ marginTop: 16 }}>
              <Callout tone={session.destination === org.account ? "ok" : "bad"}>
                {session.provider}: деньги придут на <span className="mono">{session.destination}</span> — {session.destination === org.account ? "совпадает с аккаунтом организации." : "НЕ СОВПАДАЕТ — не платите."}
              </Callout>
              <div className="actions" style={{ marginTop: 0 }}>
                <a className="btn" data-testid="onramp-open" href={session.url} target="_blank" rel="noreferrer">Открыть окно оплаты</a>
                <button className="secondary" onClick={onDone}>Обновить баланс</button>
              </div>
            </div>
          )}
          <Err e={a.error} />
        </Section>
      )}
    </div>
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
    <Section
      flush
      title="Отчёт по выплатам"
      desc={lines.data?.[0] ? `Стоимость в USD: ${lines.data[0].priceSource}.` : "Дата, получатель, сумма, стоимость в USD, категория, хеш."}
      testid="reports"
      actions={
        <button
          className="secondary"
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
      }
    >
      <div className="row" style={{ padding: "0 20px 16px" }}>
        <label className="row small muted">с <input className="input-inline" data-testid="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small muted">по <input className="input-inline" data-testid="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <Table
        testid="report-table"
        cols={[{ label: "Получатель", primary: true }, { label: "Дата" }, { label: "Выплата" }, { label: "Сумма", className: "r" }, { label: "USD", className: "r" }, { label: "Категория" }, { label: "Статус" }, { label: "Хеш" }]}
        rows={(lines.data ?? []).map((l, i) => ({
          key: String(i),
          cells: [<span className="cell-main">{l.recipient}</span>, dateTime(l.date), l.payout, <span className="num">{l.amount}</span>, <span className="num">{l.usdValue}</span>, l.category ?? "—", <Badge s={l.status} />, <Addr value={l.txHash} />],
        }))}
        empty="За выбранный период выплат нет."
      />
      <div style={{ padding: "0 20px" }}><Err e={lines.error || a.error} /></div>
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
    <>
      <Section flush title="Участники" desc="Состав подтверждающих записан в контракте аккаунта; сменить его может только операция, подтверждённая порогом." testid="members">
        <Table
          cols={[{ label: "Почта", primary: true }, { label: "Роли" }, { label: "Статус" }, ...(isAdmin ? [{ label: "" }] : [])]}
          rows={(list.data ?? []).map((m) => ({
            key: m.email,
            cells: [
              <span className="row"><span className="avatar">{m.email.slice(0, 1).toUpperCase()}</span><span className="cell-main" data-testid={`member-${m.email}`}>{m.email}</span></span>,
              <span className="row">{m.roles.map((r) => <span key={r} className="chip">{ROLE[r] ?? r}</span>)}</span>,
              <span className={`badge ${m.status === "active" ? "ok" : "warn"}`}>{m.status === "active" ? "вошёл" : "приглашён"}</span>,
              ...(isAdmin ? [m.roles.includes("operator") && !m.roles.includes("admin") ? <button className="ghost sm" data-testid={`remove-${m.email}`} onClick={a.run(async () => { await call(auth.headers, "DELETE", `/orgs/${org.id}/members/${encodeURIComponent(m.email)}`); await list.reload(); })}>Убрать</button> : null] : []),
            ],
          }))}
        />
      </Section>
      {isAdmin && (
        <Section title="Пригласить оператора" desc="Оператор готовит выплаты, но не может их подписать.">
          <div className="row">
            <input className="grow" data-testid="invite-email" type="email" placeholder="почта оператора" value={email} onChange={(e) => setEmail(e.target.value.trim())} />
            <button data-testid="invite" disabled={!email} onClick={a.run(async () => { await call(auth.headers, "POST", `/orgs/${org.id}/members`, { email }); setEmail(""); await list.reload(); })}>Пригласить</button>
          </div>
        </Section>
      )}
      <Err e={list.error || a.error} />
    </>
  );
}

function Settings({ org, onSaved }: { org: Org; onSaved: () => void }) {
  const auth = useAuth();
  const [days, setDays] = useState(org.auto_refund_days ? String(org.auto_refund_days) : "");
  const [saved, setSaved] = useState(false);
  const a = useAction();
  const isAdmin = org.myRoles.includes("admin");
  return (
    <div className="narrow" style={{ marginLeft: 0 }}>
      <Section title="Автовозврат" desc="Значение по умолчанию для новых выплат; в каждой выплате его можно изменить." testid="settings">
        <Field label="Вернуть неполученные платежи через, дней" help="Пусто — бессрочно. По истечении срока деньги возвращаются на аккаунт организации.">
          <input data-testid="autorefund" className="w-amount" inputMode="numeric" disabled={!isAdmin} value={days} onChange={(e) => { setDays(e.target.value); setSaved(false); }} />
        </Field>
        {isAdmin ? (
          <div className="actions" style={{ marginTop: 0 }}>
            <button data-testid="settings-save" onClick={a.run(async () => { await call(auth.headers, "PATCH", `/orgs/${org.id}/settings`, { autoRefundDays: days ? Number(days) : null }); setSaved(true); onSaved(); })}>Сохранить</button>
            {saved && <span className="badge ok" data-testid="settings-saved">сохранено</span>}
          </div>
        ) : (
          <p className="hint">Менять может администратор.</p>
        )}
        <Err e={a.error} />
      </Section>
    </div>
  );
}

const ACTION: Record<string, string> = {
  "org.deployed": "аккаунт создан", "org.imported": "аккаунт подключён", "payout.created": "выплата создана", "batch.frozen": "партия на подтверждение",
  "batch.revoke_frozen": "отзыв на подтверждение", "batch.rekey_frozen": "новые ссылки на подтверждение", "batch.approved": "подпись", "batch.submitted": "отправлено в сеть",
  "forms.created": "формы реквизитов", "settings.updated": "настройки изменены", "member.invited": "приглашён оператор", "member.removed": "оператор убран", "payout.closed": "выплата закрыта",
  "book.saved": "получатель в книге", "book.deleted": "получатель удалён из книги", "onramp.session": "покупка USDC", "row.added": "строка добавлена", "row.edited": "строка изменена",
  "schedule.created": "регулярная выплата", "setup.started": "создание начато", "setup.joined": "подтверждающий вошёл", "setup.confirmed": "состав подписан",
};

function Audit({ org }: { org: Org }) {
  const auth = useAuth();
  const log = useLoad(() => call<{ at: string; action: string; actor: string | null; details: unknown }[]>(auth.headers, "GET", `/orgs/${org.id}/audit`), [org.id]);
  return (
    <Section flush title="Журнал действий" desc="Кто и что сделал в организации." testid="audit">
      <Table
        testid="audit-table"
        cols={[{ label: "Что", primary: true }, { label: "Кто" }, { label: "Когда" }, { label: "Детали" }]}
        rows={(log.data ?? []).map((l, i) => ({
          key: String(i),
          cells: [<span className="cell-main" data-action={l.action}>{ACTION[l.action] ?? l.action}</span>, l.actor ?? "—", dateTime(l.at), <span className="mono small muted">{l.details ? JSON.stringify(l.details).slice(0, 80) : ""}</span>],
        }))}
      />
      <div style={{ padding: "0 20px" }}><Err e={log.error} /></div>
    </Section>
  );
}
