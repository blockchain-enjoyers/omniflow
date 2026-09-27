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
}

export interface OpReceipt {
  txHash: Hex;
  blockNumber: bigint;
  success: boolean;
  failedExecutions: number[];
  logs: Log[];
}

const u128 = (hi: bigint, lo: bigint): Hex => `0x${((hi << 128n) | lo).toString(16).padStart(64, "0")}`;

export class ChainClient {
  readonly pub: PublicClient;
  private readonly wallet: WalletClient;
  readonly submitter: Address;

  constructor(readonly cfg: ChainConfig) {
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

  /** Builds the op the final approver signs. Gas limits scale with the number of executions. */
  async draftOp(sender: Address, callData: Hex, nonce: bigint, executions: number): Promise<PackedOp> {
    const gasPrice = await this.pub.getGasPrice();
    const maxFee = (gasPrice * 3n) / 2n + 1n;
    const verification = 400_000n;
    const call = 100_000n + 120_000n * BigInt(executions);
    return {
      sender,
      nonce,
      initCode: "0x",
      callData,
      accountGasLimits: u128(verification, call),
      preVerificationGas: 100_000n,
      gasFees: u128(maxFee, maxFee),
      paymasterAndData: "0x",
      signature: "0x",
    };
  }

  getUserOpHash(op: PackedOp): Promise<Hex> {
    return this.pub.readContract({ address: this.cfg.entryPoint, abi: entryPoint07Abi, functionName: "getUserOpHash", args: [op] });
  }

  /** Relays a fully signed op straight to EntryPoint (self-bundling, without a hosted bundler). */
  async submitOp(op: PackedOp): Promise<Hex> {
    return this.wallet.writeContract({
      address: this.cfg.entryPoint,
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [[op], this.submitter],
      chain: this.wallet.chain,
      account: this.wallet.account!,
    });
  }

  async waitOp(txHash: Hex, account: Address): Promise<OpReceipt> {
    const r: TransactionReceipt = await this.pub.waitForTransactionReceipt({ hash: txHash });
    let success = false;
    const failedExecutions: number[] = [];
    for (const log of r.logs) {
      if (getAddress(log.address) === getAddress(this.cfg.entryPoint)) {
        try {
          const ev = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
          if (ev.eventName === "UserOperationEvent") success = ev.args.success;
        } catch {}
      } else if (getAddress(log.address) === getAddress(account)) {
        try {
          const ev = decodeEventLog({ abi: kernelAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "TryExecuteUnsuccessful") failedExecutions.push(Number(ev.args.batchExecutionindex));
        } catch {}
      }
    }
    return { txHash, blockNumber: r.blockNumber, success: success && r.status === "success", failedExecutions, logs: r.logs };
  }

  /** Escrow events in a block range — the indexer's feed for claims and refunds. */
  async escrowEvents(escrow: Address, fromBlock: bigint, toBlock: bigint) {
    const logs = await this.pub.getLogs({ address: escrow, fromBlock, toBlock });
    return logs.flatMap((log) => {
      try {
        return [{ log, ev: decodeEventLog({ abi: claimEscrowAbi, data: log.data, topics: log.topics }) }];
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
