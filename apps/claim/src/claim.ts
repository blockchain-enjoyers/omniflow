import { createPublicClient, createWalletClient, custom, erc20Abi, http, type Address, type EIP1193Provider, type Hex } from "viem";
import { claimEscrowAbi, DepositStatus, signClaim, type ClaimLink } from "@omniflow/shared";

export interface DepositView {
  amount: bigint;
  decimals: number;
  symbol: string;
  status: DepositStatus;
  autoRefundAt: number;
}

const chainOf = (id: number, rpc: string) => ({ id, name: `chain-${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

export async function readDeposit(link: ClaimLink, rpc: string): Promise<DepositView> {
  const pub = createPublicClient({ chain: chainOf(link.chainId, rpc), transport: http(rpc) });
  const d = await pub.readContract({ address: link.escrow, abi: claimEscrowAbi, functionName: "getDeposit", args: [link.depositId] });
  const [decimals, symbol] = await Promise.all([
    pub.readContract({ address: d.token, abi: erc20Abi, functionName: "decimals" }),
    pub.readContract({ address: d.token, abi: erc20Abi, functionName: "symbol" }),
  ]);
  return { amount: d.amount, decimals, symbol, status: d.status as DepositStatus, autoRefundAt: d.autoRefundAt };
}

/**
 * The claim deadline is checked against block.timestamp, so it is taken from the chain, not from this computer's
 * clock: a skewed clock (or a test chain moved forward in time) would otherwise make every claim "expired".
 */
export async function chainDeadline(link: ClaimLink, rpc: string, seconds = 3600): Promise<bigint> {
  const pub = createPublicClient({ chain: chainOf(link.chainId, rpc), transport: http(rpc) });
  const b = await pub.getBlock({ blockTag: "latest" });
  return b.timestamp + BigInt(seconds);
}

/** Claims via the Omniflow relayer: no gas needed from the recipient. */
export async function claimViaRelayer(relayer: string, link: ClaimLink, recipient: Address, rpc: string): Promise<Hex> {
  const deadline = await chainDeadline(link, rpc);
  const signature = await signClaim(link, recipient, deadline);
  const r = await fetch(`${relayer.replace(/\/$/, "")}/claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ escrow: link.escrow, depositId: link.depositId, recipient, deadline: deadline.toString(), signature }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? "relayer refused");
  return body.txHash;
}

/** Claims with the recipient's own wallet — works with no Omniflow service at all. */
export async function claimWithOwnWallet(provider: EIP1193Provider, link: ClaimLink, rpc: string): Promise<{ hash: Hex; recipient: Address }> {
  const wallet = createWalletClient({ chain: chainOf(link.chainId, rpc), transport: custom(provider) });
  const [recipient] = await wallet.requestAddresses();
  if (!recipient) throw new Error("wallet returned no address");
  const deadline = await chainDeadline(link, rpc);
  const signature = await signClaim(link, recipient, deadline);
  const hash = await wallet.writeContract({ account: recipient, address: link.escrow, abi: claimEscrowAbi, functionName: "claim", args: [link.depositId, recipient, deadline, signature] });
  const pub = createPublicClient({ chain: chainOf(link.chainId, rpc), transport: http(rpc) });
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error("claim transaction reverted");
  return { hash, recipient };
}
