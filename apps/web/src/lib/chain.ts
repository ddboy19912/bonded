import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { getAbiItem, type Address, type Hex } from "viem";
import {
  bondedRegistryAbi,
  claimsEngineAbi,
  coverManagerAbi,
  mandateModuleFactoryAbi,
  mandateVaultFactoryAbi,
} from "@bondedhq/shared";
import { deployment } from "../config";

/** A paid claim, as emitted by ClaimsEngine.ClaimPaid (docs/SPECIFICATION.md Section 11.2). */
export interface PaidClaim {
  policyId: bigint;
  vault: Address;
  lossBase: bigint;
  payout: bigint;
  premiumNetted: bigint;
  fromBond: bigint;
  fromPool: bigint;
  breachIds: readonly bigint[];
  txHash: Hex;
  blockNumber: bigint;
}

/**
 * Split a claim into what the vault lost and where the money came from. The unpaid part is
 * the deductible, plus anything above the remaining cover.
 */
export function waterfall(
  c: Pick<PaidClaim, "lossBase" | "payout" | "fromBond" | "fromPool" | "premiumNetted">,
) {
  return {
    loss: c.lossBase,
    unpaid: c.lossBase > c.payout ? c.lossBase - c.payout : 0n,
    fromBond: c.fromBond,
    fromPool: c.fromPool,
    premiumNetted: c.premiumNetted,
    toVault: c.payout - c.premiumNetted,
  };
}

/** What claims have put into vaults and accounts in all: each award less the premium netted off it. */
export function totalPaid(claims: readonly Parameters<typeof waterfall>[0][]) {
  return claims.reduce((sum, c) => sum + waterfall(c).toVault, 0n);
}

const fromBlock = BigInt(deployment.deployedAtBlock);

/**
 * A smart account (a Safe, or another ERC-7579 account) protected by a MandateModule. The module
 * holds the breach log and the policy; the account holds the funds and receives the payouts.
 */
export interface ProtectedAccount {
  module: Address;
  account: Address;
  agentId: bigint;
}

/** Where a claim's money went: into a vault, or into the smart account a module guards. */
export type ClaimPayee =
  | { kind: "vault"; address: Address }
  | { kind: "account"; address: Address; module: Address; agentId: bigint };

/** ClaimPaid names the vault or module; for a module the payout went to its account. */
export function claimPayee(
  claim: Pick<PaidClaim, "vault">,
  modules: readonly ProtectedAccount[],
): ClaimPayee {
  const m = modules.find((x) => x.module.toLowerCase() === claim.vault.toLowerCase());
  return m
    ? { kind: "account", address: m.account, module: m.module, agentId: m.agentId }
    : { kind: "vault", address: claim.vault };
}

/**
 * What a module's mandate mode means for cover: only Enforce-mode modules can be insured. In
 * Monitor mode a breach goes through and the payout would go to the account, whose owner could
 * have asked the agent for it, so CoverManager refuses (docs/SPECIFICATION.md Section 11.3).
 */
export function moduleCoverNote(mode: number): { insurable: boolean; label: string } {
  return mode === 1
    ? { insurable: true, label: "Enforce: breaches are blocked; can hold cover" }
    : { insurable: false, label: "Monitor: breaches go through; can't hold cover" };
}

/** ModuleCreated logs as ProtectedAccounts, newest first. */
export function protectedAccounts(
  logs: readonly { module: Address; account: Address; agentId: bigint }[],
): ProtectedAccount[] {
  return logs.map(({ module, account, agentId }) => ({ module, account, agentId })).reverse();
}

/** Every smart account protected by a module, newest first (none before the module factory). */
export function useModules() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["modules"],
    enabled: Boolean(client),
    queryFn: async (): Promise<ProtectedAccount[]> => {
      if (!deployment.moduleFactory) return [];
      const logs = await client!.getLogs({
        address: deployment.moduleFactory,
        event: getAbiItem({ abi: mandateModuleFactoryAbi, name: "ModuleCreated" }),
        fromBlock,
        toBlock: "latest",
        strict: true,
      });
      return protectedAccounts(logs.map((l) => l.args));
    },
  });
}

/** Every paid claim since the deployment, newest first. */
export function useClaims() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["claims"],
    enabled: Boolean(client),
    refetchInterval: 15_000,
    queryFn: async (): Promise<PaidClaim[]> => {
      const logs = await client!.getLogs({
        address: deployment.claimsEngine,
        event: getAbiItem({ abi: claimsEngineAbi, name: "ClaimPaid" }),
        fromBlock,
        toBlock: "latest",
        strict: true,
      });
      return logs
        .map((l) => ({ ...l.args, txHash: l.transactionHash, blockNumber: l.blockNumber }))
        .reverse();
    },
  });
}

