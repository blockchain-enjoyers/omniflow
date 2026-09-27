import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { ChainClient } from "../src/chain/chain.js";
import { SUBMITTER_KEY } from "./helpers.js";

/** An RPC that behaves like public ones: ranges wider than `cap` blocks are refused. Records what was asked. */
function withFakeRpc(cap: bigint, logChunkBlocks?: number) {
  const chain = new ChainClient({ chainId: 421614, rpcUrl: "http://127.0.0.1:9", entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", submitterKey: SUBMITTER_KEY, logChunkBlocks });
  const asked: [bigint, bigint][] = [];
  const refused: [bigint, bigint][] = [];
  (chain as unknown as { pub: unknown }).pub = {
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > cap) {
        refused.push([fromBlock, toBlock]);
        throw new Error("query exceeds max block range");
      }
      asked.push([fromBlock, toBlock]);
      return [];
    },
  };
  return { chain, asked, refused };
}

/** Every block in [from, to] exactly once, ranges in order. */
function coversExactly(ranges: [bigint, bigint][], from: bigint, to: bigint) {
  let next = from;
  for (const [a, b] of ranges) {
    expect(a).toBe(next);
    expect(b >= a).toBe(true);
    next = b + 1n;
  }
  expect(next).toBe(to + 1n);
}

const ESCROW = "0x0000000000000000000000000000000000000001" as Address;

describe("indexer ranges", () => {
  it("a long gap is scanned in bounded chunks that cover every block once", () => {
    const { chain } = withFakeRpc(10_000n, 2000);
    const from = 250_000_000n;
    const to = from + 350_000n; // ~a day of Arbitrum blocks
    const chunks = chain.chunks(from, to);
    expect(chunks.every(([a, b]) => b - a + 1n <= 2000n)).toBe(true);
    coversExactly(chunks, from, to);
  });

  it("a range the RPC refuses is split in half until it is accepted — nothing skipped, nothing twice", async () => {
    const { chain, asked, refused } = withFakeRpc(300n, 2000);
    const from = 1_000n;
    for (const [a, b] of chain.chunks(from, from + 4_999n)) await chain.escrowEvents(ESCROW, a, b);
    expect(refused.length).toBeGreaterThan(0);
    expect(asked.every(([a, b]) => b - a + 1n <= 300n)).toBe(true);
    coversExactly(asked, from, from + 4_999n);
  });

  it("a failure on a single block is a real failure, not an endless split", async () => {
    const { chain } = withFakeRpc(0n);
    await expect(chain.escrowEvents(ESCROW, 5n, 5n)).rejects.toThrow(/max block range/);
  });
});
