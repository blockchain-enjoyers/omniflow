import express, { type Router } from "express";
import {
  concatHex,
  createPublicClient,
  encodeAbiParameters,
  http,
  numberToHex,
  pad,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * EMULATOR of the ZeroDev project RPC — not ZeroDev. One URL, as ZeroDev gives it: the standard ERC-4337
 * methods go to a real open-source bundler (Pimlico's Alto) running against the local chain; the two ZeroDev methods
 * Omniflow calls are answered here with the reference VerifyingPaymaster (eth-infinitism v0.7.0) deployed on anvil:
 *   zd_getUserOperationGasPrice  → { slow, standard, fast } (shape from @zerodev/sdk 5.5.10)
 *   zd_sponsorUserOperation      → gas limits + paymaster fields (shape from @zerodev/sdk 5.5.10)
 * What this cannot show: how ZeroDev's own service estimates, its policies and limits, which bundler it routes to.
 */
export interface ZeroDevEmulatorConfig {
  bundlerUrl: string;
  rpcUrl: string;
  paymaster: Address;
  paymasterSignerKey: Hex;
  /** paymaster validation gas the emulator reserves; VerifyingPaymaster has no postOp */
  paymasterVerificationGas?: bigint;
  /**
   * how long a sponsorship is valid, in seconds of chain time (default 3600); 0 = no expiry (validUntil 0).
   * A demo chain whose clock is not the wall clock needs 0: Alto simulates bundles with the wall-clock time.
   */
  sponsorshipTtlSec?: number;
}

interface RpcOp {
  sender: Address; nonce: Hex; factory?: Address; factoryData?: Hex; callData: Hex;
  callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex;
  paymaster?: Address; paymasterVerificationGasLimit?: Hex; paymasterPostOpGasLimit?: Hex; paymasterData?: Hex; signature: Hex;
}

const pmAbi = parseAbi([
  "function getHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature) userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)",
]);
const u128 = (h: bigint, l: bigint): Hex => `0x${((h << 128n) | l).toString(16).padStart(64, "0")}`;

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string; code?: number; data?: unknown } };
  if (j.error) throw Object.assign(new Error(j.error.message), { rpc: j.error });
  return j.result as T;
}

export function zerodevEmulator(cfg: ZeroDevEmulatorConfig): Router {
  const pub = createPublicClient({ transport: http(cfg.rpcUrl) });
  const signer = privateKeyToAccount(cfg.paymasterSignerKey);
  const pmGas = cfg.paymasterVerificationGas ?? 120_000n;

  /** paymasterAndData signed for exactly these gas values (the reference paymaster's hash covers them) */
  async function signPaymaster(op: RpcOp, g: { verificationGasLimit: bigint; callGasLimit: bigint; preVerificationGas: bigint }) {
    const now = Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
    const ttl = cfg.sponsorshipTtlSec ?? 3600;
    const validUntil = ttl === 0 ? 0 : now + ttl;
    const validAfter = 0;
    const times = encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, validAfter]);
    const head = concatHex([cfg.paymaster, pad(numberToHex(pmGas), { size: 16 }), pad("0x0", { size: 16 })]);
    const packed = {
      sender: op.sender,
      nonce: BigInt(op.nonce),
      initCode: op.factory ? concatHex([op.factory, op.factoryData ?? "0x"]) : ("0x" as Hex),
      callData: op.callData,
      accountGasLimits: u128(g.verificationGasLimit, g.callGasLimit),
      preVerificationGas: g.preVerificationGas,
      gasFees: u128(BigInt(op.maxPriorityFeePerGas), BigInt(op.maxFeePerGas)),
      paymasterAndData: concatHex([head, times, `0x${"00".repeat(65)}`]),
      signature: op.signature,
    };
    const hash = await pub.readContract({ address: cfg.paymaster, abi: pmAbi, functionName: "getHash", args: [packed, validUntil, validAfter] });
    return {
      paymaster: cfg.paymaster,
      paymasterVerificationGasLimit: numberToHex(pmGas),
      paymasterPostOpGasLimit: "0x0" as Hex,
      paymasterData: concatHex([times, await signer.signMessage({ message: { raw: hash } })]),
    };
  }

  async function sponsor(p: { userOp: RpcOp; entryPointAddress: Address }) {
    const op = { ...p.userOp };
    // 1. estimate with the paymaster attached (the account holds no ETH), signed for generous placeholder limits
    const placeholder = { verificationGasLimit: 1_000_000n, callGasLimit: 3_000_000n, preVerificationGas: 200_000n };
    const trial = {
      ...op,
      verificationGasLimit: numberToHex(placeholder.verificationGasLimit),
      callGasLimit: numberToHex(placeholder.callGasLimit),
      preVerificationGas: numberToHex(placeholder.preVerificationGas),
      ...(await signPaymaster(op, placeholder)),
    };
    const est = await rpc<{ callGasLimit: Hex; verificationGasLimit: Hex; preVerificationGas: Hex }>(cfg.bundlerUrl, "eth_estimateUserOperationGas", [trial, p.entryPointAddress]);
    // 2. sign for the estimated limits — what the account will actually be charged against
    // ASSUMPTION (unknown for ZeroDev): a callGasLimit sent higher than the estimate is kept. Omniflow refuses to
    // proceed if a sponsor lowers it below its floor, so a wrong assumption fails closed rather than silently.
    const callGasLimit = BigInt(op.callGasLimit) > BigInt(est.callGasLimit) ? BigInt(op.callGasLimit) : BigInt(est.callGasLimit);
    const g = { verificationGasLimit: BigInt(est.verificationGasLimit), callGasLimit, preVerificationGas: BigInt(est.preVerificationGas) };
    return {
      callGasLimit: numberToHex(callGasLimit),
      verificationGasLimit: est.verificationGasLimit,
      preVerificationGas: est.preVerificationGas,
      ...(await signPaymaster(op, g)),
    };
  }

  const r = express.Router();
  r.use(express.json({ limit: "1mb" }));
  r.post("/", async (req, res) => {
    const { id, method, params } = req.body as { id: number; method: string; params: unknown[] };
    try {
      let result: unknown;
      if (method === "zd_sponsorUserOperation") result = await sponsor(params[0] as { userOp: RpcOp; entryPointAddress: Address });
      else if (method === "zd_getUserOperationGasPrice") result = await rpc(cfg.bundlerUrl, "pimlico_getUserOperationGasPrice", []);
      else result = await rpc(cfg.bundlerUrl, method, params);
      res.json({ jsonrpc: "2.0", id, result });
    } catch (e) {
      const err = (e as { rpc?: { message: string; code?: number; data?: unknown } }).rpc ?? { code: -32603, message: (e as Error).message };
      res.json({ jsonrpc: "2.0", id, error: err });
    }
  });
  return r;
}
