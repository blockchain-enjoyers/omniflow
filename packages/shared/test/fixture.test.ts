import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getAddress, hashTypedData, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  approveTypedData,
  buildBatchCallData,
  callDataAndNonceHash,
  claimTypedData,
  depositId,
  signClaim,
  type BatchManifest,
} from "../src/index.js";

/**
 * Cross-language fixture: TypeScript builds the batch calldata, the approval hash and a claim signature;
 * omniflow/contracts/test/SharedFixture.t.sol rebuilds them with Kernel v3.3's own encoders and redeems
 * the claim on the real ClaimEscrow. Regenerate with UPDATE_FIXTURE=1.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../../../contracts/test/fixtures/shared.json");

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const CHAIN_ID = 31337; // Foundry's default chain id
const APPROVER_KEY = `0x${"11".repeat(32)}` as const;
const CLAIM_KEY = `0x${"22".repeat(32)}` as const;

async function build() {
  const account = A(0xacc0);
  const escrow = A(0xe5c0);
  const token = A(0x05dc0);
  const validator = A(0x7a10);
  const claimSigner = privateKeyToAccount(CLAIM_KEY).address;
  const dId = depositId(account, "payout-1", "row-2");
  const m: BatchManifest = {
    version: 1,
    chainId: CHAIN_ID,
    account,
    escrow,
    token,
    payoutId: "payout-1",
    batchNo: 0,
    nonce: 5n,
    rows: [
      { kind: "transfer", rowId: "row-1", to: A(0xa11ce), amount: 1_000_000_000n },
      { kind: "escrow", rowId: "row-2", depositId: dId, claimSigner, amount: 3_000_000_000n, tip: 1_000_000n, autoRefundAt: 0 },
    ],
  };
  const callData = buildBatchCallData(m);
  const hash = callDataAndNonceHash(account, callData, m.nonce);
  const approveTd = approveTypedData(validator, CHAIN_ID, hash);
  const approver = privateKeyToAccount(APPROVER_KEY);
  const recipient = A(0xbeef0);
  const deadline = 2_000_000_000n;
  const link = { chainId: CHAIN_ID, escrow, depositId: dId, key: CLAIM_KEY };

  return {
    chainId: CHAIN_ID,
    account,
    escrow,
    token,
    validator,
    nonce: m.nonce.toString(),
    transferTo: m.rows[0]!.kind === "transfer" ? m.rows[0]!.to : "",
    transferAmount: "1000000000",
    depositId: dId,
    claimSigner,
    depositAmount: "3000000000",
    tip: "1000000",
    callData,
    callDataAndNonceHash: hash,
    approver: approver.address,
    approveDigest: hashTypedData(approveTd),
    approveSignature: await approver.signTypedData(approveTd),
    claimRecipient: recipient,
    claimDeadline: deadline.toString(),
    claimDigest: hashTypedData(claimTypedData(link, recipient, deadline)),
    claimSignature: await signClaim(link, recipient, deadline),
  };
}

describe("cross-language fixture", () => {
  it("matches the committed fixture (UPDATE_FIXTURE=1 to regenerate)", async () => {
    const json = `${JSON.stringify(await build(), null, 2)}\n`;
    if (process.env.UPDATE_FIXTURE === "1" || !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, json);
    }
    expect(readFileSync(FIXTURE, "utf8")).toBe(json);
  });
});
