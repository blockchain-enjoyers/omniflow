import { Fragment, useState } from "react";
import { useAuth } from "@omniflow/auth-client";
import { call, downloadBinary, FORM_LABEL, type FormType, type RecordLine, type RecordView, type RowDocuments } from "../api";
import { CONFIG, MODE } from "../mode";
import { Err, Section, toast, useAction, useLoad } from "../ui";

const Value = ({ v }: { v: RecordLine["values"][number] }) => (
  <span className={`rec-v${v.mono ? " mono small" : ""}${v.note ? " hint small" : ""}`}>{v.strong ? <b>{v.text}</b> : v.text}</span>
);

/** The record of one payment: the same lines as the PDF, plus the documents around it. */
export function RecordPage({ payoutId, row }: { payoutId: string; row: string }) {
  const auth = useAuth();
  const rec = useLoad(() => call<RecordView>(auth.headers, "GET", `/payouts/${payoutId}/rows/${row}/record.json`), [payoutId, row]);
  const a = useAction();
  const r = rec.data;
  const i = r ? r.lines.findIndex((l) => l.label === "How it reached the recipient") : -1;
  return (
    <>
      <a className="back" href={`#/payout/${payoutId}`}>← Payout</a>
      <Section testid="record">
        {r && (
          <>
            <div className="rec-head"><span className="rec-brand">Omniflow</span><span>Payment record</span></div>
            <h1 className="rec-title" data-testid="record-title">{r.title}</h1>
            <p className="hint" style={{ marginTop: 2 }}>{r.sub}</p>
            <dl className="kv" data-testid="record-lines">
              {r.lines.map((l, n) => (
                <Fragment key={l.label}>
                  <dt>{l.label}</dt>
                  <dd>{l.values.map((v, k) => <Value key={k} v={v} />)}</dd>
                  {n === i && <Documents payoutId={payoutId} row={row} rowId={r.rowId} d={r.documents} onChange={rec.reload} />}
                </Fragment>
              ))}
            </dl>
            <p className="hint small" style={{ marginTop: 18 }}>{r.footer}</p>
          </>
        )}
        <Err e={rec.error || a.error} />
      </Section>
    </>
  );
}

function Documents({ payoutId, row, rowId, d, onChange }: { payoutId: string; row: string; rowId: string; d: RowDocuments; onChange: () => unknown }) {
  const auth = useAuth();
  const a = useAction();
  const [asking, setAsking] = useState(false);
  const [type, setType] = useState<FormType>(d.required === "none" ? "w9" : d.required);
  const onFile =
    d.status === "received" ? `${d.label} · received ${d.receivedAt}` : d.status === "requested" ? `Requested ${d.requestedAt}` : "None";
  return (
    <>
      <dt className="docs-label">Documents</dt>
      <dd className="docs" data-testid="documents">
        <div className="doc-row">
          <span className="doc-k">Form on file</span>
          <span className="doc-v">
            <span data-testid="form-on-file">{onFile}</span>
            {/* the file went to the payer by email; Omniflow does not keep it */}
            {d.status === "received" && <span className="hint small doc-sub" data-testid="form-sent-to">Sent to {d.destination} by email</span>}
          </span>
          <span className="doc-a">
            {d.status === "received" ? (
              // the demo mailbox keeps the copy the finance email got: there it opens here
              MODE === "demo" && d.hash ? (
                <a className="btn secondary sm" data-testid="form-download" href={`${CONFIG.demo.api.replace(/\/$/, "")}/dev/forms/${d.hash}`} title="The copy that reached the finance email (demo mailbox)">Download form</a>
              ) : null
            ) : !asking ? (
              <button className="secondary sm" data-testid="request-form" disabled={!d.canRequest.ok} title={d.canRequest.reason} onClick={() => setAsking(true)}>Request a form</button>
            ) : (
              <span className="row">
                <select className="input-inline" data-testid="request-type" value={type} onChange={(e) => setType(e.target.value as FormType)}>
                  {(Object.keys(FORM_LABEL) as FormType[]).map((k) => <option key={k} value={k}>{FORM_LABEL[k]}</option>)}
                </select>
                <button className="sm" data-testid="request-send" disabled={a.busy} onClick={a.run(async () => { await call(auth.headers, "POST", `/payouts/${payoutId}/rows/${row}/document-request`, { type }); setAsking(false); toast("Request sent to the recipient"); await onChange(); })}>Send</button>
              </span>
            )}
          </span>
        </div>
        {!d.canRequest.ok && d.status === "none" && <p className="hint small" data-testid="request-why" style={{ margin: "2px 0 6px" }}>{d.canRequest.reason}</p>}
        <div className="doc-row">
          <span className="doc-k">This payment</span>
          <span className="doc-v">Payment record</span>
          <span className="doc-a">
            <button className="secondary sm" data-testid="record-pdf" disabled={a.busy} onClick={a.run(() => downloadBinary(auth.headers, `/payments/${rowId}/record.pdf`, `payment-record-${rowId}.pdf`))}>Download PDF</button>
          </span>
        </div>
        <p className="hint small" style={{ margin: "6px 0 0" }}>You choose what a payment needs. We do not give tax advice.</p>
        <Err e={a.error} />
      </dd>
    </>
  );
}
