import { getAddress, isAddress, parseUnits, type Address } from "viem";
import type { PayoutRow } from "@omniflow/shared";

/**
 * Payout rows from a spreadsheet, as people actually export them (Excel, Google Sheets, Numbers, copy-paste):
 * - separator: comma, semicolon (Excel in many locales) or tab (cells copied from a sheet) — detected from the header;
 * - quoted cells with separators, quotes and line breaks inside; a UTF-8 BOM at the start;
 * - columns by name in any order, with common aliases; unknown columns are ignored with a warning;
 * - `chain_id` is optional — the organisation's chain by default;
 * - amounts like "1500", "1,500.50", "1 500,50", "$25"; an ambiguous "1,500" is refused rather than guessed.
 * Money is never guessed: anything unclear becomes a problem on that line, and nothing is created until it is fixed.
 */
export interface CsvProblem {
  line: number;
  column?: string;
  message: string;
}

export type Field = "name" | "email" | "address" | "amount" | "chain_id" | "category";

const ALIASES: Record<Field, string[]> = {
  name: ["name", "recipient", "recipient name", "full name", "fullname", "payee", "contributor", "person", "имя", "получатель", "фио"],
  email: ["email", "e-mail", "mail", "email address", "почта", "e-mail address"],
  address: ["address", "wallet", "wallet address", "recipient address", "eth address", "evm address", "адрес", "кошелек", "кошелёк", "адрес кошелька"],
  amount: ["amount", "usdc", "amount (usdc)", "amount usdc", "amount, usdc", "sum", "value", "payment", "pay", "сумма"],
  chain_id: ["chain_id", "chain id", "chainid", "chain", "network", "сеть"],
  category: ["category", "tag", "memo", "note", "purpose", "категория"],
};
const CHAIN_NAMES: Record<string, number> = { arbitrum: 42161, "arbitrum one": 42161, "arbitrum sepolia": 421614 };
const MAX_ROWS = 5000;

export interface CsvResult {
  rows: (PayoutRow & { line: number })[];
  errors: CsvProblem[];
  warnings: CsvProblem[];
  columns: Partial<Record<Field, string>>;
  delimiter: "," | ";" | "\t";
}

const norm = (h: string) => h.replace(/^﻿/, "").trim().replace(/^"|"$/g, "").trim().toLowerCase().replace(/\s+/g, " ");

/** RFC 4180 records with their starting line numbers. */
function records(text: string, delim: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (c === delim) {
      cells.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cells.push(cell);
      out.push({ line: start, cells });
      cells = [];
      cell = "";
      line++;
      start = line;
    } else cell += c;
  }
  if (cell !== "" || cells.length) {
    cells.push(cell);
    out.push({ line: start, cells });
  }
  return out.filter((r) => r.cells.some((x) => x.trim() !== ""));
}

function detectDelimiter(firstLine: string): "," | ";" | "\t" {
  const count = (d: string) => firstLine.split(d).length - 1;
  const c = [["\t", count("\t")], [";", count(";")], [",", count(",")]] as const;
  const best = [...c].sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? (best[0] as "," | ";" | "\t") : ",";
}

/**
 * "1500", "1,500.50", "1.500,50", "1 500,5", "$25", "25 USDC" → a plain decimal string, or an explanation.
 * A single comma or dot followed by exactly three digits ("1,500", "1.500") could be thousands or decimals: refused.
 */
export function normalizeAmount(raw: string): { value: string } | { error: string } {
  let s = raw.replace(/[\s   ]/g, "").replace(/^(US)?\$|USDC$|\$$/gi, "").replace(/^\+/, "");
  if (s === "") return { error: "amount is empty" };
  if (s.startsWith("-")) return { error: "amount must be positive" };
  if (!/^[0-9.,]+$/.test(s)) return { error: `"${raw.trim()}" is not an amount` };
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const commas = s.split(",").length - 1;
  const dots = s.split(".").length - 1;
  const grouped = (intPart: string, sep: string) => new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(intPart);
  if (commas && dots) {
    const [dec, thou] = lastComma > lastDot ? [",", "."] : [".", ","];
    const [intPart, frac] = [s.slice(0, s.lastIndexOf(dec)), s.slice(s.lastIndexOf(dec) + 1)];
    if (!grouped(intPart, thou) || intPart.includes(dec)) return { error: `"${raw.trim()}" mixes separators in a way that is unclear` };
    s = `${intPart.split(thou).join("")}.${frac}`;
  } else if (commas || dots) {
    const sep = commas ? "," : ".";
    const n = commas || dots;
    const parts = s.split(sep);
    if (n === 1) {
      if (parts[1]!.length === 3 && parts[0] !== "0" && parts[0] !== "") return { error: `"${raw.trim()}" is ambiguous — write 1500 or 1.5` };
      s = `${parts[0] || "0"}.${parts[1]}`;
    } else {
      if (!grouped(s, sep)) return { error: `"${raw.trim()}" is not an amount` };
      s = parts.join("");
    }
  }
  return { value: s };
}

