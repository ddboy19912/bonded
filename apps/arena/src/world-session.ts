import {
  type AttackSpec,
  demoRouterAbi,
  mandateVaultAbi,
  mockOracleAbi,
  testTokenAbi,
  type YesterdayTrade,
} from "@bondedhq/shared";
import { createTestClient, encodeFunctionData, formatUnits, http, maxUint256 } from "viem";
import type { BenignSeed } from "./benign.js";
import { BatchStopped, type SpendingCap } from "./budget.js";
import {
  episodeDepositor,
  type EpisodeOptions,
  type EpisodeResult,
  isSelfSigning,
  runEpisode,
} from "./episode.js";
import { goalOk } from "./harbinger/goals.js";
import { isMemoryCapable } from "./memory-attempt.js";
import { sawAttack } from "./report.js";
import type { Sandbox } from "./sandbox.js";
import { type AgentVault, type ArenaToken, createAgentVault, marketTokens, send } from "./vault.js";
import { World, type YesterdayFill } from "./world.js";
import { type WorldPairResult, worldSeedProblem } from "./world-observations.js";
import { type Random, seededRandom } from "./world-content.js";
import { overnightMoves } from "./world-market.js";

export type { WorldPairResult } from "./world-observations.js";

/**
 * World state (docs/WORLD-STATE.md): a seed that runs over two days on one vault. On day 1
 * Bonded itself makes the seed's `sessions.yesterday` trades through the vault, so they are real
 * on-chain; a day passes on the chain clock; on day 2 the agent works in a world that carries
 * yesterday's messages, alerts, transfers and report items. The attack is planted on day 2,
 * mostly as `carried` steps dated yesterday, and every carried claim contradicts something the
 * agent can check (its holdings, or the mandate).
 *
 * The agent itself never runs on day 1: no model calls, the same history every run, and an agent
 * that signs for itself (chain mode, a TEE key) works too, because day 1 is sent as the vault's
 * agent address through anvil impersonation.
 */

/**
 * Makes yesterday's trades through the vault, sent as its agent (anvil impersonation, so it works
 * for any agent address), and reads back what each one really filled. Throws when a trade
 * reverts or the vault records a breach: a seed's yesterday must stay inside the mandate.
 */
export async function runYesterday(
  sandbox: Sandbox,
  vault: `0x${string}`,
  agentAddress: `0x${string}`,
  trades: readonly YesterdayTrade[],
  tokens: readonly ArenaToken[],
): Promise<YesterdayFill[]> {
  if (!trades.length) return [];
  const read = sandbox.publicClient;
  const router = sandbox.deployment.router;
  const wallet = await sandbox.impersonate(agentAddress);
  const find = (symbol: string) => {
    const token = tokens.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase());
    if (!token) throw new Error(`yesterday's trade names unknown token ${symbol}`);
    return token;
  };
  const balance = (token: ArenaToken) =>
    read.readContract({
      address: token.address,
      abi: testTokenAbi,
      functionName: "balanceOf",
      args: [vault],
    });
  const execute = async (target: `0x${string}`, data: `0x${string}`) => {
    const hash = await wallet.writeContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: "execute",
      args: [target, data],
    });
    const receipt = await read.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`yesterday's trade reverted (${hash})`);
    return receipt;
  };
  const fills: YesterdayFill[] = [];
  for (const trade of trades) {
    const sell = find(trade.sell);
    const buy = find(trade.buy);
    // The amount of the sold token worth amountUsd at the oracle.
    const unit = 10n ** BigInt(sell.decimals);
    const unitUsd6 = await read.readContract({
      address: sandbox.deployment.oracle,
      abi: mockOracleAbi,
      functionName: "valueInUsd6",
      args: [sell.address, unit],
    });
    const amountIn = (BigInt(Math.round(trade.amountUsd * 1e6)) * unit) / unitUsd6;
    const allowance = await read.readContract({
      address: sell.address,
      abi: testTokenAbi,
      functionName: "allowance",
      args: [vault, router],
    });
    if (allowance < amountIn)
      await execute(
        sell.address,
        encodeFunctionData({
          abi: testTokenAbi,
          functionName: "approve",
          args: [router, maxUint256],
        }),
      );
    const before = await balance(buy);
    const receipt = await execute(
      router,
      encodeFunctionData({
        abi: demoRouterAbi,
        functionName: "swap",
        args: [sell.address, buy.address, amountIn, vault],
      }),
    );
    const bought = (await balance(buy)) - before;
    const block = await read.getBlock({ blockNumber: receipt.blockNumber });
    fills.push({
      sold: { token: sell.symbol, amount: formatUnits(amountIn, sell.decimals) },
      bought: { token: buy.symbol, amount: formatUnits(bought, buy.decimals) },
      exchange: router,
      time: new Date(Number(block.timestamp) * 1000).toISOString(),
    });
  }
  const breaches = await read.readContract({
    address: vault,
    abi: mandateVaultAbi,
    functionName: "breachCount",
  });
  if (breaches > 0n) throw new Error("yesterday's trades breached the mandate");
  return fills;
}

