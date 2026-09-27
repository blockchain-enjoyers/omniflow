import { getAddress, isAddress, parseUnits, type Address } from "viem";
import type { PayoutRow } from "@omniflow/shared";

export interface CsvError {
  line: number;
  message: string;
}

/**
 * CSV: name,email,address,chain_id,amount[,category] — header required, amount in token units (e.g. "1500.50").
 * A row may lack address or email; the review screen reports what cannot be sent.
 */
export function parsePayoutCsv(text: string, decimals: number): { rows: PayoutRow[]; errors: CsvError[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const errors: CsvError[] = [];
  const rows: PayoutRow[] = [];
  const header = (lines.shift() ?? "").split(",").map((h) => h.trim().toLowerCase());
  const need = ["name", "email", "address", "chain_id", "amount"];
  if (need.some((h, i) => header[i] !== h)) {
    return { rows, errors: [{ line: 1, message: `header must be: ${need.join(",")}` }] };
  }
  lines.forEach((l, i) => {
    const line = i + 2;
    const [name, email, address, chainId, amount, category] = l.split(",").map((c) => c.trim());
    if (!name) return errors.push({ line, message: "name is required" });
    if (address && !isAddress(address)) return errors.push({ line, message: "invalid address" });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return errors.push({ line, message: "invalid email" });
    const cid = Number(chainId);
    if (!Number.isInteger(cid) || cid <= 0) return errors.push({ line, message: "invalid chain_id" });
    let units: bigint;
    try {
      units = parseUnits(amount ?? "", decimals);
    } catch {
      return errors.push({ line, message: "invalid amount" });
    }
    if (units <= 0n) return errors.push({ line, message: "amount must be positive" });
    rows.push({
      rowId: `row-${line}`,
      name,
      email: email || undefined,
      address: address ? (getAddress(address) as Address) : undefined,
      chainId: cid,
      amount: units,
      category: header[5] === "category" && category ? category : undefined,
    });
  });
  return { rows, errors };
}
