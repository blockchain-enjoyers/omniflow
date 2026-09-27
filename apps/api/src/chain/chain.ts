import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi } from "viem/account-abstraction";
import { claimEscrowAbi, kernelAbi, kernelFactoryAbi } from "@omniflow/shared";
import { BundlerClient, u128 } from "./bundler.js";

/** ERC-4337 v0.7 packed user operation, as EntryPoint.handleOps takes it. */
export interface PackedOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export const weightedValidatorAbi = parseAbi([
  "function weightedStorage(address kernel) view returns (uint24 totalWeight, uint24 threshold, uint48 delay, address firstGuardian)",
  "function guardian(address guardian, address kernel) view returns (uint24 weight, address nextGuardian)",
]);

export interface ChainConfig {
  chainId: number;
  rpcUrl: string;
  entryPoint: Address;
  /**
   * Pays gas to call EntryPoint.handleOps and escrow.claim/refundExpired. Has no rights over anyone's
   * funds — it only relays operations already signed by approvers or by a claim key.
   */
  submitterKey: Hex;
  /**
   * Hosted bundler (ZeroDev). Without it the API bundles itself: the submitter calls EntryPoint.handleOps.
   */
  bundlerUrl?: string;
  /**
   * Largest block range per eth_getLogs. Public RPCs cap the range (and the result size); a gap after downtime on
   * Arbitrum is hundreds of thousands of blocks. Default 2000.
   */
  logChunkBlocks?: number;
}

export interface OpReceipt {
  txHash: Hex;
  blockNumber: bigint;
  blockTime: Date;
  success: boolean;
  failedExecutions: number[];
  logs: Log[];
}

/**
 * Minimum callGasLimit for a batch of `executions` calls. Batches run in TRY mode, so a callGasLimit that is
 * too low does not fail the operation — the last items silently fail. A bundler estimate cannot see that (found on
 * the Arbitrum Sepolia fork 27.09: Alto estimated 228 725 for four calls on Circle USDC; the escrow deposit failed).
 * The floor is what the end-to-end tests execute with, locally and on the fork.
 */
export const minCallGas = (executions: number) => 100_000n + 120_000n * BigInt(executions);

const decodeEscrow = (log: Log) => decodeEventLog({ abi: claimEscrowAbi, data: log.data, topics: log.topics });

/** Where to find a submitted op: the bundle transaction (self-bundling) or only the userOpHash (hosted bundler). */
export interface SubmittedOp {
  userOpHash: Hex;
  txHash: Hex | null;
}

export class ChainClient {
  readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  readonly submitter: Address;
  readonly bundler?: BundlerClient;