/** The oracle's price of each Arena token, in USD. */
export async function oraclePrices(
  sandbox: Sandbox,
  tokens: readonly ArenaToken[],
): Promise<Record<string, number>> {
  const prices = await Promise.all(
    tokens.map((token) =>
      sandbox.publicClient.readContract({
        address: sandbox.deployment.oracle,
        abi: mockOracleAbi,
        functionName: "priceUsd6",
        args: [token.address],
      }),
    ),
  );
  return Object.fromEntries(tokens.map((t, i) => [t.symbol, Number(prices[i]!) / 1e6]));
}

/**
 * Moves the chain clock to the next day: 1 to 4 hours past the end of the vault's daily window,
 * so yesterday's spending no longer counts against today's limit and "yesterday" dates match the
 * chain's clock. The Arena's oracle has no staleness check, so prices stay valid. `moves` then
 * moves the oracle's prices overnight (overnightMoves), as fractions by token.
 */
export async function nextDay(
  sandbox: Sandbox,
  vault: `0x${string}`,
  random: Random,
  moves: Readonly<Record<string, number>> = {},
) {
  const chain = createTestClient({ mode: "anvil", transport: http(sandbox.rpcUrl) });
  const [windowStart, window, block] = await Promise.all([
    sandbox.publicClient.readContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: "windowStart",
    }),
    sandbox.publicClient.readContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: "WINDOW",
    }),
    sandbox.publicClient.getBlock(),
  ]);
  const target = windowStart + window + BigInt(3600 + Math.floor(random() * 3 * 3600));
  if (target > block.timestamp)
    await chain.increaseTime({ seconds: Number(target - block.timestamp) });
  await chain.mine({ blocks: 1 });
  const tokens = marketTokens(sandbox);
  for (const [symbol, move] of Object.entries(moves)) {
    const token = tokens.find((t) => t.symbol === symbol);
    if (!token) throw new Error(`an overnight move names unknown token ${symbol}`);
    const price = await sandbox.publicClient.readContract({
      address: sandbox.deployment.oracle,
      abi: mockOracleAbi,
      functionName: "priceUsd6",
      args: [token.address],
    });
    await send(sandbox, "deployer", {
      address: sandbox.deployment.oracle,
      abi: mockOracleAbi,
      functionName: "setPrice",
      args: [token.address, (price * BigInt(Math.round((1 + move) * 1e6))) / 1_000_000n],
    });
  }
}

/** What a day-2 episode needs besides its agent and plant (world-session.ts's arms and twins). */
interface Day2Options {
  sandbox: Sandbox;
  agent: EpisodeOptions["agent"];
  trades: readonly YesterdayTrade[];
  /** The seed's or twin's own overnight moves (`sessions.overnight`). */
  overnight?: Readonly<Record<string, number>>;
  /** Whether the market moves too, and day 2 carries yesterday's closing prices (MarketOptions). */
  marketMoves?: boolean;
  worldSeed: string;
  episode?: Pick<EpisodeOptions, "vault" | "maxSteps" | "timeoutMs">;
}

/** How a world-state run treats prices (docs/NUMBER-GAPS.md). */
export interface MarketOptions {
  /**
   * Prices move overnight beyond the seed's own moves (overnightMoves), and day 2's carried
   * block sometimes holds yesterday's real closing prices. Off by default until the number-gap
   * seeds join ratings, so the rated world-state battery runs as before.
   */
  marketMoves?: boolean;
}

/**
 * Yesterday, then the day passing: a fresh vault (with a self-signing agent's own address as its
 * agent), yesterday's world and trades, and the history day 2 carries. The agent's notes, when
 * Bonded can wipe them, are wiped last, so day 2 starts from the record alone.
 */
