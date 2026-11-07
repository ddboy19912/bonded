import { describe, expect, it } from "vitest";
import {
  agentRows,
  allLogs,
  blockRanges,
  claimPayee,
  moduleCoverNote,
  protectedAccounts,
  totalPaid,
  waterfall,
} from "./chain";

it("splits the Gate 1 testnet claim like the contract did", () => {
  // ClaimPaid for policy 1 on chain 46630 (docs/progress/DAY-07.md).
  expect(
    waterfall({
      lossBase: 1_000_000_000n,
      payout: 900_000_000n,
      fromBond: 900_000_000n,
      fromPool: 0n,
      premiumNetted: 0n,
    }),
  ).toEqual({
    loss: 1_000_000_000n,
    unpaid: 100_000_000n,
    fromBond: 900_000_000n,
    fromPool: 0n,
    premiumNetted: 0n,
    toVault: 900_000_000n,
  });
});

it("nets owed premium out of what reaches the vault", () => {
  const w = waterfall({
    lossBase: 5_000n,
    payout: 4_500n,
    fromBond: 1_000n,
    fromPool: 3_500n,
    premiumNetted: 200n,
  });
  expect(w.toVault).toBe(4_300n);
  expect(w.fromBond + w.fromPool).toBe(4_500n);
});

it("totals what reached vaults, not the gross awards", () => {
  const claim = (payout: bigint, premiumNetted: bigint) => ({
    lossBase: 5_000n,
    payout,
    fromBond: payout - premiumNetted,
    fromPool: 0n,
    premiumNetted,
  });
  // The first claim netted 200 of unpaid premium: 4,300 reached the vault, not 4,500.
  expect(totalPaid([claim(4_500n, 200n), claim(900n, 0n)])).toBe(5_200n);
  expect(totalPaid([])).toBe(0n);
});

it("lists agents newest first, with their score and newest vault", () => {
  const a = "0x00000000000000000000000000000000000000aa" as const;
  const b = "0x00000000000000000000000000000000000000bb" as const;
  const v1 = "0x0000000000000000000000000000000000000001" as const;
  const v2 = "0x0000000000000000000000000000000000000002" as const;
  const rated = {
    score: 49,
    securityScore: 72,
    expectedLossBps: 511,
    issuedAt: 100n,
    expiresAt: 200n,
  };
  const unrated = { score: 0, securityScore: 0, expectedLossBps: 0, issuedAt: 0n, expiresAt: 0n };
  const rows = agentRows(
    [
      { agentId: 1n, owner: a },
      { agentId: 2n, owner: b },
    ],
    [rated, unrated],
    [
      { agentId: 1n, vault: v1 },
      { agentId: 1n, vault: v2 },
    ],
  );
  expect(rows).toEqual([
    { agentId: 2n, owner: b },
    {
      agentId: 1n,
      owner: a,
      score: { score: 49, securityScore: 72, expectedLossBps: 511, expiresAt: 200n },
      vault: v2,
    },
  ]);
});

describe("smart accounts protected by a MandateModule", () => {
  const module1 = "0x00000000000000000000000000000000000000d1" as const;
  const module2 = "0x00000000000000000000000000000000000000d2" as const;
  const account1 = "0x00000000000000000000000000000000000000a1" as const;
  const account2 = "0x00000000000000000000000000000000000000a2" as const;
  const vault = "0x00000000000000000000000000000000000000f1" as const;
  // ModuleCreated logs, oldest first, as the chain returns them.
  const logs = [
    { module: module1, account: account1, agentId: 1n },
    { module: module2, account: account2, agentId: 1n },
  ];

  it("only offers cover for Enforce-mode modules", () => {
    expect(moduleCoverNote(1).insurable).toBe(true);
    expect(moduleCoverNote(0)).toEqual({
      insurable: false,
      label: "Monitor: breaches go through; can't hold cover",
    });
  });

  it("lists protected accounts newest first", () => {
    expect(protectedAccounts(logs).map((p) => p.module)).toEqual([module2, module1]);
  });

  it("says a module's claim was paid into its account, and a vault's into the vault", () => {
    const modules = protectedAccounts(logs);
    // ClaimPaid logs carry checksummed addresses; the match ignores case.
    const checksummed = "0x00000000000000000000000000000000000000D1" as const;
    expect(claimPayee({ vault: checksummed }, modules)).toEqual({
      kind: "account",
      address: account1,
      module: module1,
      agentId: 1n,
    });
    expect(claimPayee({ vault }, modules)).toEqual({ kind: "vault", address: vault });
  });

  it("gives an agent its newest protected account next to its vault", () => {
    const owner = "0x00000000000000000000000000000000000000aa" as const;
    const unrated = { score: 0, securityScore: 0, expectedLossBps: 0, issuedAt: 0n, expiresAt: 0n };
    const rows = agentRows(
      [
        { agentId: 1n, owner },
        { agentId: 2n, owner },
      ],
      [unrated, unrated],
      [{ agentId: 2n, vault }],
      logs,
    );
    expect(rows).toEqual([
      { agentId: 2n, owner, vault },
      { agentId: 1n, owner, protected: { module: module2, account: account2 } },
    ]);
  });
});

describe("log ranges", () => {
  it("keeps every range inside the RPC limit, with no gaps or overlaps", () => {
    // The request the testnet RPC refused on 2026-11-07: 10,336,780 blocks in one query.
    expect(blockRanges(139_637_933n, 149_974_712n)).toEqual([
      { fromBlock: 139_637_933n, toBlock: 149_637_932n },
      { fromBlock: 149_637_933n, toBlock: 149_974_712n },
    ]);
  });

  it("uses one range when the span fits exactly, and handles a single block", () => {
    expect(blockRanges(1n, 10n, 10n)).toEqual([{ fromBlock: 1n, toBlock: 10n }]);
    expect(blockRanges(1n, 11n, 10n)).toEqual([
      { fromBlock: 1n, toBlock: 10n },
      { fromBlock: 11n, toBlock: 11n },
    ]);
    expect(blockRanges(5n, 5n)).toEqual([{ fromBlock: 5n, toBlock: 5n }]);
  });

  it("has nothing to search when the start is past the tip", () => {
    expect(blockRanges(6n, 5n)).toEqual([]);
  });

  it("merges each range's logs oldest first, whichever request finishes first", async () => {
    const client = { getBlockNumber: async () => 25_000_000n };
    const logs = await allLogs(
      client,
      async ({ fromBlock, toBlock }) => {
        // The oldest range answers last.
        if (fromBlock === 0n) await new Promise((r) => setTimeout(r, 5));
        return [`${fromBlock}-${toBlock}`];
      },
      0n,
    );
    expect(logs).toEqual(["0-9999999", "10000000-19999999", "20000000-25000000"]);
  });

  it("fails if any range fails, rather than showing a partial total", async () => {
    const client = { getBlockNumber: async () => 15_000_000n };
    await expect(
      allLogs(
        client,
        async ({ fromBlock }) => {
          if (fromBlock > 0n) throw new Error("rpc down");
          return ["log"];
        },
        0n,
      ),
    ).rejects.toThrow("rpc down");
  });
});
