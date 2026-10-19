import { tierForScore } from "@bondedhq/shared";
import type { Address } from "viem";
import type { AgentRow, PaidClaim } from "./chain";
import { waterfall } from "./chain";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Largest first, for bigints of any size. */
const desc = (a: bigint, b: bigint) => (b > a ? 1 : b < a ? -1 : 0);

export interface AgentFilters {
  show: "all" | "rated" | "mine";
  /** A tier letter, "unrated", or "all". */
  tier: string;
  vault: "any" | "with" | "without";
  sort: "newest" | "score";
}

/** The Agents list after its filters and sort. `you` is the connected wallet, if any. */
export function filterAgents(rows: readonly AgentRow[], f: AgentFilters, you?: Address) {
  return rows
    .filter((a) => {
      if (f.show === "rated" && !a.score) return false;
      if (f.show === "mine" && !(you && same(a.owner, you))) return false;
      if (f.tier === "unrated" && a.score) return false;
      if (f.tier !== "all" && f.tier !== "unrated")
        if (!a.score || tierForScore(a.score.score).tier !== f.tier) return false;
      // A protected smart account counts: it's where that agent's funds and cover are.
      const holds = Boolean(a.vault || a.protected);
      if (f.vault === "with" && !holds) return false;
      if (f.vault === "without" && holds) return false;
      return true;
    })
    .sort((x, y) =>
      f.sort === "score"
        ? (y.score?.securityScore ?? -1) - (x.score?.securityScore ?? -1) ||
          desc(x.agentId, y.agentId)
        : desc(x.agentId, y.agentId),
    );
}

export interface VaultRow {
  vault: Address;
  agentId: bigint;
  guardian: Address;
  assets?: bigint;
  frozen?: boolean;
  covered: boolean;
}

export interface VaultFilters {
  state: "all" | "covered" | "uncovered" | "frozen";
  sort: "newest" | "assets";
}

/** The Vaults list after its filters and sort. Rows arrive newest first. */
export function filterVaults(rows: readonly VaultRow[], f: VaultFilters) {
  const kept = rows.filter((v) =>
    f.state === "covered"
      ? v.covered
      : f.state === "uncovered"
        ? !v.covered
        : f.state === "frozen"
          ? v.frozen === true
          : true,
  );
  return f.sort === "assets"
    ? [...kept].sort((a, b) => desc(a.assets ?? 0n, b.assets ?? 0n))
    : kept;
}

export interface ClaimFilters {
  /** A vault address, or "all". */
  vault: string;
  sort: "newest" | "amount";
}

/** The Claims list after its filters and sort. Claims arrive newest first. */
export function filterClaims(claims: readonly PaidClaim[], f: ClaimFilters) {
  const kept = claims.filter((c) => f.vault === "all" || same(c.vault, f.vault));
  return f.sort === "amount"
    ? [...kept].sort((a, b) => desc(waterfall(a).toVault, waterfall(b).toVault))
    : kept;
}
