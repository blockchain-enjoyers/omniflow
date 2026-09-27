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
      <div className="page-head"><div><h1>Куда вам платить</h1>{v && <div className="sub">{v.org} собирается отправить вам платёж</div>}</div></div>
      <Section testid="form">
        {v && (
          <>
            <p className="hint" style={{ marginBottom: 2 }}>{v.name}, вам причитается</p>
            <div className="approve-total">{usdc(v.amount)}</div>
            <Callout>Это не платёж и не ссылка на получение денег. Никто не попросит у вас сид-фразу или подпись.</Callout>
            {v.locked ? (
              <Callout tone="info" testid="form-locked">Платёж уже в обработке — реквизиты изменить нельзя.</Callout>
            ) : done ? (
              <Callout tone="ok" testid="form-done">Спасибо. Отправитель увидит реквизиты и отправит платёж после проверки.</Callout>
            ) : (
              <>
                <Field label={`Адрес кошелька, сеть ${chainName(v.chainId)}`}>
                  <input className="mono" data-testid="form-address" value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="0x…" />
                </Field>
                {address && !isAddress(address) && <p className="error" style={{ marginTop: -8 }}>Адрес выглядит неверно.</p>}
                <Field label="Или почта" help="Если кошелька нет — придёт ссылка на получение.">
                  <input type="email" data-testid="form-email" value={email} onChange={(e) => setEmail(e.target.value.trim())} />
                </Field>
                <div className="actions">
                  <button className="block" data-testid="form-submit" disabled={a.busy || (!address && !email)} onClick={a.run(async () => { await call(null, "POST", `/forms/${token}`, { address: address || undefined, email: email || undefined }); setDone(true); })}>Отправить</button>
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
