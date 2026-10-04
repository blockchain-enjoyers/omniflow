import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useAuth } from "@omniflow/auth-client";
import { call, download, downloadBinary, type Org, type PayoutListItem, type YearEnd } from "../api";
import { Addr, Badge, Callout, chainName, confirmAction, date, dateTime, Err, Field, Section, Stat, Table, toast, usdc, useAction, useLoad } from "../ui";

const TABS: [string, string][] = [
  ["payouts", "Payouts"], ["book", "Address book"], ["schedules", "Recurring"], ["topup", "Add funds"],
  ["reports", "Reports"], ["members", "Members"], ["settings", "Settings"], ["audit", "Activity"],
];
const ROLE: Record<string, string> = { admin: "admin", operator: "operator", approver: "approver" };

export function OrgPage({ id, tab }: { id: string; tab: string }) {
  const auth = useAuth();
  const org = useLoad(() => call<Org>(auth.headers, "GET", `/orgs/${id}`), [id]);
  const bal = useLoad(() => call<{ balance: string; reservedInEscrow: string; account: string }>(auth.headers, "GET", `/orgs/${id}/balance`), [id]);
  const o = org.data;
  const weight = o?.approvers.reduce((a, b) => a + b.weight, 0) ?? 0;
  return (
    <>
      <a className="back" href="#/">← Organizations</a>
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
          <Stat label="Account balance" value={bal.data ? usdc(bal.data.balance) : "…"} testid="balance" foot="Omniflow pays gas — no ETH needed" />
          <Stat label="Sent by link, not yet claimed" sm value={bal.data ? usdc(bal.data.reservedInEscrow) : "…"} foot="Still your money: it can be revoked" />
          <Stat label="Approval" sm value={`${o.threshold} of ${weight}`} foot={`${o.approvers.length} approvers, recorded in the contract`} />
        </div>
      )}
      <nav className="tabs">
        {TABS.map(([k, label]) => (
          <a key={k} className={`tab ${tab === k ? "active" : ""}`} href={`#/org/${id}/${k}`} data-testid={`tab-${k}`}>{label}</a>
        ))}
      </nav>
      {o && tab === "payouts" && <Payouts org={o} balance={bal.data?.balance ?? null} />}
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