export interface RowInput {
  name?: string;
  email?: string;
  address?: string;
  amount?: string;
  chain?: string;
  category?: string;
}

/** One row, from a file or typed by hand: the same rules either way. */
export function validateRow(r: RowInput, line: number, decimals: number, defaultChainId: number): { row?: PayoutRow & { line: number }; errors: CsvProblem[] } {
  const errors: CsvProblem[] = [];
  const name = (r.name ?? "").trim();
  const email = (r.email ?? "").trim();
  const address = (r.address ?? "").trim();
  if (!name) errors.push({ line, column: "name", message: "name is required" });
  if (address && /\.eth$/i.test(address)) errors.push({ line, column: "address", message: `"${address}" is an ENS name — use the 0x address` });
  else if (address && !isAddress(address, { strict: false })) errors.push({ line, column: "address", message: `"${address}" is not a wallet address` });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push({ line, column: "email", message: `"${email}" is not an email address` });
  let chainId = defaultChainId;
  const chain = (r.chain ?? "").trim();
  if (chain) {
    const n = /^\d+$/.test(chain) ? Number(chain) : CHAIN_NAMES[chain.toLowerCase()];
    if (!n) errors.push({ line, column: "chain_id", message: `"${chain}" is not a known chain` });
    else chainId = n;
  }
  let amount = 0n;
  const a = normalizeAmount(r.amount ?? "");
  if ("error" in a) errors.push({ line, column: "amount", message: a.error });
  else {
    const frac = a.value.split(".")[1] ?? "";
    if (frac.length > decimals) errors.push({ line, column: "amount", message: `"${r.amount?.trim()}" has more than ${decimals} decimal places` });
    else {
      amount = parseUnits(a.value, decimals);
      if (amount <= 0n) errors.push({ line, column: "amount", message: "amount must be more than 0" });
    }
  }
  if (errors.length) return { errors };
  return {
    errors,
    row: {
      line,
      rowId: `row-${line}`,
      name,
      email: email ? email.toLowerCase() : undefined,
      address: address ? (getAddress(address) as Address) : undefined,
      chainId,
      amount,
      category: (r.category ?? "").trim() || undefined,
    },
  };
}

export function parsePayoutCsv(text: string, decimals: number, defaultChainId: number): CsvResult {
  const clean = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(clean.split(/\r?\n/, 1)[0] ?? "");
  const recs = records(clean, delimiter);
  const errors: CsvProblem[] = [];
  const warnings: CsvProblem[] = [];
  const rows: CsvResult["rows"] = [];
  const header = recs.shift();
  if (!header) return { rows, errors: [{ line: 1, message: "the file is empty" }], warnings, columns: {}, delimiter };

  const columns: Partial<Record<Field, string>> = {};
  const index: Partial<Record<Field, number>> = {};
  header.cells.forEach((h, i) => {
    const n = norm(h);
    const field = (Object.keys(ALIASES) as Field[]).find((f) => ALIASES[f].includes(n));
    if (field && index[field] === undefined) {
      index[field] = i;
      columns[field] = h.trim();
    } else if (n) warnings.push({ line: 1, column: h.trim(), message: `column "${h.trim()}" is not used` });
  });
  const missing = (["name", "amount"] as Field[]).filter((f) => index[f] === undefined);
  if (missing.length) {
    return {
      rows,
      errors: [{ line: 1, message: `the first line must name the columns; missing: ${missing.join(", ")}. Expected columns: name, amount, and address or email (optional: category, chain_id)` }],
      warnings,
      columns,
      delimiter,
    };
  }
  if (index.address === undefined && index.email === undefined) warnings.push({ line: 1, message: "no address or email column — every row will wait for payment details" });
  if (recs.length > MAX_ROWS) return { rows, errors: [{ line: 1, message: `too many rows: ${recs.length} (at most ${MAX_ROWS} per payout)` }], warnings, columns, delimiter };

  const cell = (r: string[], f: Field) => (index[f] === undefined ? undefined : r[index[f]!]);
  for (const r of recs) {
    const v = validateRow(
      { name: cell(r.cells, "name"), email: cell(r.cells, "email"), address: cell(r.cells, "address"), amount: cell(r.cells, "amount"), chain: cell(r.cells, "chain_id"), category: cell(r.cells, "category") },
      r.line,
      decimals,
      defaultChainId,
    );
    errors.push(...v.errors);
    if (v.row) rows.push(v.row);
  }
  if (!recs.length) errors.push({ line: 2, message: "there are no rows under the header" });
  return { rows, errors, warnings, columns, delimiter };
}
