import express from "express";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { PrivyEmulator } from "./emulator.js";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emu = new PrivyEmulator(db, {
  appId: process.env.PRIVY_APP_ID ?? "emulated-app",
  walletEncryptionKey: process.env.EMU_WALLET_KEY ?? randomBytes(32).toString("hex"),
});
await emu.init();
const app = express();
app.use(emu.router());
const port = Number(process.env.PORT ?? 3010);
app.listen(port, () => console.log(`privy EMULATOR on :${port} (not Privy)`));
