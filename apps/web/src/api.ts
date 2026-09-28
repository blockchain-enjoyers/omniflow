import type { Hex } from "viem";

import { apiBase } from "./mode";

export type Headers = () => Promise<Record<string, string>>;

export async function call<T>(headers: Headers | null, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(headers ? await headers() : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j: unknown = text;
  try {
    j = JSON.parse(text);
  } catch {
    /* CSV and other text bodies */
  }
  if (!r.ok) throw Object.assign(new Error((j as { error?: string })?.error ?? `${r.status}`), { details: (j as { details?: unknown })?.details });
  return j as T;
}

export const apiUrl = apiBase;

export interface Me {
  user: { did: string; email: string | null; wallet: string | null };
  orgs: { id: string; name: string; account: string; chain_id: number; roles: string[] }[];
  setups: { id: string; name: string; status: string; joined: boolean | null; confirmed: boolean | null }[];
}
export interface Setup {
  id: string;
  name: string;
  chainId: number;
  status: string;
  threshold: number;
  account: string | null;
  orgId: string | null;
  approvers: { email: string; weight: number; wallet: string | null; confirmed: boolean }[];
  typedData: unknown;
}
export interface Org {
  id: string;
  name: string;
  chain_id: number;
  account: string;
  token: string;
  escrow: string;
  threshold: number;
  auto_refund_days: number | null;
  approvers: { address: string; weight: number }[];
  myRoles: string[];
}
export interface PayoutListItem { id: string; title: string; status: string; created_at: string; rows: number; total: string }
export interface ReviewRow { rowId: string; name: string; email?: string; address?: string; amount: string }
export interface Review {
  autoRefundDays: number | null;
  summary: {
    rows: number; total: string; toAddress: number; byEmail: number; balanceSufficient: boolean;
    newRecipients: ReviewRow[]; changedAmount: { row: ReviewRow; previous: string }[];
    duplicateAddress: ReviewRow[][]; duplicateEmail: ReviewRow[][];
    outliers: { row: ReviewRow; previous: string }[]; notSent: { row: ReviewRow; reason: string }[];
  };
}
export interface ReceiptRow { row: string; name: string; email: string | null; address: string | null; amount: string; status: string; executed: boolean; failReason: string | null; txHash: string | null; depositId: string | null }
export interface Receipt { payout: { id: string; title: string; status: string; closedAt: string | null; orgId: string; chainId: number }; rows: ReceiptRow[] }
export interface Batch { id: string; batch_no: number; kind: string; status: string; approve_hash: string; tx_hash: string | null; created_at: string; threshold: number; signedWeight: number; signers: Signer[] }
export type NextStep =
  | { step: "approve"; typedData: unknown; manifest: Manifest }
  | { step: "final"; userOpHash: Hex; manifest: Manifest }
  | { step: "done"; payoutId: string }
  | { step: "closed"; status: string; payoutId: string };
export interface Manifest { payoutId: string; batchNo: number; account: string; rows: { kind: string; rowId: string; to?: string; amount: { $big: string } }[] }

export interface Problem { line: number; column?: string; message: string }
export interface PreviewRow { line: number; name: string; email?: string; address?: string; chainId: number; amount: string; category?: string; status: "ready" | "waiting_details" | "other_chain" }
export interface Preview { rows: PreviewRow[]; errors: Problem[]; warnings: Problem[]; total: string; chainId: number }
export interface PendingApproval { batchId: string; kind: string; payoutId: string; title: string; orgId: string; org: string; rows: number; total: string; createdAt: string }
export interface Signer { address: string; weight: number; email: string | null; signed: boolean }
