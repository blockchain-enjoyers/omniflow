import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";

/** Kernel v3 `initialize` + factory — the parts Omniflow needs to create an organisation account. */
export const kernelInitAbi = parseAbi([
  "function initialize(bytes21 _rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)",
]);
export const kernelFactoryAbi = parseAbi([
  "function createAccount(bytes data, bytes32 salt) payable returns (address)",
  "function getAddress(bytes data, bytes32 salt) view returns (address)",
  "function implementation() view returns (address)",
]);

export interface ApproverSet {
  approvers: { address: Address; weight: number }[];
  threshold: number;
}

/** WeightedECDSAValidator requires guardians sorted by descending address. */
export function sortApprovers(set: ApproverSet): ApproverSet {
  const approvers = [...set.approvers]
    .map((a) => ({ address: getAddress(a.address), weight: a.weight }))
    .sort((x, y) => (BigInt(x.address) > BigInt(y.address) ? -1 : 1));
  return { approvers, threshold: set.threshold };
}

/** ValidationId: VALIDATION_TYPE_VALIDATOR (0x01) ‖ validator address — Kernel ValidatorLib.validatorToIdentifier. */
export function validatorIdentifier(validator: Address): Hex {
  return concatHex(["0x01", getAddress(validator)]);
}

/**
 * Kernel.initialize calldata with WeightedECDSAValidator as root: abi.encode(guardians, weights, threshold, delay=0).
 * Same bytes as contracts/script/ForkStack.s.sol builds — so factory.getAddress gives the same account.
 */
export function kernelInitData(validator: Address, set: ApproverSet): Hex {
  const s = sortApprovers(set);
  const total = s.approvers.reduce((a, b) => a + b.weight, 0);
  if (s.threshold <= 0 || s.threshold > total) throw new Error("threshold must be in 1..total weight");
  if (new Set(s.approvers.map((a) => a.address)).size !== s.approvers.length) throw new Error("duplicate approver");
  const validatorData = encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint24[]" }, { type: "uint24" }, { type: "uint48" }],
    [s.approvers.map((a) => a.address), s.approvers.map((a) => a.weight), s.threshold, 0],
  );
  return encodeFunctionData({
    abi: kernelInitAbi,
    functionName: "initialize",
    args: [validatorIdentifier(validator), "0x0000000000000000000000000000000000000000", validatorData, "0x", []],
  });
}

/**
 * What each approver signs to confirm the organisation setup: they see their own address inside the set
 * and the account address it produces. Stored as evidence; the chain does not check it.
 */
export function setupConfirmationTypedData(chainId: number, account: Address, set: ApproverSet, orgName: string) {
  const s = sortApprovers(set);
  return {
    domain: { name: "Omniflow", version: "1", chainId },
    types: {
      ConfirmOrganisation: [
        { name: "organisation", type: "string" },
        { name: "account", type: "address" },
        { name: "approvers", type: "address[]" },
        { name: "weights", type: "uint24[]" },
        { name: "threshold", type: "uint24" },
      ],
    },
    primaryType: "ConfirmOrganisation" as const,
    message: {
      organisation: orgName,
      account,
      approvers: s.approvers.map((a) => a.address),
      weights: s.approvers.map((a) => a.weight),
      threshold: s.threshold,
    },
  };
}
