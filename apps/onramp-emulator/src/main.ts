import express from "express";
import { getAddress, type Address } from "viem";
import { onrampEmulator } from "./emulator.js";

const port = Number(process.env.PORT ?? 3020);
const app = express();
app.use(
  onrampEmulator({
    publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    token: getAddress(process.env.TOKEN!) as Address,
    decimals: Number(process.env.TOKEN_DECIMALS ?? 6),
    feePercent: Number(process.env.FEE_PERCENT ?? 1.75),
  }),
);
app.listen(port, () => console.log(`on-ramp EMULATOR on :${port} (not a payment system)`));