  constructor(readonly cfg: ChainConfig) {
    if (cfg.bundlerUrl) this.bundler = new BundlerClient(cfg.bundlerUrl, cfg.entryPoint);
    const chain = { id: cfg.chainId, name: `chain-${cfg.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } } as Chain;
    const account = privateKeyToAccount(cfg.submitterKey);
    this.submitter = account.address;
    this.pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
    this.wallet = createWalletClient({ chain, transport: http(cfg.rpcUrl), account });
  }

  /** Counterfactual account address for this init data and salt — the factory's own computation. */
  accountAddress(factory: Address, initData: Hex, salt: Hex): Promise<Address> {
    return this.pub.readContract({ address: factory, abi: kernelFactoryAbi, functionName: "getAddress", args: [initData, salt] });
  }

  /** Permissionless factory call; the submitter pays gas. Idempotent: skips if the account already has code. */
  async deployAccount(factory: Address, initData: Hex, salt: Hex): Promise<Address> {
    const account = await this.accountAddress(factory, initData, salt);
    const code = await this.pub.getCode({ address: account });
    if (code && code !== "0x") return account;
    const { request } = await this.pub.simulateContract({ address: factory, abi: kernelFactoryAbi, functionName: "createAccount", args: [initData, salt], account: this.submitter });
    const h = await this.wallet.writeContract({ ...request, chain: this.wallet.chain, account: this.wallet.account! });
    if (!(await this.waitTx(h))) throw new Error("account deployment reverted");
    return account;
  }

  /** Nonce of the root validator (key 0) — Kernel v3 encodes the validator in the nonce key. */
  getNonce(account: Address): Promise<bigint> {
    return this.pub.readContract({ address: this.cfg.entryPoint, abi: entryPoint07Abi, functionName: "getNonce", args: [account, 0n] });
  }

  /** Approver set and threshold as the validator holds them on chain — the source of truth. */
  async readApprovers(validator: Address, account: Address, candidates: Address[]) {
    const [, threshold] = await this.pub.readContract({ address: validator, abi: weightedValidatorAbi, functionName: "weightedStorage", args: [account] });
    const weights = await Promise.all(
      candidates.map((g) => this.pub.readContract({ address: validator, abi: weightedValidatorAbi, functionName: "guardian", args: [g, account] })),
    );
    return { threshold: Number(threshold), weights: candidates.map((g, i) => ({ address: g, weight: Number(weights[i]![0]) })) };
  }

  /**
   * Builds the op the final approver signs. Gas limits scale with the number of executions; a sponsor or the bundler
   * replaces them with its own estimate. Fees: the bundler's suggestion when it offers one, else 1.5 × node gas price.
   */
  async draftOp(sender: Address, callData: Hex, nonce: bigint, executions: number): Promise<PackedOp> {
    const suggested = await this.bundler?.gasPrice();
    const node = suggested ? 0n : await this.pub.getGasPrice();
    const maxFee = suggested?.maxFeePerGas ?? (node * 3n) / 2n + 1n;
    const maxPriority = suggested?.maxPriorityFeePerGas ?? maxFee;
    const verification = 400_000n;
    const call = minCallGas(executions);
    return {
      sender,
      nonce,
      initCode: "0x",
      callData,
      accountGasLimits: u128(verification, call),
      preVerificationGas: 100_000n,
      gasFees: u128(maxPriority, maxFee),
      paymasterAndData: "0x",
      signature: "0x",
    };
  }

  getUserOpHash(op: PackedOp): Promise<Hex> {
    return this.pub.readContract({ address: this.cfg.entryPoint, abi: entryPoint07Abi, functionName: "getUserOpHash", args: [op] });
  }

  /** Sends a fully signed op: to the hosted bundler, or straight to EntryPoint (self-bundling). */
  async submitOp(op: PackedOp): Promise<SubmittedOp> {
    if (this.bundler) return { userOpHash: await this.bundler.send(op), txHash: null };
    const txHash = await this.wallet.writeContract({
      address: this.cfg.entryPoint,
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [[op], this.submitter],
      chain: this.wallet.chain,
      account: this.wallet.account!,
    });
    return { userOpHash: await this.getUserOpHash(op), txHash };
  }

  /**
   * Result of a submitted op. A bundle may carry other people's operations, so only this op's UserOperationEvent
   * counts, and only the account's own TryExecuteUnsuccessful events.
   */
  async waitOp(ref: SubmittedOp, account: Address): Promise<OpReceipt> {
    const txHash = ref.txHash ?? (await this.bundler!.waitReceipt(ref.userOpHash)).receipt.transactionHash;
    const r: TransactionReceipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    let success = false;
    const failedExecutions: number[] = [];
    for (const log of r.logs) {
      if (getAddress(log.address) === getAddress(this.cfg.entryPoint)) {
        try {
          const ev = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
          if (ev.eventName === "UserOperationEvent" && ev.args.userOpHash === ref.userOpHash) success = ev.args.success;
        } catch {}
      } else if (getAddress(log.address) === getAddress(account)) {
        try {
          const ev = decodeEventLog({ abi: kernelAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "TryExecuteUnsuccessful") failedExecutions.push(Number(ev.args.batchExecutionindex));
        } catch {}
      }
    }
    const block = await this.pub.getBlock({ blockNumber: r.blockNumber });
    return { txHash, blockNumber: r.blockNumber, blockTime: new Date(Number(block.timestamp) * 1000), success: success && r.status === "success", failedExecutions, logs: r.logs };
  }

  /** Escrow events in a block range — the indexer's feed for claims and refunds. */
  /** Block ranges of at most logChunkBlocks covering [from, to], in order. */
  chunks(from: bigint, to: bigint): [bigint, bigint][] {
    const span = BigInt(this.cfg.logChunkBlocks ?? 2000);
    const out: [bigint, bigint][] = [];
    for (let a = from; a <= to; a += span) out.push([a, a + span - 1n < to ? a + span - 1n : to]);
    return out;
  }

  /**
   * Escrow events in one range. If the RPC refuses the range (too many blocks or results), it is split in half and
   * retried — down to a single block, which then fails for real.
   */
  async escrowEvents(escrow: Address, fromBlock: bigint, toBlock: bigint): Promise<{ log: Log; ev: ReturnType<typeof decodeEscrow> }[]> {
    let logs: Log[];
    try {
      logs = await this.pub.getLogs({ address: escrow, fromBlock, toBlock });
    } catch (e) {
      if (toBlock <= fromBlock) throw e;
      const mid = fromBlock + (toBlock - fromBlock) / 2n;
      return [...(await this.escrowEvents(escrow, fromBlock, mid)), ...(await this.escrowEvents(escrow, mid + 1n, toBlock))];
    }
    return logs.flatMap((log) => {
      try {
        return [{ log, ev: decodeEscrow(log) }];
      } catch {
        return [];
      }
    });
  }

  blockNumber(): Promise<bigint> {
    return this.pub.getBlockNumber({ cacheTime: 0 }); // the default cache would hide fresh blocks from the indexer
  }

  /**
   * Relays a claim signed with the link key; the relayer earns the tip.
   * Simulated first: an invalid claim is rejected for free instead of burning the submitter's gas.
   */
  async relayClaim(escrow: Address, id: Hex, recipient: Address, deadline: bigint, signature: Hex): Promise<Hex> {
    const { request } = await this.pub.simulateContract({
      address: escrow,
      abi: claimEscrowAbi,
      functionName: "claim",
      args: [id, recipient, deadline, signature],
      account: this.submitter,
    });
    return this.wallet.writeContract({ ...request, chain: this.wallet.chain, account: this.wallet.account! });
  }

  /** Permissionless auto-refund — money goes to the depositor only. */
  refundExpired(escrow: Address, id: Hex): Promise<Hex> {
    return this.wallet.writeContract({
      address: escrow,
      abi: claimEscrowAbi,
      functionName: "refundExpired",
      args: [id],
      chain: this.wallet.chain,
      account: this.wallet.account!,
    });
  }

  async waitTx(hash: Hex): Promise<boolean> {
    return (await this.pub.waitForTransactionReceipt({ hash })).status === "success";
  }
}

export const opToJson = (op: PackedOp) => ({ ...op, nonce: op.nonce.toString(), preVerificationGas: op.preVerificationGas.toString() });
export const opFromJson = (j: ReturnType<typeof opToJson>): PackedOp => ({ ...j, nonce: BigInt(j.nonce), preVerificationGas: BigInt(j.preVerificationGas) });
