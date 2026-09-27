import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/**
 * Deterministic escrow deposit id: keccak256(abi.encode(account, payoutId, rowId)).
 * A second deposit for the same row reverts in the contract.
 */
export function depositId(account: Address, payoutId: string, rowId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "string" }, { type: "string" }],
      [account, payoutId, rowId],
    ),
  );
}
