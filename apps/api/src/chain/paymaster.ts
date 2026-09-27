import { concatHex, encodeAbiParameters, numberToHex, pad, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainClient, PackedOp } from "./chain.js";

/** Fills paymasterAndData so that Omniflow pays gas for an organisation's operation. */
export interface Sponsor {
  sponsor(op: PackedOp): Promise<PackedOp>;
}

const verifyingPaymasterAbi = parseAbi([
  "function getHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)",
]);

const PM_VERIFICATION_GAS = 120_000n;
const PM_POSTOP_GAS = 0n; // VerifyingPaymaster returns an empty context — no postOp

/**
 * EMULATION of a hosted paymaster: eth-infinitism's reference VerifyingPaymaster (v0.7.0) deployed by the stack
 * script, signing key held by the API. The hash comes from the contract's own getHash — no re-implementation.
 * Signs only operations the API itself built; the money at risk is the paymaster deposit, not users'.
 */
export class LocalVerifyingPaymaster implements Sponsor {
  constructor(private readonly chain: ChainClient, private readonly paymaster: Address, private readonly signerKey: Hex, private readonly ttlSec = 3600) {}

  async sponsor(op: PackedOp): Promise<PackedOp> {
    const now = Math.floor(Date.now() / 1000);
    const validUntil = now + this.ttlSec;
    const validAfter = 0;
    const head = concatHex([this.paymaster, pad(numberToHex(PM_VERIFICATION_GAS), { size: 16 }), pad(numberToHex(PM_POSTOP_GAS), { size: 16 })]);
    const times = encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, validAfter]);
    const draft = { ...op, paymasterAndData: concatHex([head, times, `0x${"00".repeat(65)}`]) };
    const hash = await this.chain.pub.readContract({ address: this.paymaster, abi: verifyingPaymasterAbi, functionName: "getHash", args: [draft, validUntil, validAfter] });
    const sig = await privateKeyToAccount(this.signerKey).signMessage({ message: { raw: hash } });
    return { ...op, paymasterAndData: concatHex([head, times, sig]) };
  }
}

/**
 * Hosted paymaster via ERC-7677 (pm_getPaymasterData), as ZeroDev and Pimlico expose it.
 * NOT VERIFIED against a provider — written from the ERC; the first thing to check on the real setup.
 */
export class Erc7677Paymaster implements Sponsor {
  constructor(private readonly url: string, private readonly entryPoint: Address, private readonly chainId: number, private readonly context: unknown = {}) {}

  async sponsor(op: PackedOp): Promise<PackedOp> {
    const [verificationGasLimit, callGasLimit] = [BigInt(op.accountGasLimits) >> 128n, BigInt(op.accountGasLimits) & ((1n << 128n) - 1n)];
    const [maxPriorityFeePerGas, maxFeePerGas] = [BigInt(op.gasFees) >> 128n, BigInt(op.gasFees) & ((1n << 128n) - 1n)];
    const unpacked = {
      sender: op.sender,
      nonce: numberToHex(op.nonce),
      callData: op.callData,
      callGasLimit: numberToHex(callGasLimit),
      verificationGasLimit: numberToHex(verificationGasLimit),
      preVerificationGas: numberToHex(op.preVerificationGas),
      maxFeePerGas: numberToHex(maxFeePerGas),
      maxPriorityFeePerGas: numberToHex(maxPriorityFeePerGas),
    };
    const r = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "pm_getPaymasterData", params: [unpacked, this.entryPoint, numberToHex(this.chainId), this.context] }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`paymaster: ${j.error.message}`);
    const p = j.result as { paymaster: Address; paymasterData: Hex; paymasterVerificationGasLimit?: Hex; paymasterPostOpGasLimit?: Hex };
    return {
      ...op,
      paymasterAndData: concatHex([
        p.paymaster,
        pad(p.paymasterVerificationGasLimit ?? numberToHex(PM_VERIFICATION_GAS), { size: 16 }),
        pad(p.paymasterPostOpGasLimit ?? "0x0", { size: 16 }),
        p.paymasterData,
      ]),
    };
  }
}
