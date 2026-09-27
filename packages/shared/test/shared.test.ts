import { describe, expect, it } from "vitest";
import { decodeFunctionData, getAddress, recoverTypedDataAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EXEC_MODE_BATCH_TRY,
  approveTypedData,
  batchExecutions,
  batchTotal,
  buildBatchCallData,
  callDataAndNonceHash,
  claimTypedData,
  depositId,
  formatClaimLink,
  generateClaimKey,
  kernelAbi,
  parseClaimLink,
  reviewPayout,
  signClaim,
  type BatchManifest,
  type PayoutRow,
} from "../src/index.js";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;

const manifest: BatchManifest = {
  version: 1,
  chainId: 421614,
  account: A(0xacc),
  escrow: A(0xe5c),
  token: A(0x05dc),
  payoutId: "payout-1",
  batchNo: 0,
  nonce: 7n,
  rows: [
    { kind: "transfer", rowId: "r1", to: A(0xa1), amount: 1_000_000n },
    {
      kind: "escrow",
      rowId: "r2",
      depositId: depositId(A(0xacc), "payout-1", "r2"),
      claimSigner: A(0xc1),
      amount: 3_000_000n,
      tip: 10_000n,
      autoRefundAt: 0,
    },
  ],
};

describe("batch", () => {
  it("packs BATCH|TRY exec mode like Kernel ExecLib.encode", () => {
    expect(EXEC_MODE_BATCH_TRY).toBe(`0x0101${"0".repeat(60)}`);
  });

  it("escrow rows become approve + deposit, in order", () => {
    const ex = batchExecutions(manifest);
    expect(ex.map((e) => e.target)).toEqual([manifest.token, manifest.token, manifest.escrow]);
  });

  it("calldata decodes back to Kernel.execute with our mode", () => {
    const d = decodeFunctionData({ abi: kernelAbi, data: buildBatchCallData(manifest) });
    expect(d.functionName).toBe("execute");
    expect(d.args[0]).toBe(EXEC_MODE_BATCH_TRY);
  });

  it("total includes tips", () => {
    expect(batchTotal(manifest)).toBe(4_010_000n);
  });

  it("is deterministic: same manifest → same bytes (what approvers sign)", () => {
    const again = structuredClone(manifest);
    expect(buildBatchCallData(again)).toBe(buildBatchCallData(manifest));
    const h1 = callDataAndNonceHash(manifest.account, buildBatchCallData(manifest), manifest.nonce);
    const h2 = callDataAndNonceHash(manifest.account, buildBatchCallData(manifest), manifest.nonce + 1n);
    expect(h1).not.toBe(h2);
  });
});

describe("depositId", () => {
  it("differs per row and per account", () => {
    expect(depositId(A(1), "p", "r1")).not.toBe(depositId(A(1), "p", "r2"));
    expect(depositId(A(1), "p", "r1")).not.toBe(depositId(A(2), "p", "r1"));
  });
});

describe("approval", () => {
  it("an approver's signature recovers to the approver", async () => {
    const approver = privateKeyToAccount(`0x${"11".repeat(32)}`);
    const h = callDataAndNonceHash(manifest.account, buildBatchCallData(manifest), manifest.nonce);
    const td = approveTypedData(A(0x7a1), manifest.chainId, h);
    const sig = await approver.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(approver.address);
  });
});

describe("claim link", () => {
  it("round-trips and keeps everything in the fragment", () => {
    const k = generateClaimKey();
    const link = { chainId: 421614, escrow: A(0xe5c), depositId: depositId(A(1), "p", "r"), key: k.privateKey };
    const url = formatClaimLink("https://claim.example/", link);
    expect(new URL(url).search).toBe("");
    expect(parseClaimLink(url)).toEqual(link);
  });

  it("rejects malformed links", () => {
    expect(() => parseClaimLink("https://x/#c=1&e=0x1&id=0x2&k=0x3")).toThrow();
    expect(() => parseClaimLink("https://x/")).toThrow();
  });

  it("the claim signature recovers to the claim signer and binds the recipient", async () => {
    const k = generateClaimKey();
    const link = { chainId: 421614, escrow: A(0xe5c), depositId: depositId(A(1), "p", "r"), key: k.privateKey };
    const sig = await signClaim(link, A(0xbeef), 100n);
    expect(await recoverTypedDataAddress({ ...claimTypedData(link, A(0xbeef), 100n), signature: sig })).toBe(k.address);
    expect(await recoverTypedDataAddress({ ...claimTypedData(link, A(0xbad), 100n), signature: sig })).not.toBe(k.address);
  });
});

describe("review", () => {
  const row = (p: Partial<PayoutRow>): PayoutRow => ({ rowId: "r", name: "n", chainId: 42161, amount: 100n, ...p });

  it("groups new, changed, duplicates, outliers and not-sent", () => {
    const prev = new Map([[A(0xa).toLowerCase(), 100n], [A(0xb).toLowerCase(), 100n]]);
    const s = reviewPayout({
      payoutChainId: 42161,
      balance: 10_000n,
      previousAmountByAddress: prev,
      rows: [
        row({ rowId: "same", address: A(0xa) }),
        row({ rowId: "outlier", address: A(0xb), amount: 1_000n }),
        row({ rowId: "new", address: A(0xc) }),
        row({ rowId: "dup", address: A(0xc), email: "x@y.z" }),
        row({ rowId: "mail", email: "X@y.z" }),
        row({ rowId: "none" }),
        row({ rowId: "chain", address: A(0xd), chainId: 1 }),
      ],
    });
    expect(s.newRecipients.map((r) => r.rowId)).toEqual(["new", "dup", "mail"]);
    expect(s.outliers.map((o) => o.row.rowId)).toEqual(["outlier"]);
    expect(s.duplicateAddress[0]?.map((r) => r.rowId)).toEqual(["new", "dup"]);
    expect(s.duplicateEmail[0]?.map((r) => r.rowId)).toEqual(["dup", "mail"]);
    expect(s.notSent.map((n) => [n.row.rowId, n.reason])).toEqual([
      ["none", "no-address-no-email"],
      ["chain", "other-chain"],
    ]);
    expect(s.total).toBe(1_400n);
    expect(s.balanceSufficient).toBe(true);
  });
});


