import { getAddress, type Address } from "viem";
import type { PayoutRow } from "./manifest.js";

/** Why a row will not go out in this payout. */
export type NotSentReason = "no-address-no-email" | "other-chain";

export interface ReviewSummary {
  rows: number;
  total: bigint;
  toAddress: number;
  byEmail: number;
  newRecipients: PayoutRow[];
  changedAmount: { row: PayoutRow; previous: bigint }[];
  duplicateAddress: PayoutRow[][];
  duplicateEmail: PayoutRow[][];
  outliers: { row: PayoutRow; previous: bigint }[];
  notSent: { row: PayoutRow; reason: NotSentReason }[];
  balanceSufficient: boolean;
}

export interface ReviewInput {
  rows: PayoutRow[];
  payoutChainId: number;
  /** last amount paid per recipient address in earlier payouts (from chain history or records) */
  previousAmountByAddress: Map<string, bigint>;
  balance: bigint;
  /** a row is an outlier if it differs from its own history by more than this factor */
  outlierFactor?: number;
}

const norm = (a: Address) => getAddress(a).toLowerCase();

/**
 * The review screen is a summary and a diff, not a table: what is new or changed, duplicates,
 * outliers, and what will not be sent at all.
 */
export function reviewPayout(input: ReviewInput): ReviewSummary {
  const factor = input.outlierFactor ?? 3;
  const s: ReviewSummary = {
    rows: input.rows.length,
    total: 0n,
    toAddress: 0,
    byEmail: 0,
    newRecipients: [],
    changedAmount: [],
    duplicateAddress: [],
    duplicateEmail: [],
    outliers: [],
    notSent: [],
    balanceSufficient: false,
  };
  const byAddr = new Map<string, PayoutRow[]>();
  const byMail = new Map<string, PayoutRow[]>();

  for (const row of input.rows) {
    if (row.chainId !== input.payoutChainId) {
      s.notSent.push({ row, reason: "other-chain" });
      continue;
    }
    if (!row.address && !row.email) {
      s.notSent.push({ row, reason: "no-address-no-email" });
      continue;
    }
    s.total += row.amount;
    if (row.address) {
      s.toAddress++;
      const key = norm(row.address);
      byAddr.set(key, [...(byAddr.get(key) ?? []), row]);
      const prev = input.previousAmountByAddress.get(key);
      if (prev === undefined) s.newRecipients.push(row);
      else if (prev !== row.amount) {
        s.changedAmount.push({ row, previous: prev });
        const hi = prev > row.amount ? prev : row.amount;
        const lo = prev > row.amount ? row.amount : prev;
        if (lo === 0n || hi > lo * BigInt(factor)) s.outliers.push({ row, previous: prev });
      }
    } else {
      s.byEmail++;
      s.newRecipients.push(row);
    }
    if (row.email) {
      const key = row.email.trim().toLowerCase();
      byMail.set(key, [...(byMail.get(key) ?? []), row]);
    }
  }
  s.duplicateAddress = [...byAddr.values()].filter((g) => g.length > 1);
  s.duplicateEmail = [...byMail.values()].filter((g) => g.length > 1);
  s.balanceSufficient = input.balance >= s.total;
  return s;
}
