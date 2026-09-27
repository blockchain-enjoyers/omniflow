import type { Hex } from "viem";

const API = (import.meta.env.VITE_API_URL ?? "http://localhost:3001").replace(/\/$/, "");
// SLICE ONLY: operator auth is a dev header until Privy token verification is wired (apps/api/src/http/auth.ts).
const DEV_USER = { "x-dev-user": "operator" };

async function call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth ? DEV_USER : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `${r.status}`);
  return j as T;
}

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
export interface Receipt {
  payout: { id: string; title: string; status: string };
  rows: { row: string; name: string; email: string | null; address: string | null; amount: string; status: string; executed: boolean; txHash: string | null }[];
}
export type NextStep =
  | { step: "approve"; typedData: unknown; manifest: Manifest }
  | { step: "final"; userOpHash: Hex; manifest: Manifest }
  | { step: "done" }
  | { step: "closed"; status: string };
export interface Manifest { payoutId: string; batchNo: number; rows: { kind: string; rowId: string; to?: string; amount: { $big: string } }[] }

export const api = {
  createPayout: (orgId: string, b: { title: string; csv: string; autoRefundDays?: number | null }) => call<{ id: string }>("POST", `/orgs/${orgId}/payouts`, b),
  review: (id: string) => call<Review>("GET", `/payouts/${id}/review`),
  freeze: (id: string) => call<{ id: string; approveHash: Hex }>("POST", `/payouts/${id}/batches`),
  batches: (id: string) => call<{ id: string; batch_no: number; kind: string; status: string; tx_hash: string | null }[]>("GET", `/payouts/${id}/batches`),
  receipt: (id: string) => call<Receipt>("GET", `/payouts/${id}/receipt`),
  close: (id: string) => call("POST", `/payouts/${id}/close`),
  nextStep: (batchId: string, approver: string) => call<NextStep>("GET", `/batches/${batchId}/next-step?approver=${approver}`, undefined, false),
  approve: (batchId: string, signature: Hex) => call("POST", `/batches/${batchId}/approvals`, { signature }, false),
  final: (batchId: string, signature: Hex) => call<{ txHash: Hex }>("POST", `/batches/${batchId}/final`, { signature }, false),
};
