import { describe, expect, it } from "vitest";
import { normalizeAmount, parsePayoutCsv } from "../src/payouts/csv.js";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const CHAIN = 42161;
const parse = (t: string) => parsePayoutCsv(t, 6, CHAIN);

describe("CSV import as people export it", () => {
  it("the original strict format still works", () => {
    const r = parse(`name,email,address,chain_id,amount,category\nAlice,,${A},42161,1000,grants`);
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ name: "Alice", address: A, chainId: 42161, amount: 1_000_000_000n, category: "grants", line: 2 });
  });

  it("Excel: BOM, semicolons, CRLF, decimal comma, columns in another order, no chain_id", () => {
    const r = parse(`﻿Amount;Wallet;Name;Email\r\n1 500,50;${A};Alice;\r\n25;;Bob;bob@example.com\r\n`);
    expect(r.delimiter).toBe(";");
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.name, x.amount, x.chainId])).toEqual([["Alice", 1_500_500_000n, CHAIN], ["Bob", 25_000_000n, CHAIN]]);
    expect(r.rows[1]!.email).toBe("bob@example.com");
  });

  it("cells copied from Google Sheets are tab-separated", () => {
    const r = parse(`Name\tAmount\tAddress\nAlice\t$1,000.00\t${A}`);
    expect(r.delimiter).toBe("\t");
    expect(r.rows[0]!.amount).toBe(1_000_000_000n);
  });

  it("quoted cells keep commas, quotes and line breaks", () => {
    const r = parse(`name,amount,category\n"Smith, John",10,"multi\nline ""note"""`);
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ name: "Smith, John", category: 'multi\nline "note"' });
  });

  it("unknown columns are ignored with a warning; blank lines are skipped", () => {
    const r = parse(`name,amount,notes internal,address\n\nAlice,5,xyz,${A}\n,,,\n`);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.warnings.map((w) => w.message)).toContain('column "notes internal" is not used');
  });

  it("each bad row is reported with its line; good rows are still parsed", () => {
    const r = parse(`name,amount,address,email\nAlice,10,0x123,\n,5,,\nBob,-3,,\nCarol,abc,,\nDave,1,vitalik.eth,\nEve,1,,not-an-email\nFrank,1.1234567,,`);
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([
      [2, "address"], [3, "name"], [4, "amount"], [5, "amount"], [6, "address"], [7, "email"], [8, "amount"],
    ]);
    expect(r.errors.find((e) => e.line === 6)!.message).toMatch(/ENS/);
  });

  it("a missing header is explained, not a raw error", () => {
    const r = parse(`Alice,10,${A}`);
    expect(r.errors[0]!.message).toMatch(/missing: name, amount/);
  });

  it("chain can be named; a row for another chain is kept (the review shows it will not be sent)", () => {
    const r = parse(`name,amount,chain\nAlice,1,Arbitrum One\nBob,1,1\nCarol,1,solana`);
    expect(r.rows.map((x) => x.chainId)).toEqual([42161, 1]);
    expect(r.errors[0]).toMatchObject({ line: 4, column: "chain_id" });
  });
});

describe("amounts are never guessed", () => {
  it.each([
    ["1500", "1500"], ["1500.5", "1500.5"], ["1500,5", "1500.5"], ["1,500.50", "1500.50"], ["1.500,50", "1500.50"],
    ["1 500,50", "1500.50"], ["1,000,000", "1000000"], ["$25", "25"], ["25 USDC", "25"], ["0,75", "0.75"], [".5", "0.5"],
  ])("%s → %s", (raw, want) => {
    expect(normalizeAmount(raw)).toEqual({ value: want });
  });
  it.each(["1,500", "1.500", "1,50,0", "12a", "", "-5", "1.2.3"])("%s is refused", (raw) => {
    expect("error" in normalizeAmount(raw)).toBe(true);
  });
});
