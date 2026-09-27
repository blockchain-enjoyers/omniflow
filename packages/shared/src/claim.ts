import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { isAddress, isHex, type Address, type Hex } from "viem";

/** One-time claim key. The private part travels only in the link fragment. */
export function generateClaimKey(): { privateKey: Hex; address: Address } {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

export interface ClaimLink {
  chainId: number;
  escrow: Address;
  depositId: Hex;
  key: Hex;
}

/**
 * https://<claim page>/#c=<chainId>&e=<escrow>&id=<depositId>&k=<key>
 * Everything is in the fragment: browsers do not send it to the server that serves the page.
 */
export function formatClaimLink(base: string, l: ClaimLink): string {
  const f = new URLSearchParams({ c: String(l.chainId), e: l.escrow, id: l.depositId, k: l.key });
  return `${base.replace(/#.*$/, "")}#${f.toString()}`;
}

export function parseClaimLink(url: string): ClaimLink {
  const hash = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
  const p = new URLSearchParams(hash);
  const chainId = Number(p.get("c"));
  const escrow = p.get("e") ?? "";
  const depositId = p.get("id") ?? "";
  const key = p.get("k") ?? "";
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("claim link: bad chain id");
  if (!isAddress(escrow)) throw new Error("claim link: bad escrow address");
  if (!isHex(depositId) || depositId.length !== 66) throw new Error("claim link: bad deposit id");
  if (!isHex(key) || key.length !== 66) throw new Error("claim link: bad key");
  return { chainId, escrow, depositId, key };
}

/** EIP-712 Claim in the escrow's domain — matches ClaimEscrow.claimDigest. */
export function claimTypedData(l: Pick<ClaimLink, "chainId" | "escrow" | "depositId">, recipient: Address, deadline: bigint) {
  return {
    domain: { name: "OmniflowClaimEscrow", version: "1", chainId: l.chainId, verifyingContract: l.escrow },
    types: {
      Claim: [
        { name: "id", type: "bytes32" },
        { name: "recipient", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Claim" as const,
    message: { id: l.depositId, recipient, deadline },
  };
}

/** Signs the claim with the key from the link — the page does this, not the person. */
export async function signClaim(l: ClaimLink, recipient: Address, deadline: bigint): Promise<Hex> {
  return privateKeyToAccount(l.key).signTypedData(claimTypedData(l, recipient, deadline));
}