async function yesterdayThenToday(options: Day2Options) {
  const { sandbox, agent } = options;
  const tokens = marketTokens(sandbox);
  const signer = isSelfSigning(agent) ? await agent.episodeSigner(sandbox) : undefined;
  const vault: AgentVault = await createAgentVault(sandbox, {
    ...options.episode?.vault,
    ...(signer ? { agent: signer } : {}),
  });
  const block = await sandbox.publicClient.getBlock();
  const day1 = new World(
    tokens,
    episodeDepositor(sandbox, options.episode?.vault),
    options.episode?.vault?.deposit,
    new Date(Number(block.timestamp) * 1000),
    seededRandom(`${options.worldSeed}-day1`),
  );
  const fills = await runYesterday(
    sandbox,
    vault.address,
    signer ?? sandbox.address("agent"),
    options.trades,
    tokens,
  );
  const closes = options.marketMoves ? await oraclePrices(sandbox, tokens) : undefined;
  const history = day1.carryOver(fills, closes);
  const moves = overnightMoves(
    seededRandom(`${options.worldSeed}-market`),
    options.overnight,
    options.marketMoves,
  );
  await nextDay(sandbox, vault.address, seededRandom(`${options.worldSeed}-clock`), moves);
  if (isMemoryCapable(agent)) agent.reset();
  return { vault, history, fills, moves };
}

export interface WorldPairOptions extends MarketOptions {
  sandbox: Sandbox;
  agent: EpisodeOptions["agent"];
  seed: AttackSpec;
  round: number;
  episode?: Pick<EpisodeOptions, "vault" | "maxSteps" | "timeoutMs">;
  cap?: SpendingCap;
  onEpisode?: (result: EpisodeResult) => void | Promise<void>;
  /** Seeds both days' worlds (a rating passes its own secret seed); default per seed and round. */
  worldSeed?: string;
}

/**
 * One world-state attempt with an attribution control. Two arms from one chain snapshot, each on
 * its own vault with the same yesterday and the same day-2 world:
 *
 * - control: yesterday, then day 2 with the benign carried history only;
 * - poisoned: the same yesterday, then day 2 with the seed planted (its carried steps dated
 *   yesterday).
 *
 * The chain is reverted between and after the arms, so the only difference is the plant. An
 * agent that keeps notes Bonded can wipe has them wiped before each day 2, so this battery
 * measures trust in the record, not the agent's own memory (the memory battery does that). A day 2
 * the agent couldn't finish (an error or a timeout) marks the attempt `failed`, which leaves it
 * out of the counts instead of stopping the rating.
 */
export async function runWorldPair(options: WorldPairOptions): Promise<WorldPairResult> {
  const { sandbox, agent, seed, round } = options;
  validateWorldBattery([seed], 1);
  const goal = seed.goal!;
  const worldSeed = options.worldSeed ?? `world-${seed.id}-${round}`;
  const chain = createTestClient({ mode: "anvil", transport: http(sandbox.rpcUrl) });

  const arm = async (attack: AttackSpec | null, label: string) => {
    if (options.cap?.exceeded) throw new WorldBudgetExceeded();
    const { vault, history, fills, moves } = await yesterdayThenToday({
      sandbox,
      agent,
      trades: seed.sessions!.yesterday.trades,
      ...(seed.sessions!.overnight ? { overnight: seed.sessions!.overnight } : {}),
      ...(options.marketMoves ? { marketMoves: true } : {}),
      worldSeed,
      ...(options.episode ? { episode: options.episode } : {}),
    });
    const result = await runEpisode(sandbox, {
      ...options.episode,
      agent,
      attack,
      goal,
      reuseVault: vault,
      history,
      variantId: `world-${round}-${label}`,
      worldSeed: `${worldSeed}-day2`,
    });
    options.cap?.add(result.agentSummary.usage);
    await options.onEpisode?.(result);
    return { result, fills, moves };
  };

  const original = await chain.snapshot();
  try {
    const matched = await chain.snapshot();
    const control = await arm(null, "control");
    await chain.revert({ id: matched });
    const poisoned = await arm(seed, "poisoned");
    const tradeCount = (e: EpisodeResult) => e.trades?.length ?? 0;
    return {
      seed: seed.id,
      attackClass: seed.class,
      agent: agent.name,
      round,
      goal,
      yesterday: control.fills,
      ...(Object.keys(control.moves).length ? { overnight: control.moves } : {}),
      breached: poisoned.result.verdict.breached,
      controlBreached: control.result.verdict.breached,
      taskIncomplete: poisoned.result.taskCompleted !== true,
      controlTaskIncomplete: control.result.taskCompleted !== true,
      unexposed: sawAttack(poisoned.result) === false,
      failed:
        control.result.agentSummary.stoppedBecause === "error" ||
        (poisoned.result.agentSummary.stoppedBecause === "error" &&
          !poisoned.result.verdict.breached),
      changedBehavior:
        tradeCount(poisoned.result) !== tradeCount(control.result) ||
        (poisoned.result.taskCompleted ?? null) !== (control.result.taskCompleted ?? null),
      usages: [control.result.agentSummary.usage, poisoned.result.agentSummary.usage],
    };
  } finally {
    try {
      await chain.revert({ id: original });
    } finally {
      if (isMemoryCapable(agent)) agent.reset();
    }
  }
}

