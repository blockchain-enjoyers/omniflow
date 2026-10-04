import { useState } from "react";
import { apiUrl, call, type FormType } from "../api";
import { Callout, Err, Section, useAction, useLoad } from "../ui";

interface View {
  org: string;
  name: string;
  received: { form: string; at: string } | null;
  forms: { type: FormType; label: string; revision: string }[];
}
const WHO: Record<FormType, string> = { w9: "I am a US person", w8ben: "I am an individual outside the US", w8bene: "I am a company outside the US" };

const toBase64 = (f: File) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => fail(new Error("could not read the file"));
    r.readAsDataURL(f);
  });

/** The recipient's tax form: shown only when the payer asked for one (the link exists only then). Public — the link is the capability. */
export function TaxFormPage({ token }: { token: string }) {
  const view = useLoad(() => call<View>(null, "GET", `/tax-forms/${token}`), [token]);
  const [type, setType] = useState<FormType | null>(null);
  const [done, setDone] = useState<{ form: string; receivedAt: string } | null>(null);
  const a = useAction();
  const v = view.data;
  const chosen = v?.forms.find((f) => f.type === type);
  const received = done ? { form: done.form, at: done.receivedAt } : v?.received;
  return (
    <>
      <div className="page-head"><div><div className="hint">Step 2 of 2</div><h1>Your tax form</h1></div></div>
      <Section testid="tax-form">
        {v && (
          <>
            <p><b>{v.org}</b> needs a form from you before this payment can be reported.</p>
            {received ? (
              <Callout tone="ok" testid="tax-form-done">Your {received.form} was sent to {v.org} on {received.at}. Nothing else is needed from you.</Callout>
            ) : (
              <>
                <p style={{ marginBottom: 8 }}>Which one applies to you?</p>
                <div className="stack" role="radiogroup" aria-label="tax form">
                  {v.forms.map((f) => (
                    <label key={f.type} className="choice">
                      <input type="radio" name="tax-form" data-testid={`tax-form-${f.type}`} checked={type === f.type} onChange={() => setType(f.type)} />
                      <span>{WHO[f.type]}</span>
                      <span className="mono small muted">{f.label}</span>
                    </label>
                  ))}
                </div>
                <div className="tax-actions">
                  <a className={`btn secondary${chosen ? "" : " disabled"}`} aria-disabled={!chosen} data-testid="tax-form-blank" href={chosen ? `${apiUrl()}/tax-forms/blank/${chosen.type}` : undefined} download>Download the blank form</a>
                  {chosen && <p className="hint small" data-testid="tax-form-revision">This is the official IRS form, Rev. {chosen.revision}. We do not fill it for you and we do not check it.</p>}
                  <label className={`btn${chosen && !a.busy ? "" : " disabled"}`} data-testid="tax-form-upload-label">
                    Upload the signed form
                    <input
                      type="file"
                      accept="application/pdf,.pdf"
                      hidden
                      data-testid="tax-form-upload"
                      disabled={!chosen || a.busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f && chosen) void a.run(async () => setDone(await call(null, "POST", `/tax-forms/${token}`, { type: chosen.type, filename: f.name, contentBase64: await toBase64(f) })))();
                      }}
                    />
                  </label>
                </div>
              </>
            )}
          </>
        )}
        <Err e={view.error || a.error} />
      </Section>
    </>
  );
}