/** Every vault created by the factory, newest first. */
export function useVaults() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["vaults"],
    enabled: Boolean(client),
    queryFn: async () => {
      const logs = await client!.getLogs({
        address: deployment.factory,
        event: getAbiItem({ abi: mandateVaultFactoryAbi, name: "VaultCreated" }),
        fromBlock,
        toBlock: "latest",
        strict: true,
      });
      return logs.map((l) => ({ ...l.args, txHash: l.transactionHash })).reverse();
    },
  });
}

/** Policies bound to one vault, newest first (activePolicyOf only shows the current one). */
export function usePolicies(vault: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["policies", vault],
    enabled: Boolean(client),
    queryFn: async () => {
      const logs = await client!.getLogs({
        address: deployment.coverManager,
        event: getAbiItem({ abi: coverManagerAbi, name: "CoverBound" }),
        args: { vault },
        fromBlock,
        toBlock: "latest",
        strict: true,
      });
      return logs.map((l) => l.args.policyId).reverse();
    },
  });
}

/** One registered agent for the Agents list. */
export interface AgentRow {
  agentId: bigint;
  owner: Address;
  /** The registry score, if the agent has ever been rated. */
  score?: { score: number; expectedLossBps: number; expiresAt: bigint };
  /** The agent's newest vault, if it has one. */
  vault?: Address;
  /** The agent's newest protected smart account (module and account), if it has one. */
  protected?: { module: Address; account: Address };
}

/**
 * Join the registry's Registered events, each agent's score, the factory's vaults and the module
 * factory's protected accounts into one row per agent, newest first. An agent with several vaults
 * (or accounts) shows its newest.
 */
export function agentRows(
  registered: readonly { agentId: bigint; owner: Address }[],
  scores: readonly {
    score: number;
    expectedLossBps: number;
    issuedAt: bigint;
    expiresAt: bigint;
  }[],
  vaults: readonly { agentId: bigint; vault: Address }[],
  /** Oldest first, like `vaults`. */
  modules: readonly { agentId: bigint; module: Address; account: Address }[] = [],
): AgentRow[] {
  const newestVault = new Map<bigint, Address>();
  for (const v of vaults) newestVault.set(v.agentId, v.vault);
  const newestModule = new Map<bigint, { module: Address; account: Address }>();
  for (const m of modules) newestModule.set(m.agentId, { module: m.module, account: m.account });
  return registered
    .map((r, i) => {
      const s = scores[i];
      const vault = newestVault.get(r.agentId);
      const guarded = newestModule.get(r.agentId);
      return {
        agentId: r.agentId,
        owner: r.owner,
        ...(s && s.issuedAt > 0n
          ? {
              score: { score: s.score, expectedLossBps: s.expectedLossBps, expiresAt: s.expiresAt },
            }
          : {}),
        ...(vault ? { vault } : {}),
        ...(guarded ? { protected: guarded } : {}),
      };
    })
    .reverse();
}

/** Every agent registered in BondedRegistry, with its score and vault, newest first. */
export function useAgents() {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["agents"],
    enabled: Boolean(client),
    refetchInterval: 30_000,
    queryFn: async (): Promise<AgentRow[]> => {
      const [registered, vaults, modules] = await Promise.all([
        client!.getLogs({
          address: deployment.registry,
          event: getAbiItem({ abi: bondedRegistryAbi, name: "Registered" }),
          fromBlock,
          toBlock: "latest",
          strict: true,
        }),
        client!.getLogs({
          address: deployment.factory,
          event: getAbiItem({ abi: mandateVaultFactoryAbi, name: "VaultCreated" }),
          fromBlock,
          toBlock: "latest",
          strict: true,
        }),
        deployment.moduleFactory
          ? client!.getLogs({
              address: deployment.moduleFactory,
              event: getAbiItem({ abi: mandateModuleFactoryAbi, name: "ModuleCreated" }),
              fromBlock,
              toBlock: "latest",
              strict: true,
            })
          : Promise.resolve([]),
      ]);
      // One read per agent; the local demo chain has no multicall contract to batch them.
      const scores = await Promise.all(
        registered.map((r) =>
          client!.readContract({
            address: deployment.registry,
            abi: bondedRegistryAbi,
            functionName: "scoreOf",
            args: [r.args.agentId],
          }),
        ),
      );
      return agentRows(
        registered.map((r) => r.args),
        scores,
        vaults.map((v) => v.args),
        modules.map((m) => m.args),
      );
    },
  });
}
