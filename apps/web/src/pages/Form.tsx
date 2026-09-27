import { useState } from "react";
import { isAddress } from "viem";
import { call } from "../api";
import { Callout, chainName, Err, Field, Section, usdc, useAction, useLoad } from "../ui";

/** the recipient fills in where to be paid. Public — the link is the capability. Not a payment link. */
export function FormPage({ token }: { token: string }) {
  const view = useLoad(() => call<{ org: string; name: string; amount: string; chainId: number; filled: boolean; locked: boolean }>(null, "GET", `/forms/${token}`), [token]);
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const a = useAction();
  const v = view.data;
  return (
    <>
      <div className="page-head"><div><h1>Where should we pay you?</h1>{v && <div className="sub">{v.org} is about to send you a payment</div>}</div></div>
      <Section testid="form">
        {v && (
          <>
            <p className="hint" style={{ marginBottom: 2 }}>{v.name}, you are due</p>
            <div className="approve-total">{usdc(v.amount)}</div>
            <Callout>This is not a payment and not a link to receive money. Nobody will ever ask you for a seed phrase or a signature.</Callout>
            {v.locked ? (
              <Callout tone="info" testid="form-locked">The payment is already being processed — details can no longer be changed.</Callout>
            ) : done ? (
              <Callout tone="ok" testid="form-done">Thank you. The sender will see your details and send the payment after review.</Callout>
            ) : (
              <>
                <Field label={`Wallet address, ${chainName(v.chainId)}`}>
                  <input className="mono" data-testid="form-address" value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="0x…" />
                </Field>
                {address && !isAddress(address) && <p className="error" style={{ marginTop: -8 }}>This address does not look right.</p>}
                <Field label="Or email" help="No wallet? You will receive a claim link.">
                  <input type="email" data-testid="form-email" value={email} onChange={(e) => setEmail(e.target.value.trim())} />
                </Field>
                <div className="actions">
                  <button className="block" data-testid="form-submit" disabled={a.busy || (!address && !email)} onClick={a.run(async () => { await call(null, "POST", `/forms/${token}`, { address: address || undefined, email: email || undefined }); setDone(true); })}>Submit</button>
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
