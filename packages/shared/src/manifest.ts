import type { Address, Hex } from "viem";

/** What the recipient has at payout time. `profile` behaves like `eoa` until the receiver side exists. */
export type RecipientKind = "none" | "eoa" | "profile";

/** One line of a payout: a person, not an address. */
export interface PayoutRow {
  rowId: string;
  name: string;
  email?: string;
  address?: Address;
  /** chain the recipient asked for; only the payout chain is paid */
  chainId: number;
  /** token base units */
  amount: bigint;
  /** accounting category for reports */
  category?: string;
}

/** A row frozen into a batch — everything needed to rebuild calldata byte for byte. */
export type FrozenRow =
  | { kind: "transfer"; rowId: string; to: Address; amount: bigint }
  | {
      kind: "escrow";
      rowId: string;
      depositId: Hex;
      claimSigner: Address;
      amount: bigint;
      tip: bigint;
      autoRefundAt: number;
    }
  | { kind: "refund"; rowId: string; depositId: Hex; amount: bigint };

/**
 * The payout manifest of one batch: the exact content approvers sign (via callDataAndNonceHash).
 * Rebuilding calldata from it must give the same bytes — `buildBatchCallData`.
 */
export interface BatchManifest {
  version: 1;
  chainId: number;
  account: Address;
  escrow: Address;
  token: Address;
  payoutId: string;
  batchNo: number;
  nonce: bigint;
  rows: FrozenRow[];
}