function Payouts({ org, balance }: { org: Org; balance: string | null }) {
  const auth = useAuth();
  const list = useLoad(() => call<PayoutListItem[]>(auth.headers, "GET", `/orgs/${org.id}/payouts`), [org.id]);
  const isOp = org.myRoles.includes("operator");
  const empty = balance !== null && BigInt(balance) === 0n;
  return (
    <>
      {isOp && empty && (
        <Callout tone="info" testid="fund-first">
          <b>The account is empty.</b> Add USDC before sending — you can still prepare payouts now. <a href={`#/org/${org.id}/topup`}>Add funds →</a>
        </Callout>
      )}
      <Section flush title="Payouts" testid="payouts" actions={isOp && <a className="btn" data-testid="new-payout" href={`#/org/${org.id}/new`}>+ New payout</a>}>
        <Table
          cols={[{ label: "Title", primary: true }, { label: "Rows", className: "r" }, { label: "Amount", className: "r" }, { label: "Status" }, { label: "Created" }]}
          rows={(list.data ?? []).map((p) => ({ key: p.id, cells: [<a href={`#/payout/${p.id}`} className="cell-main">{p.title}</a>, <span className="num">{p.rows}</span>, <span className="num">{usdc(p.total)}</span>, <Badge s={p.status} />, date(p.created_at)] }))}
          empty={isOp ? <>No payouts yet. <a href={`#/org/${org.id}/new`}>Create the first one</a> from a spreadsheet or by typing a few rows.</> : "No payouts yet."}
        />
        <div style={{ padding: "0 20px" }}><Err e={list.error} /></div>
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
  const picked = Object.values(pick).filter(Boolean).length;
  return (
    <>
      <Section flush title="Address book" desc="Fills itself from paid rows. Editing here does not change anything already sent." testid="book">
        <Table
          cols={[{ label: "Name", primary: true }, { label: "Address / email" }, { label: "Category" }, { label: "Last amount", className: "r" }, ...(isOp ? [{ label: "Amount now" }, { label: "" }] : [])]}
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
                    <button className="ghost sm" data-testid={`book-delete-${e.name}`} onClick={a.run(async () => { if (!(await confirmAction({ title: `Delete ${e.name} from the address book?`, body: "Payments already sent are not affected.", confirm: "Delete", danger: true }))) return; await call(auth.headers, "DELETE", `/orgs/${org.id}/address-book/${e.id}`); await book.reload(); toast(`${e.name} deleted`); })}>Delete</button>,
                  ]
                : []),
            ],
          }))}
          empty="The book is empty — recipients appear after the first payout."
        />
        {isOp && (
          <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
            <div className="row">
              <input className="grow" data-testid="book-payout-title" placeholder="Payout title" value={title} onChange={(e) => setTitle(e.target.value)} />
              <button
                data-testid="book-payout"
                disabled={!picked || !title}
                onClick={a.run(async () => {
                  const items = Object.entries(pick).filter(([, v]) => v).map(([id, amount]) => ({ id, amount }));
                  const p = await call<{ id: string }>(auth.headers, "POST", `/orgs/${org.id}/payouts/from-book`, { title, items });
                  window.location.hash = `#/payout/${p.id}`;
                })}
              >
                Pay selected{picked ? ` (${picked})` : ""}
              </button>
            </div>
          </div>
        )}
      </Section>
      {isOp && (
        <Section title="Add a recipient">
          <div className="grid grid-2">
            <Field label="Name"><input data-testid="book-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Category"><input data-testid="book-category" placeholder="grants, contractors…" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
            <Field label="Wallet address"><input className="mono" data-testid="book-address" placeholder="0x…" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value.trim() })} /></Field>
            <Field label="or email"><input data-testid="book-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value.trim() })} /></Field>
          </div>
          <div className="actions" style={{ marginTop: 0 }}>
            <button data-testid="book-save" disabled={!form.name || (!form.address && !form.email)} onClick={a.run(async () => { await call(auth.headers, "POST", `/orgs/${org.id}/address-book`, { ...form, chainId: org.chain_id, address: form.address || null, email: form.email || null }); toast(`${form.name} saved`); setForm({ name: "", email: "", address: "", category: "" }); await book.reload(); })}>Save</button>
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
    <Section flush title="Recurring payouts" desc="A schedule creates a draft from a template and emails the operators. Nothing leaves without review and approval. Create one on the template payout page." testid="schedules">
      <Table
        cols={[{ label: "Title", primary: true }, { label: "Every" }, { label: "Next draft" }, { label: "Status" }, { label: "" }]}
        rows={(list.data ?? []).map((s) => ({
          key: s.id,
          cells: [
            <span><span className="cell-main">{s.title}</span> <a className="small" href={`#/payout/${s.templatePayoutId}`}>template</a></span>,
            s.every === "month" ? "monthly" : "weekly",
            dateTime(s.nextRunAt),
            <span className={`badge ${s.active ? "ok" : ""}`} data-testid={`schedule-state-${s.title}`}>{s.active ? "active" : "paused"}</span>,
            isOp ? <button className="secondary sm" data-testid={`schedule-toggle-${s.title}`} onClick={a.run(async () => { await call(auth.headers, "PATCH", `/orgs/${org.id}/schedules/${s.id}`, { active: !s.active }); await list.reload(); })}>{s.active ? "Pause" : "Resume"}</button> : null,
          ],
        }))}
        empty="No recurring payouts."
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
      <Section title="Transfer USDC" desc="From a Safe, an exchange or your own wallet" testid="topup">
        <div className="topup-grid">
          <div>
            <p className="hint" style={{ marginBottom: 6 }}>Organization account address, chain <b>{chainName(org.chain_id)}</b></p>
            <div className="addr-box" data-testid="topup-address">{org.account}</div>
          </div>
          <AddressQr address={org.account} />
        </div>
        <ul className="hint" style={{ marginTop: 14 }}>
          <li>In Safe: New transaction → Send tokens → USDC → this address.</li>
          <li>Check the address against the one the approvers signed. Send a small test amount first.</li>
        </ul>
        <Callout tone="warn">{chainName(org.chain_id)} only. USDC sent from another chain will not arrive.</Callout>
      </Section>
      {canBuy && (
        <Section title="Buy USDC" desc="Purchase and KYC happen at the partner. The money lands on the organization account." testid="onramp">
          <Field label="Amount, USD">
            <input data-testid="onramp-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <div className="actions" style={{ marginTop: 0 }}>
            <button data-testid="onramp-start" onClick={a.run(async () => setSession(await call(auth.headers, "POST", `/orgs/${org.id}/onramp`, { fiatAmount: Number(amount), returnUrl: window.location.href })))}>Continue</button>
          </div>
          {session && (
            <div style={{ marginTop: 16 }}>
              <Callout tone={session.destination === org.account ? "ok" : "bad"}>
                {session.provider}: funds will go to <span className="mono">{session.destination}</span> — {session.destination === org.account ? "matches the organization account." : "DOES NOT MATCH — do not pay."}
              </Callout>
              <div className="actions" style={{ marginTop: 0 }}>
                <a className="btn" data-testid="onramp-open" href={session.url} target="_blank" rel="noreferrer">Open payment window</a>
                <button className="secondary" onClick={onDone}>Refresh balance</button>
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
  const lines = useLoad(() => call<{ date: string; payout: string; recipient: string; amount: string; usdValue: string; category: string | null; status: string; txHash: string | null; priceSource: string; document: string }[]>(auth.headers, "GET", `/orgs/${org.id}/reports/payments?${q}`), [org.id, q]);
  const a = useAction();
  const [yearEnd, setYearEnd] = useState(false);
  const ye = useLoad(() => call<YearEnd>(auth.headers, "GET", `/orgs/${org.id}/reports/year-end`), [org.id]);
  const anyForm = (ye.data?.recipients.length ?? 0) > 0;
  return (
    <>
    <Section
      flush
      title="Payments report"
      desc={lines.data?.[0] ? `USD value: ${lines.data[0].priceSource}.` : "Date, recipient, amount, USD value, category, hash."}
      testid="reports"
      actions={
        <div className="row">
          <button
            className="secondary"
            data-testid="records"
            title="One page per payment: who paid whom, who requested and approved it, the transaction — to keep, print or save as PDF"
            onClick={a.run(() => download(auth.headers, `/orgs/${org.id}/reports/records?${q}`, `omniflow-${org.name}-payment-records.html`, "text/html"))}
          >
            Download records
          </button>
          <button className="secondary" data-testid="csv" onClick={a.run(() => download(auth.headers, `/orgs/${org.id}/reports/payments?${q}format=csv`, `omniflow-${org.name}-payments.csv`, "text/csv"))}>
            Export CSV
          </button>
          <button className="secondary" data-testid="year-end" disabled={!anyForm} title={anyForm ? "Form 1099-NEC, Copy B, for each recipient with a W-9 on file" : "No forms on file yet"} onClick={() => setYearEnd(!yearEnd)}>
            Year-end forms
          </button>
        </div>
      }
    >
      <div className="row" style={{ padding: "0 20px 16px" }}>
        <label className="row small muted">from <input className="input-inline" data-testid="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small muted">to <input className="input-inline" data-testid="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <Table
        testid="report-table"
        cols={[{ label: "Recipient", primary: true }, { label: "Date" }, { label: "Payout" }, { label: "Amount", className: "r" }, { label: "USD", className: "r" }, { label: "Category" }, { label: "Status" }, { label: "Document" }, { label: "Hash" }]}
        rows={(lines.data ?? []).map((l, i) => ({
          key: String(i),
          cells: [<span className="cell-main">{l.recipient}</span>, dateTime(l.date), l.payout, <span className="num">{l.amount}</span>, <span className="num">{l.usdValue}</span>, l.category ?? "—", <Badge s={l.status} />, <span data-testid={`report-document-${l.recipient}`}>{l.document}</span>, <Addr value={l.txHash} />],
        }))}
        empty="No payments in this period."
      />
      {!anyForm && <p className="hint small" style={{ padding: "0 20px" }} data-testid="year-end-none">No forms on file yet</p>}
      <div style={{ padding: "0 20px" }}><Err e={lines.error || a.error} /></div>
    </Section>
    {yearEnd && anyForm && <YearEndForms org={org} />}
    </>
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
      <Section flush title="Members" desc="The approver set is recorded in the account contract; only an operation approved by the threshold can change it." testid="members">
        <Table
          cols={[{ label: "Email", primary: true }, { label: "Roles" }, { label: "Status" }, ...(isAdmin ? [{ label: "" }] : [])]}
          rows={(list.data ?? []).map((m) => ({
            key: m.email,
            cells: [
              <span className="row"><span className="avatar">{m.email.slice(0, 1).toUpperCase()}</span><span className="cell-main" data-testid={`member-${m.email}`}>{m.email}</span></span>,
              <span className="row">{m.roles.map((r) => <span key={r} className="chip">{ROLE[r] ?? r}</span>)}</span>,
              <span className={`badge ${m.status === "active" ? "ok" : "warn"}`}>{m.status === "active" ? "active" : "invited"}</span>,
              ...(isAdmin ? [m.roles.includes("operator") && !m.roles.includes("admin") ? <button className="ghost sm" data-testid={`remove-${m.email}`} onClick={a.run(async () => { if (!(await confirmAction({ title: `Remove ${m.email}?`, body: "They will no longer be able to prepare payouts for this organization.", confirm: "Remove", danger: true }))) return; await call(auth.headers, "DELETE", `/orgs/${org.id}/members/${encodeURIComponent(m.email)}`); await list.reload(); toast(`${m.email} removed`); })}>Remove</button> : null] : []),
            ],
          }))}
        />
      </Section>
      {isAdmin && (
        <Section title="Invite an operator" desc="An operator prepares payouts but cannot sign them.">
          <div className="row">
            <input className="grow" data-testid="invite-email" type="email" placeholder="operator email" value={email} onChange={(e) => setEmail(e.target.value.trim())} />
            <button data-testid="invite" disabled={!email} onClick={a.run(async () => { await call(auth.headers, "POST", `/orgs/${org.id}/members`, { email }); toast(`Invitation sent to ${email}`); setEmail(""); await list.reload(); })}>Invite</button>
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
      <Section title="Auto-refund" desc="Default for new payouts; each payout can override it." testid="settings">
        <Field label="Return unclaimed payments after, days" help="Empty — never. When the period ends the money returns to the organization account.">
          <input data-testid="autorefund" className="w-amount" inputMode="numeric" disabled={!isAdmin} value={days} onChange={(e) => { setDays(e.target.value); setSaved(false); }} />
        </Field>
        {isAdmin ? (
          <div className="actions" style={{ marginTop: 0 }}>
            <button data-testid="settings-save" onClick={a.run(async () => { await call(auth.headers, "PATCH", `/orgs/${org.id}/settings`, { autoRefundDays: days ? Number(days) : null }); setSaved(true); toast("Settings saved"); onSaved(); })}>Save</button>
            {saved && <span className="badge ok" data-testid="settings-saved">saved</span>}
          </div>
        ) : (
          <p className="hint">Only an admin can change this.</p>
        )}
        <Err e={a.error} />
      </Section>
      <DocumentsSettings org={org} onSaved={onSaved} />
    </div>
  );
}

function DocumentsSettings({ org, onSaved }: { org: Org; onSaved: () => void }) {
  const auth = useAuth();
  const [dest, setDest] = useState(org.doc_destination ?? "");
  const a = useAction();
  const isAdmin = org.myRoles.includes("admin");
  return (
    <Section title="Documents" testid="documents-settings">
      <Field label="Where to put received forms" help="An email address. Forms that recipients upload are sent there; Omniflow keeps only their type, date and fingerprint.">
        <input type="email" data-testid="doc-destination" disabled={!isAdmin} value={dest} onChange={(e) => setDest(e.target.value.trim())} placeholder="forms@company.com" />
      </Field>
      {isAdmin && (
        <div className="actions" style={{ marginTop: 0 }}>
          <button data-testid="doc-destination-save" onClick={a.run(async () => { await call(auth.headers, "PATCH", `/orgs/${org.id}/settings`, { docDestination: dest || null }); toast("Saved"); onSaved(); })}>Save</button>
        </div>
      )}
      <Err e={a.error} />
    </Section>
  );
}

const ACTION: Record<string, string> = {
  "org.deployed": "account created", "org.imported": "account connected", "payout.created": "payout created", "batch.frozen": "batch sent for approval",
  "batch.revoke_frozen": "revoke sent for approval", "batch.rekey_frozen": "new links sent for approval", "batch.approved": "signed", "batch.submitted": "submitted on chain",
  "forms.created": "details forms created", "settings.updated": "settings changed", "member.invited": "operator invited", "member.removed": "operator removed", "payout.closed": "payout closed",
  "book.saved": "recipient saved", "book.deleted": "recipient deleted", "onramp.session": "USDC purchase", "row.added": "row added", "row.edited": "row edited",
  "schedule.created": "recurring payout", "document.requested": "tax form requested", "document.received": "tax form received", "document.1099nec": "1099-NEC prepared", "setup.started": "setup started", "setup.joined": "approver joined", "setup.confirmed": "approver set signed",
};

function Audit({ org }: { org: Org }) {
  const auth = useAuth();
  const log = useLoad(() => call<{ at: string; action: string; actor: string | null; details: unknown }[]>(auth.headers, "GET", `/orgs/${org.id}/audit`), [org.id]);
  return (
    <Section flush title="Activity log" desc="Who did what in the organization." testid="audit">
      <Table
        testid="audit-table"
        cols={[{ label: "What", primary: true }, { label: "Who" }, { label: "When" }, { label: "Details" }]}
        rows={(log.data ?? []).map((l, i) => ({
          key: String(i),
          cells: [<span className="cell-main" data-action={l.action}>{ACTION[l.action] ?? l.action}</span>, l.actor ?? "—", dateTime(l.at), <span className="mono small muted">{l.details ? JSON.stringify(l.details).slice(0, 80) : ""}</span>],
        }))}
      />
      <div style={{ padding: "0 20px" }}><Err e={log.error} /></div>
    </Section>
  );
}

/**
 * Form 1099-NEC, Copy B, for each recipient with a W-9 on file. Box 1 is the sum of the year's payments from our data;
 * the TINs and addresses are typed here from the payer's records and the recipient's W-9, fill the form, and are not stored.
 */
function YearEndForms({ org }: { org: Org }) {
  const auth = useAuth();
  const [year, setYear] = useState<number | null>(null);
  const ye = useLoad(() => call<YearEnd>(auth.headers, "GET", `/orgs/${org.id}/reports/year-end${year ? `?year=${year}` : ""}`), [org.id, year]);
  const [payer, setPayer] = useState({ name: org.name, street: "", city: "", state: "", zip: "", phone: "", tin: "" });
  const [rec, setRec] = useState<Record<string, { tin: string; street: string; city: string; state: string; zip: string }>>({});
  const a = useAction();
  const y = ye.data;
  const P = (k: keyof typeof payer, label: string, wide = false) => (
    <Field label={label}><input className={wide ? "" : "w-amount"} data-testid={`payer-${k}`} value={payer[k]} onChange={(e) => setPayer({ ...payer, [k]: e.target.value })} /></Field>
  );
  return (
    <Section title="Year-end forms" desc={y ? `Form ${y.form.name}, Rev. ${y.form.revision} — ${y.form.copy}. Only the copy the IRS allows to print is produced.` : ""} testid="year-end-forms">
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="row small muted">Year <select className="input-inline" data-testid="year-end-year" value={y?.year ?? ""} onChange={(e) => setYear(Number(e.target.value))}>{(y?.years ?? []).map((v) => <option key={v} value={v}>{v}</option>)}</select></label>
      </div>
      <h3 style={{ marginTop: 0 }}>Payer</h3>
      <div className="grid grid-3">
        {P("name", "Legal name", true)}
        {P("tin", "TIN (EIN)")}
        {P("phone", "Telephone")}
        {P("street", "Street address", true)}
        {P("city", "City or town")}
        <div className="row">{P("state", "State")}{P("zip", "ZIP")}</div>
      </div>
      <h3>Recipients with a W-9 on file</h3>
      <Table
        testid="year-end-table"
        cols={[{ label: "Recipient", primary: true }, { label: "Paid in year", className: "r" }, { label: "TIN from W-9" }, { label: "Address from W-9" }, { label: "" }]}
        rows={(y?.recipients ?? []).map((r) => {
          const v = rec[r.key] ?? { tin: "", street: "", city: "", state: "", zip: "" };
          const set = (patch: Partial<typeof v>) => setRec({ ...rec, [r.key]: { ...v, ...patch } });
          return {
            key: r.key,
            cells: [
              <span><span className="cell-main">{r.name}</span><span className="cell-sub small muted">{r.email ?? r.address}</span></span>,
              <span className="num">{r.usd} USD</span>,
              <input className="w-amount" data-testid={`tin-${r.name}`} placeholder="123-45-6789" value={v.tin} onChange={(e) => set({ tin: e.target.value })} />,
              <span className="stack">
                <input data-testid={`street-${r.name}`} placeholder="street" value={v.street} onChange={(e) => set({ street: e.target.value })} />
                <span className="row"><input className="w-amount" placeholder="city" value={v.city} onChange={(e) => set({ city: e.target.value })} /><input className="w-amount" placeholder="state" value={v.state} onChange={(e) => set({ state: e.target.value })} /><input className="w-amount" placeholder="ZIP" value={v.zip} onChange={(e) => set({ zip: e.target.value })} /></span>
              </span>,
              <button className="secondary sm" data-testid={`nec-${r.name}`} disabled={a.busy} onClick={a.run(() => downloadBinary(auth.headers, `/orgs/${org.id}/reports/year-end/1099-nec`, `1099-nec-${r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${y!.year}.pdf`, { year: y!.year, recipient: r.key, payer, recipientInfo: v }))}>Download 1099-NEC</button>,
            ],
          };
        })}
        empty="No recipient with a W-9 on file in this year."
      />
      <p className="hint small" style={{ marginTop: 10 }}>TINs and addresses fill the form and are not stored. Nothing is filed with the IRS here.</p>
      <Err e={ye.error || a.error} />
    </Section>
  );
}
