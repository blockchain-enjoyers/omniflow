import { useEffect, useRef, useState } from "react";
import { useAuth } from "@omniflow/auth-client";
import { call, type Org, type Preview, type Problem } from "../api";
import { Addr, Badge, Callout, chainName, Err, Field, Section, Table, toast, usdc, useLoad } from "../ui";

type Method = "file" | "paste" | "manual";
interface ManualRow { name: string; dest: string; amount: string; category: string }
const emptyRow = (): ManualRow => ({ name: "", dest: "", amount: "", category: "" });

const TEMPLATE = "name,address,email,amount,category\nAlice,0x1111111111111111111111111111111111111111,,1000,grants\nBob,,bob@example.com,250.50,contractors\n";

/** Manual rows → what the API validates. A destination with "@" is an email, otherwise an address. */
const toRows = (rows: ManualRow[]) =>
  rows
    .filter((r) => r.name || r.dest || r.amount)
    .map((r) => ({ name: r.name, amount: r.amount, category: r.category, ...(r.dest.includes("@") ? { email: r.dest } : { address: r.dest }) }));

/**
 * A new payout: a title, the recipients (a file, cells pasted from a spreadsheet, or typed), and a live preview that
 * says line by line what is wrong before anything is created.
 */
export function NewPayout({ orgId }: { orgId: string }) {
  const auth = useAuth();
  const org = useLoad(() => call<Org>(auth.headers, "GET", `/orgs/${orgId}`), [orgId]);
  const bal = useLoad(() => call<{ balance: string }>(auth.headers, "GET", `/orgs/${orgId}/balance`), [orgId]);
  const [title, setTitle] = useState("");
  const [method, setMethod] = useState<Method>("file");
  const [fileName, setFileName] = useState("");
  const [fileText, setFileText] = useState("");
  const [paste, setPaste] = useState("");
  const [manual, setManual] = useState<ManualRow[]>([emptyRow(), emptyRow()]);
  const [refund, setRefund] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const body = method === "manual" ? { rows: toRows(manual) } : { csv: method === "file" ? fileText : paste };
  const empty = method === "manual" ? toRows(manual).length === 0 : !(method === "file" ? fileText : paste).trim();
  const key = JSON.stringify(body);

  // live preview, a moment after the last change
  useEffect(() => {
    if (empty) {
      setPreview(null);
      setPreviewErr("");
      return;
    }
    const t = setTimeout(async () => {
      try {
        setPreview(await call<Preview>(auth.headers, "POST", `/orgs/${orgId}/payouts/preview`, body));
        setPreviewErr("");
      } catch (e) {
        setPreviewErr((e as Error).message);
      }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, empty]);

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    if (/\.xlsx?$/i.test(f.name)) {
      setFileName(f.name);
      setFileText("");
      setErr("Excel files are not read directly yet: in Excel choose File → Save As → CSV, then upload that file.");
      return;
    }
    setErr("");
    setFileName(f.name);
    setFileText(await f.text());
  };

  const problems: Problem[] = preview?.errors ?? [];
  const sendable = preview ? preview.rows.filter((r) => r.status !== "other_chain").length : 0;
  const reason = !title.trim() ? "Give the payout a title" : empty ? "Add recipients" : !preview ? "Checking…" : problems.length ? `Fix ${problems.length} problem${problems.length > 1 ? "s" : ""} below` : preview.rows.length === 0 ? "No rows found" : "";
  const insufficient = preview && bal.data && BigInt(preview.total) > BigInt(bal.data.balance);

  const create = async () => {
    setTried(true);
    if (reason) return;
    setBusy(true);
    setErr("");
    try {
      const p = await call<{ id: string }>(auth.headers, "POST", `/orgs/${orgId}/payouts`, { title: title.trim(), ...body, ...(refund ? { autoRefundDays: Number(refund) } : {}) });
      toast("Payout created — review it and send for approval");
      window.location.hash = `#/payout/${p.id}`;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const o = org.data;
  return (
    <div className="narrow" style={{ maxWidth: 860 }}>
      <a className="back" href={`#/org/${orgId}`}>← {o?.name ?? "Organization"}</a>
      <div className="page-head"><div><h1>New payout</h1><div className="sub">Nothing is sent yet: after creating, you review it and send it to the approvers.</div></div></div>

      <Section testid="new-payout">
        <Field label="Title" help="For you and the approvers — e.g. “September grants”.">
          <input data-testid="np-title" value={title} maxLength={120} placeholder="September grants" onChange={(e) => setTitle(e.target.value)} aria-invalid={tried && !title.trim()} />
        </Field>
        {tried && !title.trim() && <p className="error" data-testid="np-title-error" style={{ marginTop: -8 }}>Give the payout a title.</p>}

        <h3>Recipients</h3>
        <div className="segmented" role="tablist">
          <button role="tab" className={method === "file" ? "on" : ""} data-testid="np-tab-file" onClick={() => setMethod("file")}><span className="hide-phone">Upload a file</span><span className="show-phone">File</span></button>
          <button role="tab" className={method === "paste" ? "on" : ""} data-testid="np-tab-paste" onClick={() => setMethod("paste")}><span className="hide-phone">Paste from a spreadsheet</span><span className="show-phone">Paste</span></button>
          <button role="tab" className={method === "manual" ? "on" : ""} data-testid="np-tab-manual" onClick={() => setMethod("manual")}>Type in</button>
        </div>

        {method === "file" && (
          <>
            <label
              className={`dropzone${over ? " over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); void readFile(e.dataTransfer.files[0]); }}
            >
              <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" data-testid="np-file" onChange={(e) => void readFile(e.target.files?.[0])} />
              <div className="big">{fileName ? fileName : "Drop a CSV file here or click to choose"}</div>
              <div className="hint">{fileName ? "Click to choose another file" : "Exported from Excel, Google Sheets or Numbers — columns in any order."}</div>
            </label>
            <p className="hint small" style={{ marginTop: 8 }}>
              Needed columns: <b>name</b>, <b>amount</b> (USDC), and <b>address</b> or <b>email</b>. Optional: category.{" "}
              <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="omniflow-payout-template.csv" data-testid="np-template">Download a template</a>
            </p>
          </>
        )}

        {method === "paste" && (
          <Field label="Rows with a header line" help="Copy the cells from your spreadsheet (including the header row) and paste them here.">
            <textarea data-testid="np-paste" value={paste} placeholder={"name\taddress\tamount\nAlice\t0x…\t1000\nBob\tbob@example.com\t250"} onChange={(e) => setPaste(e.target.value)} />
          </Field>
        )}

        {method === "manual" && (
          <div>
            {manual.map((r, i) => {
              const set = (p: Partial<ManualRow>) => setManual(manual.map((x, j) => (j === i ? { ...x, ...p } : x)));
              return (
                <div className="manual-row" key={i}>
                  <input aria-label="name" placeholder="Name" data-testid={`np-name-${i}`} value={r.name} onChange={(e) => set({ name: e.target.value })} />
                  <input aria-label="address or email" className="mono" placeholder="0x… address or email" data-testid={`np-dest-${i}`} value={r.dest} onChange={(e) => set({ dest: e.target.value.trim() })} />
                  <input aria-label="amount" placeholder="Amount" inputMode="decimal" data-testid={`np-amount-${i}`} value={r.amount} onChange={(e) => set({ amount: e.target.value })} />
                  <input aria-label="category" placeholder="Category" value={r.category} onChange={(e) => set({ category: e.target.value })} />
                  <button className="ghost" aria-label="remove row" onClick={() => setManual(manual.length > 1 ? manual.filter((_, j) => j !== i) : [emptyRow()])}>✕</button>
                </div>
              );
            })}
            <button className="secondary sm" data-testid="np-add-row" onClick={() => setManual([...manual, emptyRow()])}>+ Row</button>
            <p className="hint small" style={{ marginTop: 8 }}>Leave the address empty and add an email — the recipient gets a link to claim. Leave both empty — you can send them a form for their details later.</p>
          </div>
        )}
        <Err e={err} />
      </Section>

      {(preview || previewErr) && (
        <Section flush title="Preview" desc={o ? `On ${chainName(o.chain_id)}. Nothing is created until you press Create.` : undefined} testid="np-preview">
          <div style={{ padding: "0 20px" }}>
            {previewErr && <Callout tone="bad">{previewErr}</Callout>}
            {preview && (preview.rows.length > 0 || problems.length === 0) && (
              <div className="row" style={{ gap: 16, marginBottom: 12 }} data-testid="np-summary">
                <span><b>{preview.rows.length}</b> rows</span>
                <span><b>{usdc(preview.total)}</b> in total</span>
                <span className="hint">{preview.rows.filter((r) => r.status === "ready").length} ready · {preview.rows.filter((r) => r.status === "waiting_details").length} need details · {preview.rows.filter((r) => r.status === "other_chain").length} other chain</span>
              </div>
            )}
            {problems.length > 0 && (
              <Callout tone="bad" testid="np-errors">
                <b>{problems.length} problem{problems.length > 1 ? "s" : ""} to fix</b>
                <ul className="problems" style={{ marginTop: 8 }}>
                  {problems.slice(0, 50).map((p, i) => (
                    <li key={i}><span className="ln">{method === "manual" ? `row ${p.line}` : `line ${p.line}`}</span>{p.message}</li>
                  ))}
                </ul>
              </Callout>
            )}
            {preview?.warnings.map((w, i) => <p key={i} className="hint small">{w.message}</p>)}
            {insufficient && <Callout tone="warn">The account holds {usdc(bal.data!.balance)} — less than this payout. You can still create it and add funds before sending.</Callout>}
          </div>
          {preview && preview.rows.length > 0 && (
            <Table
              cols={[{ label: "Name", primary: true }, { label: "Paid to" }, { label: "Amount", className: "r" }, { label: "Status" }]}
              rows={preview.rows.slice(0, 100).map((r) => ({
                key: String(r.line),
                cells: [<span className="cell-main">{r.name}</span>, r.address ? <Addr value={r.address} /> : <span className="small">{r.email ?? "details later"}</span>, <span className="num">{usdc(r.amount)}</span>, <Badge s={r.status} />],
              }))}
            />
          )}
        </Section>
      )}

      <details className="card" style={{ marginTop: 16 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>More options</summary>
        <div style={{ marginTop: 12 }}>
          <Field label="Return unclaimed payments after, days" help={`Empty — as in settings: ${o?.auto_refund_days ?? "never"}.`}>
            <input className="w-amount" inputMode="numeric" value={refund} onChange={(e) => setRefund(e.target.value.replace(/\D/g, ""))} />
          </Field>
        </div>
      </details>

      <div className="sticky-foot">
        <span className="hint" data-testid="np-reason">{reason || (sendable ? `${sendable} row${sendable > 1 ? "s" : ""} ready to review` : "")}</span>
        <button data-testid="np-create" disabled={busy || (tried && Boolean(reason))} onClick={() => void create()}>Create payout</button>
      </div>
    </div>
  );
}
