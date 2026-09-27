import { useState } from "react";
import { isAddress } from "viem";
import { call } from "../api";
import { Err, Section, usdc, useAction, useLoad } from "../ui";

/** the recipient fills in where to be paid. Public — the link is the capability. Not a payment link. */
export function FormPage({ token }: { token: string }) {
  const view = useLoad(() => call<{ org: string; name: string; amount: string; chainId: number; filled: boolean; locked: boolean }>(null, "GET", `/forms/${token}`), [token]);
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  const a = useAction();
  const v = view.data;
  return (
    <Section title="Куда вам платить" testid="form">
      {v && (
        <>
          <p><b>{v.org}</b> собирается отправить вам, {v.name}, <b>{usdc(v.amount)}</b>.</p>
          <p className="hint">Это не платёж и не ссылка на получение денег. Никто не попросит у вас сид-фразу или подпись.</p>
          {v.locked ? (
            <p data-testid="form-locked">Платёж уже в обработке — реквизиты изменить нельзя.</p>
          ) : done ? (
            <p data-testid="form-done">Спасибо. Отправитель увидит реквизиты и отправит платёж после проверки.</p>
          ) : (
            <>
              <label>Адрес кошелька в сети {v.chainId} <input data-testid="form-address" value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="0x…" /></label>
              <p className="hint">Если адреса нет — оставьте почту, придёт ссылка на получение.</p>
              <label>Почта <input data-testid="form-email" value={email} onChange={(e) => setEmail(e.target.value.trim())} /></label>
              {address && !isAddress(address) && <p className="warn">Адрес выглядит неверно.</p>}
              <button data-testid="form-submit" disabled={a.busy || (!address && !email)} onClick={a.run(async () => { await call(null, "POST", `/forms/${token}`, { address: address || undefined, email: email || undefined }); setDone(true); })}>Отправить</button>
            </>
          )}
        </>
      )}
      <Err e={view.error || a.error} />
    </Section>
  );
}
