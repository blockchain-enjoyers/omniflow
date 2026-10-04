import { useCallback, useState } from "react";
import { useAuth } from "@omniflow/auth-client";
import { call, download, type Batch, type Org, type Receipt, type Review, type ReviewRow } from "../api";
import { Addr, Badge, Callout, confirmAction, dateTime, Err, Section, short, Table, toast, usdc, useAction, useLoad, usePoll } from "../ui";

const who = (r: ReviewRow) => `${r.name}${r.address ? ` · ${short(r.address)}` : ""}${r.email ? ` · ${r.email}` : ""}`;
const REASON: Record<string, string> = { "no-address-no-email": "no address and no email — waiting for details", "other-chain": "other chain — will not be sent" };
const BATCH_KIND: Record<string, string> = { pay: "payout", revoke: "revoke", rekey: "new links" };
const RECORDED = ["sent", "in_escrow", "claimed", "refunded"];

/** Who asked for a batch and who approved it, in the order they signed. */
function trail(b: Batch) {
  const approved = b.signers.filter((x) => x.signed).sort((x, y) => (x.signedAt ?? "").localeCompare(y.signedAt ?? "")).map((x) => x.email ?? short(x.address));
  const last = b.signers.map((x) => x.signedAt).filter(Boolean).sort().pop();
  return { requested: b.requested_by ?? "not recorded", approved, last };
}

