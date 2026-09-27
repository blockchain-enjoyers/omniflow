import { encodeAbiParameters, encodeFunctionData, padHex, type Address, type Hex } from "viem";
import { claimEscrowAbi, erc20Abi, kernelAbi } from "./abi.js";
import type { BatchManifest } from "./manifest.js";

export interface Execution {
  target: Address;
  value: bigint;
  callData: Hex;
}

/**
 * ERC-7579 ExecMode as Kernel v3.3 ExecLib.encode packs it:
 * callType(1) | execType(1) | 4 zero bytes | modeSelector(4) | payload(22).
 * Batch (0x01) + TRY (0x01): a failed row does not revert the others.
 */
export const EXEC_MODE_BATCH_TRY: Hex = padHex("0x0101", { dir: "right", size: 32 });

/** Executions of one batch, in manifest order. Escrow rows are approve + deposit. */
export function batchExecutions(m: BatchManifest): Execution[] {
  const out: Execution[] = [];
  for (const row of m.rows) {
    if (row.kind === "transfer") {
      out.push({
        target: m.token,
        value: 0n,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [row.to, row.amount] }),
      });
    } else {
      out.push({
        target: m.token,
        value: 0n,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [m.escrow, row.amount + row.tip] }),
      });
      out.push({
        target: m.escrow,
        value: 0n,
        callData: encodeFunctionData({
          abi: claimEscrowAbi,
          functionName: "deposit",
          args: [row.depositId, m.token, row.amount, row.tip, row.claimSigner, row.autoRefundAt],
        }),
      });
    }
  }
  return out;
}

/** abi.encode(Execution[]) — Kernel ExecLib.encodeBatch. */
export function encodeBatch(execs: Execution[]): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    [execs],
  );
}

/** The account calldata of the batch: Kernel.execute(BATCH|TRY, abi.encode(executions)). */
export function buildBatchCallData(m: BatchManifest): Hex {
  return encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [EXEC_MODE_BATCH_TRY, encodeBatch(batchExecutions(m))],
  });
}

/** Total that leaves the account if every row succeeds: amounts + escrow tips. */
export function batchTotal(m: BatchManifest): bigint {
  return m.rows.reduce((s, r) => s + r.amount + (r.kind === "escrow" ? r.tip : 0n), 0n);
}

