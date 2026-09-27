import { createPublicClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";

/**
 * LOCAL CHAIN ONLY (anvil, incl. forks). Test-money helpers for emulation and tests — never against a live RPC:
 * they rely on anvil_* methods that real nodes do not have.
 */
export async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount) returns (bool)",
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 allowance) returns (bool)",
]);

/**
 * Credits test tokens on anvil. MockUSDC: open mint. Circle FiatToken on a fork: Circle's own path — impersonate
 * masterMinter, configure a minter, mint. Nothing touches the live network: impersonation exists only in anvil.
 */
export async function mintToken(rpcUrl: string, token: Address, to: Address, amount: bigint) {
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const send = async (from: Address, data: Hex) => {
    await rpc(rpcUrl, "anvil_setBalance", [from, "0x56BC75E2D63100000"]);
    await rpc(rpcUrl, "anvil_impersonateAccount", [from]);
    const hash = await rpc(rpcUrl, "eth_sendTransaction", [{ from, to: token, data }]);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("mint reverted");
  };
  let master: Address | null = null;
  try {
    master = await pub.readContract({ address: token, abi: tokenAbi, functionName: "masterMinter" });
  } catch {
    master = null;
  }
  if (!master) return send("0x00000000000000000000000000000000000da0da", encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [to, amount] }));
  const minter = "0x00000000000000000000000000000000000da0da" as Address;
  await send(master, encodeFunctionData({ abi: tokenAbi, functionName: "configureMinter", args: [minter, amount] }));
  await send(minter, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [to, amount] }));
}

export async function setEthBalance(rpcUrl: string, who: Address, wei: bigint) {
  await rpc(rpcUrl, "anvil_setBalance", [who, `0x${wei.toString(16)}`]);
}
