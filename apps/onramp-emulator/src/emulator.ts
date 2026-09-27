import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { mintToken } from "@omniflow/devchain";

/**
 * EMULATOR of an on-ramp partner widget (partner not chosen). Not a payment system: "paying" credits
 * test USDC on the local chain. The fee shown is a placeholder, not any partner's terms.
 */
export interface OnrampEmulatorConfig {
  publicUrl: string;
  rpcUrl: string;
  token: Address;
  decimals: number;
  feePercent: number;
}

interface Session {
  id: string;
  address: Address;
  fiatAmount: number;
  currency: string;
  status: "created" | "completed";
  cryptoAmount: string;
  returnUrl?: string;
}

export function onrampEmulator(cfg: OnrampEmulatorConfig) {
  const sessions = new Map<string, Session>();
  const r = express.Router();
  r.use(cors({ origin: true }));
  r.use(express.json());
  r.use(express.urlencoded({ extended: false }));

  r.post("/sessions", (req, res) => {
    const { address, fiatAmount, currency, returnUrl } = req.body ?? {};
    if (!isAddress(address) || !(Number(fiatAmount) > 0)) return res.status(400).json({ error: "address and fiatAmount required" });
    const net = Number(fiatAmount) * (1 - cfg.feePercent / 100);
    const s: Session = { id: randomUUID(), address: getAddress(address), fiatAmount: Number(fiatAmount), currency: currency ?? "USD", status: "created", cryptoAmount: net.toFixed(2), returnUrl };
    sessions.set(s.id, s);
    res.json({ id: s.id, url: `${cfg.publicUrl.replace(/\/$/, "")}/widget/${s.id}` });
  });

  r.get("/sessions/:id", (req, res) => {
    const s = sessions.get(req.params.id);
    return s ? res.json(s) : res.status(404).json({ error: "not found" });
  });

  r.get("/widget/:id", (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).send("not found");
    const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Buy USDC — emulator</title>
<style>body{font-family:system-ui;max-width:460px;margin:40px auto;padding:0 16px}.b{border:1px dashed #c60;padding:8px;color:#c60}button{padding:10px 16px}</style></head><body>
<p class="b">ON-RAMP PARTNER EMULATOR. No real partner is chosen yet. No payment happens — test USDC is credited on the local chain.</p>
<h1>Buy ${esc(s.cryptoAmount)} USDC</h1>
<p>You pay: ${s.fiatAmount} ${esc(s.currency)} · fee ${cfg.feePercent}% (placeholder)</p>
<p>Destination: <code data-testid="dest">${esc(s.address)}</code><br><small>Check that this is your organization account address.</small></p>
${s.status === "completed" ? `<p data-testid="done">Done: ${esc(s.cryptoAmount)} USDC credited.</p>${s.returnUrl ? `<p><a href="${esc(s.returnUrl)}">Back</a></p>` : ""}` : `<form method="post" action="/sessions/${s.id}/pay"><button data-testid="pay">Pay by card (emulated)</button></form>`}
</body></html>`);
  });

  r.post("/sessions/:id/pay", async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: "not found" });
    if (s.status !== "completed") {
      await mintToken(cfg.rpcUrl, cfg.token, s.address, parseUnits(s.cryptoAmount, cfg.decimals));
      s.status = "completed";
    }
    if (req.is("application/json")) return res.json(s);
    res.redirect(303, `/widget/${s.id}`);
  });
  return r;
}
