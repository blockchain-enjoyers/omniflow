import { concatHex, numberToHex, pad, sliceHex, size, type Address, type Hex } from "viem";
import type { PackedOp } from "./chain.js";

/**
 * ERC-4337 v0.7 user operation in the JSON-RPC shape bundlers take (unpacked fields, hex quantities).
 * EntryPoint gets the packed form; the userOpHash is the same for both.
 */
export interface RpcUserOp {
  sender: Address;
  nonce: Hex;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymaster?: Address;
  paymasterVerificationGasLimit?: Hex;
  paymasterPostOpGasLimit?: Hex;
  paymasterData?: Hex;
  signature: Hex;
}

const hi = (x: Hex) => BigInt(x) >> 128n;
const lo = (x: Hex) => BigInt(x) & ((1n << 128n) - 1n);
export const u128 = (h: bigint, l: bigint): Hex => `0x${((h << 128n) | l).toString(16).padStart(64, "0")}`;

export function toRpcUserOp(op: PackedOp): RpcUserOp {
  const r: RpcUserOp = {
    sender: op.sender,
    nonce: numberToHex(op.nonce),
    callData: op.callData,
    verificationGasLimit: numberToHex(hi(op.accountGasLimits)),
    callGasLimit: numberToHex(lo(op.accountGasLimits)),
    preVerificationGas: numberToHex(op.preVerificationGas),
    maxPriorityFeePerGas: numberToHex(hi(op.gasFees)),
    maxFeePerGas: numberToHex(lo(op.gasFees)),
    signature: op.signature,
  };
  if (op.initCode !== "0x") {
    r.factory = sliceHex(op.initCode, 0, 20);
    r.factoryData = sliceHex(op.initCode, 20);
  }
  if (op.paymasterAndData !== "0x") {
    r.paymaster = sliceHex(op.paymasterAndData, 0, 20);
    r.paymasterVerificationGasLimit = numberToHex(BigInt(sliceHex(op.paymasterAndData, 20, 36)));
    r.paymasterPostOpGasLimit = numberToHex(BigInt(sliceHex(op.paymasterAndData, 36, 52)));
    r.paymasterData = size(op.paymasterAndData) > 52 ? sliceHex(op.paymasterAndData, 52) : "0x";
  }
  return r;
}

export function paymasterAndData(p: { paymaster: Address; paymasterVerificationGasLimit: Hex | bigint; paymasterPostOpGasLimit: Hex | bigint; paymasterData: Hex }): Hex {
  return concatHex([
    p.paymaster,
    pad(numberToHex(BigInt(p.paymasterVerificationGasLimit)), { size: 16 }),
    pad(numberToHex(BigInt(p.paymasterPostOpGasLimit)), { size: 16 }),
    p.paymasterData,
  ]);
}

/** Applies gas limits (and optionally fees) returned by a bundler or a sponsor. */
export function withGas(op: PackedOp, g: { callGasLimit: Hex | bigint; verificationGasLimit: Hex | bigint; preVerificationGas: Hex | bigint; maxFeePerGas?: Hex | bigint; maxPriorityFeePerGas?: Hex | bigint }): PackedOp {
  const fees = g.maxFeePerGas !== undefined && g.maxPriorityFeePerGas !== undefined ? u128(BigInt(g.maxPriorityFeePerGas), BigInt(g.maxFeePerGas)) : op.gasFees;
  return { ...op, accountGasLimits: u128(BigInt(g.verificationGasLimit), BigInt(g.callGasLimit)), preVerificationGas: BigInt(g.preVerificationGas), gasFees: fees };
}

export async function jsonRpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string; code?: number; data?: unknown } };
  if (j.error) throw new Error(`${method}: ${j.error.message}${j.error.data ? ` ${JSON.stringify(j.error.data)}` : ""}`);
  return j.result as T;
}

export interface UserOpReceipt {
  userOpHash: Hex;
  success: boolean;
  receipt: { transactionHash: Hex; blockNumber: Hex };
}

/**
 * A hosted ERC-4337 bundler (ZeroDev) over the standard eth_* methods of the ERC.
 * ZeroDev's one project RPC serves both the bundler and the paymaster (docs.zerodev.app, «Bundler & Paymaster RPCs»).
 */
export class BundlerClient {
  constructor(readonly url: string, private readonly entryPoint: Address) {}

  send(op: PackedOp): Promise<Hex> {
    return jsonRpc(this.url, "eth_sendUserOperation", [toRpcUserOp(op), this.entryPoint]);
  }

  estimate(op: PackedOp) {
    return jsonRpc<{ callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex }>(this.url, "eth_estimateUserOperationGas", [toRpcUserOp(op), this.entryPoint]);
  }

  receipt(userOpHash: Hex): Promise<UserOpReceipt | null> {
    return jsonRpc(this.url, "eth_getUserOperationReceipt", [userOpHash]);
  }

  /**
   * Fee suggestion. ZeroDev: `zd_getUserOperationGasPrice` → `{ standard: { maxFeePerGas, maxPriorityFeePerGas } }`
   * (@zerodev/sdk 5.5.10, actions/account-client/getUserOperationGasPrice). Null where the method is not offered.
   */
  async gasPrice(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null> {
    try {
      const g = await jsonRpc<{ standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } }>(this.url, "zd_getUserOperationGasPrice", []);
      return { maxFeePerGas: BigInt(g.standard.maxFeePerGas), maxPriorityFeePerGas: BigInt(g.standard.maxPriorityFeePerGas) };
    } catch {
      return null;
    }
  }

  /** Polls until the op is included; a dropped op surfaces as a timeout and the batch is retried by the scheduler. */
  async waitReceipt(userOpHash: Hex, timeoutMs = 120_000, everyMs = 1000): Promise<UserOpReceipt> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.receipt(userOpHash);
      if (r) return r;
      if (Date.now() > until) throw new Error(`user operation ${userOpHash} not included after ${timeoutMs} ms`);
      await new Promise((ok) => setTimeout(ok, everyMs));
    }
  }
}
