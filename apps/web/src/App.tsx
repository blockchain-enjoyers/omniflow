import { useEffect, useState, type ReactNode } from "react";
import { PrivyProvider, usePrivy, useWallets } from "@privy-io/react-auth";
import type { Address, Hex } from "viem";
import { Operator } from "./Operator";
import { Approver } from "./Approver";
import { devSigner, signerFromProvider, type ApproverSigner } from "./signer";

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID;
const DEV = import.meta.env.DEV || import.meta.env.MODE === "e2e";

function PrivySigner({ onSigner }: { onSigner: (s: ApproverSigner | null) => void }) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  useEffect(() => {
    if (!embedded) return onSigner(null);
    embedded.getEthereumProvider().then((p) => signerFromProvider(p, embedded.address as Address)).then(onSigner);
  }, [embedded?.address]);
  if (!ready) return <span>…</span>;
  return authenticated ? <button onClick={logout}>Выйти</button> : <button onClick={login}>Войти (почта + passkey)</button>;
}

function DevSignerInput({ onSigner }: { onSigner: (s: ApproverSigner | null) => void }) {
  const [key, setKey] = useState("");
  return (
    <span>
      <input data-testid="dev-key" placeholder="dev: тестовый ключ подтверждающего" value={key} onChange={(e) => setKey(e.target.value.trim())} style={{ width: 360 }} />
      <button data-testid="dev-login" onClick={() => onSigner(devSigner(key as Hex))}>Войти ключом (dev)</button>
    </span>
  );
}

export function App() {
  const [tab, setTab] = useState<"operator" | "approver">("operator");
  const [signer, setSigner] = useState<ApproverSigner | null>(null);

  let login: ReactNode = null;
  if (PRIVY_APP_ID) login = <PrivySigner onSigner={setSigner} />;
  else if (DEV) login = <DevSignerInput onSigner={setSigner} />;

  const body = (
    <main>
      <h1>Omniflow</h1>
      <nav>
        <button className={tab === "operator" ? "active" : ""} onClick={() => setTab("operator")}>Выплаты</button>
        <button data-testid="tab-approver" className={tab === "approver" ? "active" : ""} onClick={() => setTab("approver")}>Подтверждение</button>
        {login}
      </nav>
      {tab === "operator" ? <Operator /> : <Approver signer={signer} />}
    </main>
  );

  return PRIVY_APP_ID ? (
    <PrivyProvider appId={PRIVY_APP_ID} config={{ embeddedWallets: { showWalletUIs: true, ethereum: { createOnLogin: "users-without-wallets" } }, loginMethods: ["email", "passkey"] }}>
      {body}
    </PrivyProvider>
  ) : (
    body
  );
}
