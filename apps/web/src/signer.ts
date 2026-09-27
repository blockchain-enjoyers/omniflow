import { createWalletClient, custom, type Address, type Hex } from "viem";

/** Only `request` is needed; Privy's and viem's EIP-1193 types differ in their event signatures. */
export interface RequestProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}
import { privateKeyToAccount } from "viem/accounts";

/** What an approver needs: sign Approve(hash) typed data, and personal_sign the raw userOpHash (final). */
export interface ApproverSigner {
  address: Address;
  signTypedData(td: unknown): Promise<Hex>;
  signHash(hash: Hex): Promise<Hex>;
}

/**
 * Privy embedded wallet through its EIP-1193 provider (`wallet.getEthereumProvider()`, SDK types).
 * personal_sign with 0x-hex data signs the bytes — needed for the 32-byte userOpHash.
 * NB Privy shows its prompt unless `showWalletUIs` is false; that flag is set by frontend code.
 */
export async function signerFromProvider(provider: RequestProvider, address: Address): Promise<ApproverSigner> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = createWalletClient({ account: address, transport: custom({ request: (a: any) => provider.request(a) as any }) });
  return {
    address,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData: (td) => w.signTypedData({ account: address, ...(td as any) }),
    signHash: (hash) => w.signMessage({ account: address, message: { raw: hash } }),
  };
}

/** DEV BUILDS ONLY: a local test key, so the whole slice can run against anvil without Privy. */
export function devSigner(privateKey: Hex): ApproverSigner {
  if (!import.meta.env.DEV && import.meta.env.MODE !== "e2e") throw new Error("dev signer is disabled in production builds");
  const a = privateKeyToAccount(privateKey);
  return {
    address: a.address,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTypedData: (td) => a.signTypedData(td as any),
    signHash: (hash) => a.signMessage({ message: { raw: hash } }),
  };
}
