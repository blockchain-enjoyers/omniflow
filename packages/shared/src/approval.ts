import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/**
 * What WeightedECDSAValidator (Kernel v3.3) binds an approval to:
 * keccak256(abi.encode(userOp.sender, userOp.callData, userOp.nonce)).
 */
export function callDataAndNonceHash(sender: Address, callData: Hex, nonce: bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "uint256" }], [sender, callData, nonce]),
  );
}

/**
 * EIP-712 typed data an approver signs (with a Privy embedded wallet).
 * Domain is the validator's: name "WeightedECDSAValidator", version "0.0.3".
 * NB: the approver sees only a hash — the blind-signing risk, accepted for now.
 */
export function approveTypedData(validator: Address, chainId: number, hash: Hex) {
  return {
    domain: { name: "WeightedECDSAValidator", version: "0.0.3", chainId, verifyingContract: validator },
    types: { Approve: [{ name: "callDataAndNonceHash", type: "bytes32" }] },
    primaryType: "Approve" as const,
    message: { callDataAndNonceHash: hash },
  };
}