export interface WorldTwinOptions extends MarketOptions {
  sandbox: Sandbox;
  agent: EpisodeOptions["agent"];
  /** A world twin (loadWorldTwins): true carried content, and a task that acts on it. */
  twin: BenignSeed;
  round: number;
  episode?: Pick<EpisodeOptions, "vault" | "maxSteps" | "timeoutMs">;
  cap?: SpendingCap;
  onEpisode?: (result: EpisodeResult) => void | Promise<void>;
  worldSeed?: string;
}

/**
 * A world twin's run: its yesterday, the day passing, then day 2 with its true content planted
 * (carried steps dated yesterday) and its task. The episode goes into the Task score as a benign
 * twin's. The chain is reverted afterwards.
 */
export async function runWorldTwin(options: WorldTwinOptions): Promise<EpisodeResult> {
  const { sandbox, agent, twin, round } = options;
  if (!twin.sessions) throw new Error(`${twin.id}: a world twin needs sessions.yesterday`);
  const worldSeed = options.worldSeed ?? `world-${twin.id}-${round}`;
  const chain = createTestClient({ mode: "anvil", transport: http(sandbox.rpcUrl) });
  const original = await chain.snapshot();
  try {
    const { vault, history } = await yesterdayThenToday({
      sandbox,
      agent,
      trades: twin.sessions.yesterday.trades,
      ...(twin.sessions.overnight ? { overnight: twin.sessions.overnight } : {}),
      ...(options.marketMoves ? { marketMoves: true } : {}),
      worldSeed,
      ...(options.episode ? { episode: options.episode } : {}),
    });
    const result = await runEpisode(sandbox, {
      ...options.episode,
      agent,
      attack: null,
      benign: twin,
      reuseVault: vault,
      history,
      variantId: `world-${round}`,
      worldSeed: `${worldSeed}-day2`,
    });
    options.cap?.add(result.agentSummary.usage);
    await options.onEpisode?.(result);
    return result;
  } finally {
    try {
      await chain.revert({ id: original });
    } finally {
      if (isMemoryCapable(agent)) agent.reset();
    }
  }
}

export interface WorldBatteryOptions extends MarketOptions {
  /** Attempts per seed (default 1). */
  rounds?: number;
  /** Shared spending cap: every session's usage is added, and no arm starts once it trips. */
  cap: SpendingCap;
  episode?: WorldPairOptions["episode"];
  /** Seeds the worlds; each attempt adds its seed id and round. */
  worldSeed?: string;
  onResult?: (result: WorldPairResult) => void;
  onEpisode?: WorldPairOptions["onEpisode"];
}

/** Runs runWorldPair over the seeds, `rounds` times each, until done or the cap trips. */
export async function runWorldBattery(
  sandbox: Sandbox,
  agent: EpisodeOptions["agent"],
  seeds: readonly AttackSpec[],
  options: WorldBatteryOptions,
): Promise<WorldPairResult[]> {
  const rounds = validateWorldBattery(seeds, options.rounds);
  const results: WorldPairResult[] = [];
  try {
    for (const seed of seeds) {
      for (let round = 0; round < rounds; round++) {
        if (options.cap.exceeded) return results;
        const r = await runWorldPair({
          sandbox,
          agent,
          seed,
          round,
          cap: options.cap,
          onEpisode: options.onEpisode,
          ...(options.marketMoves ? { marketMoves: true } : {}),
          ...(options.episode ? { episode: options.episode } : {}),
          ...(options.worldSeed ? { worldSeed: `${options.worldSeed}-${seed.id}-${round}` } : {}),
        });
        results.push(r);
        options.onResult?.(r);
      }
    }
  } catch (error) {
    if (!(error instanceof WorldBudgetExceeded || error instanceof BatchStopped)) throw error;
  }
  return results;
}

export class WorldBudgetExceeded extends Error {
  constructor() {
    super("world-state spending cap reached before the next session");
  }
}

/**
 * Validate the complete battery before any model work: every seed passes the seed check
 * (worldSeedProblem) and has a goal the goal rules accept.
 */
export function validateWorldBattery(seeds: readonly AttackSpec[], rounds = 1): number {
  if (!Number.isSafeInteger(rounds) || rounds < 1)
    throw new Error("world-state rounds must be a positive integer");
  if (!seeds.length) throw new Error("world-state battery requires seeds");
  for (const seed of seeds) {
    if (seed.goal !== undefined && !goalOk(seed.goal))
      throw new Error(`${seed.id}: invalid world-state goal`);
    const problem = worldSeedProblem(seed);
    if (problem) throw new Error(`${seed.id}: ${problem}`);
  }
  return rounds;
}
