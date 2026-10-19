import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { AgentRow, PaidClaim } from "./chain";
import { filterAgents, filterClaims, filterVaults, type VaultRow } from "./lists";

const you = "0x00000000000000000000000000000000000000aa" as Address;
const other = "0x00000000000000000000000000000000000000bb" as Address;
const agent = (id: number, score?: number, vault = false, owner = other): AgentRow => ({
  agentId: BigInt(id),
  owner,
  ...(score !== undefined
    ? { score: { score, securityScore: score, expectedLossBps: 100, expiresAt: 9n } }
    : {}),
  ...(vault ? { vault: `0x${String(id).padStart(40, "0")}` as Address } : {}),
});
const ids = (rows: { agentId: bigint }[]) => rows.map((a) => Number(a.agentId));

describe("filterAgents", () => {
  const rows = [agent(1, 96, true), agent(2), agent(3, 81, false, you), agent(4, 85, true, you)];
  const base = { show: "all", tier: "all", vault: "any", sort: "newest" } as const;

  it("lists newest first, or by score with unrated last", () => {
    expect(ids(filterAgents(rows, base))).toEqual([4, 3, 2, 1]);
    expect(ids(filterAgents(rows, { ...base, sort: "score" }))).toEqual([1, 4, 3, 2]);
  });

  it("orders by security while insurance tiers still filter by expected loss", () => {
    const strong = agent(1, 40);
    const weak = agent(2, 96);
    strong.score!.securityScore = 90;
    weak.score!.securityScore = 20;
    const rows = [weak, strong, agent(3)];
    expect(ids(filterAgents(rows, { ...base, sort: "score" }))).toEqual([1, 2, 3]);
    expect(ids(filterAgents(rows, { ...base, tier: "AAA" }))).toEqual([2]);
  });

  it("filters by tab, tier and vault", () => {
    expect(ids(filterAgents(rows, { ...base, show: "rated" }))).toEqual([4, 3, 1]);
    expect(ids(filterAgents(rows, { ...base, show: "mine" }, you))).toEqual([4, 3]);
    expect(ids(filterAgents(rows, { ...base, show: "mine" }))).toEqual([]);
    expect(ids(filterAgents(rows, { ...base, tier: "AA" }))).toEqual([4, 3]);
    expect(ids(filterAgents(rows, { ...base, tier: "AAA" }))).toEqual([1]);
    expect(ids(filterAgents(rows, { ...base, tier: "unrated" }))).toEqual([2]);
    expect(ids(filterAgents(rows, { ...base, vault: "with" }))).toEqual([4, 1]);
    expect(ids(filterAgents(rows, { ...base, vault: "without" }))).toEqual([3, 2]);
  });

  it("counts a protected smart account like a vault", () => {
    const account = { ...agent(5), protected: { module: you, account: other } };
    expect(ids(filterAgents([...rows, account], { ...base, vault: "with" }))).toEqual([5, 4, 1]);
    expect(ids(filterAgents([...rows, account], { ...base, vault: "without" }))).toEqual([3, 2]);
  });
});

describe("filterVaults", () => {
  const v = (id: number, assets: bigint, covered: boolean, frozen = false): VaultRow => ({
    vault: `0x${String(id).padStart(40, "0")}` as Address,
    agentId: BigInt(id),
    guardian: other,
    assets,
    frozen,
    covered,
  });
  const rows = [v(3, 5n, true), v(2, 50n, false, true), v(1, 10n ** 30n, true)];
  it("filters by cover and state, and sorts by assets", () => {
    expect(ids(filterVaults(rows, { state: "covered", sort: "newest" }))).toEqual([3, 1]);
    expect(ids(filterVaults(rows, { state: "uncovered", sort: "newest" }))).toEqual([2]);
    expect(ids(filterVaults(rows, { state: "frozen", sort: "newest" }))).toEqual([2]);
    expect(ids(filterVaults(rows, { state: "all", sort: "assets" }))).toEqual([1, 2, 3]);
  });
});

describe("filterClaims", () => {
  const claim = (vault: string, payout: bigint): PaidClaim => ({
    policyId: 1n,
    vault: vault as Address,
    lossBase: payout,
    payout,
    premiumNetted: 0n,
    fromBond: payout,
    fromPool: 0n,
    breachIds: [1n],
    txHash: "0x1",
    blockNumber: 1n,
  });
  const claims = [claim(you, 100n), claim(other, 900n), claim(you, 400n)];
  it("filters by vault, any case, and sorts by amount paid", () => {
    expect(filterClaims(claims, { vault: you.toUpperCase(), sort: "newest" })).toHaveLength(2);
    expect(filterClaims(claims, { vault: "all", sort: "amount" }).map((c) => c.payout)).toEqual([
      900n,
      400n,
      100n,
    ]);
  });
});