export function PayoutPage({ id }: { id: string }) {
  const auth = useAuth();
  const receipt = useLoad(() => call<Receipt>(auth.headers, "GET", `/payouts/${id}/receipt`), [id]);
  const review = useLoad(() => call<Review>(auth.headers, "GET", `/payouts/${id}/review`), [id]);
  const batches = useLoad(() => call<Batch[]>(auth.headers, "GET", `/payouts/${id}/batches`), [id]);
  const [links, setLinks] = useState<{ row: string; name: string; link: string; emailed: boolean }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [edit, setEdit] = useState<Record<string, { amount?: string; address?: string; email?: string }>>({});
  const [add, setAdd] = useState({ name: "", address: "", email: "", amount: "" });
  const [every, setEvery] = useState<"month" | "week">("month");
  const a = useAction();
  const reload = useCallback(async () => {
    await Promise.all([receipt.reload(), review.reload(), batches.reload()]);
  }, [receipt.reload, review.reload, batches.reload]);
  const rows = receipt.data?.rows ?? [];
  const editable = (s: string) => ["ready", "waiting_details", "other_chain"].includes(s);
  const openBatch = batches.data?.find((b) => ["collecting", "submitted"].includes(b.status));
  const s = review.data?.summary;
  const closed = receipt.data?.payout.status === "closed";

  // Where the payout is, and the one thing to do next.
  const pending = batches.data?.find((b) => b.status === "collecting");
  const sending = batches.data?.find((b) => b.status === "submitted");
  const sendableNow = s ? s.toAddress + s.byEmail : 0;
  const executed = rows.some((r) => r.executed);
  const stage: "draft" | "approval" | "sending" | "done" = sending ? "sending" : pending ? "approval" : closed ? "done" : sendableNow > 0 ? "draft" : executed ? "done" : "draft";
  const stageNo = { draft: 0, approval: 1, sending: 2, done: 3 }[stage];
  usePoll(reload, stage === "approval" || stage === "sending", 3000);
  const me = auth.user?.wallet?.toLowerCase();
  const mySignature = pending?.signers.find((x) => x.address.toLowerCase() === me);
  const count = (st: string) => rows.filter((r) => r.status === st).length;

  const rowCells = (r: (typeof rows)[number]) => {
    const e = edit[r.row];
    const setE = (patch: { amount?: string; address?: string; email?: string }) => setEdit({ ...edit, [r.row]: { ...e, ...patch } });
    return [
      r.status === "in_escrow" ? <input type="checkbox" aria-label={`select ${r.name}`} data-testid={`pick-${r.name}`} checked={picked.includes(r.row)} onChange={(x) => setPicked(x.target.checked ? [...picked, r.row] : picked.filter((y) => y !== r.row))} /> : null,
      <span>
        <span className="cell-main">{r.name}</span>
        <span className="cell-sub">{r.address ? <Addr value={r.address} /> : <span className="small muted">{r.email ?? "no details"}</span>}</span>
        {e && (
          <span className="edit-row">
            <input aria-label="amount" data-testid={`row-amount-${r.name}`} inputMode="decimal" placeholder="amount" value={e.amount ?? ""} onChange={(x) => setE({ amount: x.target.value })} />
            <input aria-label="address" className="mono" data-testid={`row-address-${r.name}`} placeholder="address 0x…" value={e.address ?? ""} onChange={(x) => setE({ address: x.target.value.trim() })} />
            <input aria-label="email" data-testid={`row-email-${r.name}`} placeholder="email" value={e.email ?? ""} onChange={(x) => setE({ email: x.target.value.trim() })} />
            <span className="row">
              <button className="sm" data-testid={`row-save-${r.name}`} onClick={a.run(async () => { await call(auth.headers, "PATCH", `/payouts/${id}/rows/${r.row}`, { amount: e.amount, address: e.address || null, email: e.email || null }); const n = { ...edit }; delete n[r.row]; setEdit(n); toast(`${r.name} updated`); await reload(); })}>Save</button>
              <button className="ghost sm" data-testid={`row-remove-${r.name}`} onClick={a.run(async () => { await call(auth.headers, "PATCH", `/payouts/${id}/rows/${r.row}`, { remove: true }); toast(`${r.name} removed`); await reload(); })}>Remove row</button>
              <button className="ghost sm" onClick={() => { const n = { ...edit }; delete n[r.row]; setEdit(n); }}>Cancel</button>
            </span>
          </span>
        )}
      </span>,
      <span className="num">{usdc(r.amount)}</span>,
      <Badge s={r.status} testid={`status-${r.name}`} extra={r.failReason ? ` (${r.failReason})` : ""} />,
      <Addr value={r.txHash} />,
      editable(r.status) && !closed && !e ? (
        <button className="ghost sm" data-testid={`edit-${r.name}`} onClick={() => setEdit({ ...edit, [r.row]: { amount: String(Number(r.amount) / 1e6), address: r.address ?? "", email: r.email ?? "" } })}>Edit</button>
      ) : RECORDED.includes(r.status) ? (
        <button
          className="ghost sm"
          data-testid={`record-${r.name}`}
          title="A page with who paid whom, who approved it and the transaction — to keep, print or save as PDF"
          onClick={a.run(() => download(auth.headers, `/payouts/${id}/rows/${r.row}/record`, `omniflow-record-${r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.html`, "text/html"))}
        >
          Download record
        </button>
      ) : null,
    ];
  };
  const payBatches = (batches.data ?? []).filter((b) => b.kind === "pay");
  const lastPay = payBatches[payBatches.length - 1];
  const orgId = receipt.data?.payout.orgId;
  const org = useLoad(() => (orgId ? call<Org>(auth.headers, "GET", `/orgs/${orgId}`) : Promise.resolve(null)), [orgId]);
  const selectable = rows.some((r) => r.status === "in_escrow");

  return (
    <>
      {orgId && <a className="back" href={`#/org/${orgId}`}>← {org.data?.name ?? "Organization"}</a>}
      <div className="page-head">
        <div>
          <h1 data-testid="payout-title">{receipt.data?.payout.title ?? "…"}</h1>
          <div className="sub row">{receipt.data && <span data-testid="payout-status"><Badge s={receipt.data.payout.status} /></span>}<span>{rows.length} rows · {usdc(rows.reduce((x, r) => x + BigInt(r.amount), 0n))}</span></div>
          {lastPay && (
            <p className="trail" data-testid="trail">
              Requested by <b>{trail(lastPay).requested}</b>
              {trail(lastPay).approved.length > 0 && <> · approved by <b>{trail(lastPay).approved.join(", ")}</b></>}
              {trail(lastPay).last && <> · {dateTime(trail(lastPay).last!)}</>}
              {payBatches.length > 1 && <span className="muted"> · latest of {payBatches.length} batches</span>}
            </p>
          )}
        </div>
        <div className="row">
          <button className="secondary" data-testid="repeat" onClick={a.run(async () => { const p = await call<{ id: string }>(auth.headers, "POST", `/payouts/${id}/repeat`, {}); window.location.hash = `#/payout/${p.id}`; })}>Repeat with edits</button>
          {!closed && <button className="secondary" data-testid="close" onClick={a.run(async () => { if (!(await confirmAction({ title: "Close this payout?", body: "Rows that were not sent stay in the report; nothing more will be sent from this payout. Payments already sent are not affected.", confirm: "Close payout", danger: true }))) return; await call(auth.headers, "POST", `/payouts/${id}/close`); toast("Payout closed"); await reload(); })}>Close payout</button>}
        </div>
      </div>

      <ol className="steps" data-testid="stepper" aria-label="progress">
        {["Prepare", "Approve", "Send", "Done"].map((label, i) => (
          <li key={label} className={`step ${i < stageNo || (stage === "done" && i === 3) ? "done" : i === stageNo ? "current" : ""}`}>{label}</li>
        ))}
      </ol>

      {stage === "approval" && pending && (
        <Section title={pending.kind === "revoke" ? "Revoke is waiting for approvals" : pending.kind === "rekey" ? "New links are waiting for approvals" : "Waiting for approvals"} testid="approval-progress">
          <p style={{ marginBottom: 0 }}>
            <b data-testid="approval-count">{pending.signedWeight} of {pending.threshold}</b> signatures. {mySignature && !mySignature.signed ? "Yours is needed too." : "The approvers were emailed a link; this page updates by itself."}
          </p>
          <ul className="signer-list">
            {pending.signers.map((x) => (
              <li key={x.address}>
                <span className={`tick ${x.signed ? "yes" : "no"}`}>{x.signed ? "✓" : ""}</span>
                <span>{x.email ?? short(x.address)}</span>
                <span className="hint small">{x.signed ? "signed" : "waiting"}</span>
              </li>
            ))}
          </ul>
          {mySignature && !mySignature.signed && <div className="actions"><a className="btn" href={`#/approve/${pending.id}`} data-testid="go-sign">Review and sign</a></div>}
        </Section>
      )}

      {stage === "sending" && (
        <Callout tone="info" testid="sending">All signatures are in — sending to the network. This takes a few seconds.</Callout>
      )}

      {stage === "done" && executed && (
        <Section title={closed ? "Payout closed" : "Sent"} testid="done-summary">
          <div className="row" style={{ gap: 20 }}>
            <span><b>{count("sent")}</b> paid to an address</span>
            <span><b>{count("claimed")}</b> claimed by link</span>
            <span><b>{count("in_escrow")}</b> waiting to be claimed</span>
            {count("refunded") > 0 && <span><b>{count("refunded")}</b> returned</span>}
            {count("failed") > 0 && <span className="error" style={{ margin: 0 }}><b>{count("failed")}</b> failed — they can be sent again</span>}
          </div>
          {count("in_escrow") > 0 && <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>Someone lost the email? Tick their row below to send a new link, or revoke the payment to get the money back.</p>}
        </Section>
      )}

      {s && !closed && s.toAddress + s.byEmail === 0 && s.notSent.length > 0 && stage === "draft" && (
        <Callout tone="warn">Nothing to send. Not sent: {s.notSent.map((n) => `${n.row.name} — ${REASON[n.reason] ?? n.reason}`).join("; ")}.</Callout>
      )}
      {s && stage === "draft" && s.toAddress + s.byEmail > 0 && !closed && (
        <Section title="Review before sending" desc="Check new recipients and changes — the main source of irreversible mistakes." testid="review">
          <div className="grid grid-3" style={{ marginBottom: 16 }}>
            <div className="stat"><span className="label">Will be sent</span><span className="value sm">{s.toAddress + s.byEmail} rows</span><span className="foot">to address {s.toAddress} · by email link {s.byEmail}</span></div>
            <div className="stat"><span className="label">Amount</span><span className="value sm">{usdc(s.total)}</span><span className="foot">Auto-refund: {review.data!.autoRefundDays ? `after ${review.data!.autoRefundDays} days` : "never"}</span></div>
            <div className="stat"><span className="label">Balance</span><span className="value sm">{s.balanceSufficient ? <span className="badge ok">sufficient</span> : <span className="badge bad">insufficient</span>}</span></div>
          </div>
          <div className={`review-group ${s.newRecipients.length ? "warn" : ""}`}><h4>New recipients: {s.newRecipients.length}</h4>
            {s.newRecipients.length > 0 && <ul>{s.newRecipients.map((r) => <li key={r.rowId}>{who(r)} — <b className="num">{usdc(r.amount)}</b></li>)}</ul>}</div>
          {s.changedAmount.length > 0 && <div className="review-group"><h4>Amount changed</h4><ul>{s.changedAmount.map((c) => <li key={c.row.rowId}>{who(c.row)}: {usdc(c.previous)} → <b>{usdc(c.row.amount)}</b></li>)}</ul></div>}
          {s.outliers.length > 0 && <div className="review-group warn"><h4>Outliers</h4><ul>{s.outliers.map((c) => <li key={c.row.rowId}>{who(c.row)}: was {usdc(c.previous)}, now {usdc(c.row.amount)}</li>)}</ul></div>}
          {[...s.duplicateAddress, ...s.duplicateEmail].length > 0 && <div className="review-group warn"><h4>Duplicates</h4><ul>{[...s.duplicateAddress, ...s.duplicateEmail].map((g, i) => <li key={i}>{g.map(who).join(" | ")}</li>)}</ul></div>}
          {s.notSent.length > 0 && <div className="review-group"><h4>Not sent: {s.notSent.length}</h4><ul>{s.notSent.map((n) => <li key={n.row.rowId}>{n.row.name}: {REASON[n.reason] ?? n.reason}</li>)}</ul></div>}
          <div className="actions">
            {openBatch ? (
              <a className="btn secondary" href={`#/approve/${openBatch.id}`}>A batch is awaiting approval — open</a>
            ) : (
              <button data-testid="freeze" disabled={a.busy || s.toAddress + s.byEmail === 0} onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/batches`); toast("Sent for approval — the approvers got an email"); await reload(); })}>
                Send {usdc(s.total)} for approval
              </button>
            )}
          </div>
        </Section>
      )}

      <Section flush title="Rows" testid="rows" actions={<button className="ghost sm" data-testid="refresh" onClick={reload}>Refresh</button>}>
        <Table
          cols={[...(selectable ? [{ label: "" }] : []), { label: "Recipient", primary: true }, { label: "Amount", className: "r" }, { label: "Status" }, { label: "Transaction" }, { label: "" }]}
          rows={rows.map((r) => ({ key: r.row, cells: selectable ? rowCells(r) : rowCells(r).slice(1) }))}
        />
        {picked.length > 0 && (
          <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
            <p style={{ marginBottom: 8 }}><b>Unclaimed payments selected: {picked.length}.</b> <span className="hint">Both actions are approved by the threshold, like a payout. Revoked money returns to the organization account.</span></p>
            <div className="row">
              <button data-testid="rekey" onClick={a.run(async () => { if (!(await confirmAction({ title: `Send new links for ${picked.length} payment${picked.length > 1 ? "s" : ""}?`, body: "The old links stop working once the approvers sign. The recipients get a new email.", confirm: "Send for approval" }))) return; await call(auth.headers, "POST", `/payouts/${id}/rekey`, { rows: picked }); setPicked([]); toast("New links sent for approval"); await reload(); })}>Send new links</button>
              <button data-testid="revoke" className="danger" onClick={a.run(async () => { if (!(await confirmAction({ title: `Revoke ${picked.length} unclaimed payment${picked.length > 1 ? "s" : ""}?`, body: "Once the approvers sign, the money returns to the organization account and the links stop working.", confirm: "Revoke", danger: true }))) return; await call(auth.headers, "POST", `/payouts/${id}/revoke`, { rows: picked }); setPicked([]); toast("Revoke sent for approval"); await reload(); })}>Revoke</button>
            </div>
          </div>
        )}
        {!closed && (stage === "draft" || stage === "done") && (
          <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
            <h3 style={{ marginTop: 0 }}>Add a row</h3>
            <div className="row">
              <input className="grow" data-testid="add-name" placeholder="name" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
              <input className="grow mono" data-testid="add-address" placeholder="address 0x…" value={add.address} onChange={(e) => setAdd({ ...add, address: e.target.value.trim() })} />
              <input className="grow" data-testid="add-email" placeholder="or email" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value.trim() })} />
              <input className="w-amount" data-testid="add-amount" inputMode="decimal" placeholder="amount" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} />
              <button className="secondary" data-testid="add-row" disabled={!add.name || !add.amount} onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${id}/rows`, { name: add.name, address: add.address || undefined, email: add.email || undefined, amount: add.amount, chainId: receipt.data!.payout.chainId }); setAdd({ name: "", address: "", email: "", amount: "" }); await reload(); })}>+ Row</button>
            </div>
          </div>
        )}
        <div style={{ padding: "0 20px" }}><Err e={a.error || receipt.error} /></div>
      </Section>

      {!closed && rows.some((r) => !r.address && ["waiting_details", "ready"].includes(r.status)) && (
        <Section title="Payment details form" desc="The recipient enters their address or email. It is not a link to money; once filled in, send the row for approval." testid="forms">
          <button className="secondary" data-testid="forms-create" onClick={a.run(async () => setLinks(await call(auth.headers, "POST", `/payouts/${id}/forms`, {})))}>Create links</button>
          {links.length > 0 && (
            <ul className="check-list" style={{ marginTop: 12 }}>
              {links.map((l) => (
                <li key={l.row}>
                  <span className="cell-main" style={{ minWidth: 80 }}>{l.name}</span>
                  {l.emailed ? <span className="badge ok">emailed</span> : <span style={{ minWidth: 0 }}><span className="mono small" data-testid={`form-link-${l.name}`}>{l.link}</span><span className="cell-sub hint">Pass it to the recipient</span></span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <div className="grid grid-2">
        <Section flush title="Batches" desc="Each batch is approved by the threshold separately." testid="batches">
          <Table
            cols={[{ label: "#" }, { label: "What", primary: true }, { label: "Status" }, { label: "Transaction" }]}
            rows={(batches.data ?? []).map((b) => ({
              key: b.id,
              cells: [
                b.batch_no + 1,
                <span className="batch-trail" data-testid={`batch-trail-${b.batch_no}`}>
                  {BATCH_KIND[b.kind] ?? b.kind}
                  <span className="cell-sub small muted">requested by {trail(b).requested}</span>
                  <span className="cell-sub small muted">{trail(b).approved.length ? `approved by ${trail(b).approved.join(", ")}` : "no signatures yet"}</span>
                </span>,
                <a href={`#/approve/${b.id}`} data-testid={`batch-${b.batch_no}`}><Badge s={b.status} /></a>,
                <Addr value={b.tx_hash} />,
              ],
            }))}
            empty="Not sent yet."
          />
        </Section>
        <Section title="Make it recurring" desc="A schedule creates a draft from this payout; sending works as always — after review and signatures.">
          <div className="row">
            <select className="input-inline" data-testid="every" value={every} onChange={(e) => setEvery(e.target.value as "month" | "week")}><option value="month">monthly</option><option value="week">weekly</option></select>
            <button className="secondary" data-testid="schedule" onClick={a.run(async () => {
              await call(auth.headers, "POST", `/orgs/${orgId}/schedules`, { title: receipt.data!.payout.title, templatePayoutId: id, every, firstRunAt: nextRun(every) });
              window.location.hash = `#/org/${orgId}/schedules`;
            })}>Create schedule</button>
          </div>
        </Section>
      </div>
    </>
  );
}

function nextRun(every: "month" | "week") {
  const d = new Date();
  if (every === "week") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

