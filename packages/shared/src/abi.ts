import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** ClaimEscrow */
export const claimEscrowAbi = parseAbi([
  "function deposit(bytes32 id, address token, uint96 amount, uint96 tip, address claimSigner, uint40 autoRefundAt)",
  "function claim(bytes32 id, address recipient, uint256 deadline, bytes signature)",
  "function refund(bytes32 id)",
  "function refundExpired(bytes32 id)",
  "function rekey(bytes32 id, address newClaimSigner)",
  "function setAutoRefund(bytes32 id, uint40 at)",
  "function claimDigest(bytes32 id, address recipient, uint256 deadline) view returns (bytes32)",
  "function getDeposit(bytes32 id) view returns ((address depositor, uint96 amount, address token, uint96 tip, address claimSigner, uint40 autoRefundAt, uint8 status))",
  "event Deposited(bytes32 indexed id, address indexed depositor, address indexed token, uint96 amount, uint96 tip, address claimSigner, uint40 autoRefundAt)",
  "event Claimed(bytes32 indexed id, address indexed recipient, address relayer)",
  "event Refunded(bytes32 indexed id, bool byExpiry)",
  "event Rekeyed(bytes32 indexed id, address newClaimSigner)",
  "event AutoRefundSet(bytes32 indexed id, uint40 autoRefundAt)",
]);

/** Kernel v3.3 execute(ExecMode, bytes) — ERC-7579. */
export const kernelAbi = parseAbi([
  "function execute(bytes32 execMode, bytes executionCalldata)",
  "event TryExecuteUnsuccessful(uint256 batchExecutionindex, bytes result)",
]);

export enum DepositStatus {
  None = 0,
  Pending = 1,
  Claimed = 2,
  Refunded = 3,
}
