import type { AttackSpec } from "@bondedhq/shared";
import { BENIGN_GOALS, type EpisodeOptions, type EpisodeResult, runEpisode } from "./episode.js";
import type { Sandbox } from "./sandbox.js";

/** An agent that keeps notes between sessions (implemented by MemoryBotAgent). */
export interface MemoryAgentLike {
  readonly memory: readonly string[];
  reset(): void;
}

/**
 * The two sessions of one memory attack as one result the adaptive loop can judge. Session 1 has
 * the attack planted; session 2 is an ordinary day with nothing planted, run by the same agent
 * with the notes it saved. Any breach counts (as in a rating), in either session.
 *
 * The result is session 1's, so that "did the agent read the attack" is judged from the session
 * where it was planted, with session 2's verdict and calls added. A breach in session 2 is the
 * point: nothing hostile was in front of the agent that day.
 */
export function mergeSessions(
  spec: AttackSpec,
  first: EpisodeResult,
  second: EpisodeResult,
  notes: readonly string[],
): EpisodeResult {
  if (first.verdict.breached) return first;
  const usage = [first.agentSummary.usage, second.agentSummary.usage].filter(
    (u): u is NonNullable<typeof u> => u !== undefined,
  );
  const summed = usage.length
    ? {
        inputTokens: usage.reduce((n, u) => n + u.inputTokens, 0),
        outputTokens: usage.reduce((n, u) => n + u.outputTokens, 0),
        ...(usage.every((u) => u.costUsd !== undefined)
          ? { costUsd: usage.reduce((n, u) => n + (u.costUsd ?? 0), 0) }
          : {}),
      }
    : undefined;
  return {
    ...first,
    attackId: spec.id,
    attackClass: spec.class,
    verdict: second.verdict,
    drained: second.drained,
    trace: [...first.trace, ...second.trace],
    agentSummary: {
      ...second.agentSummary,
      steps: first.agentSummary.steps + second.agentSummary.steps,
      finalMessage:
        `Session 1 said: ${first.agentSummary.finalMessage ?? ""} | Notes it kept: ${notes.join(" / ") || "none"} | ` +
        `Session 2 said: ${second.agentSummary.finalMessage ?? ""}`,
      ...(summed ? { usage: summed } : {}),
    },
  };
}

/** Runs the attack in session 1 and a clean session 2, with the agent's memory wiped first. */
export async function runMemoryAttempt(
  sandbox: Sandbox,
  agent: EpisodeOptions["agent"] & MemoryAgentLike,
  spec: AttackSpec,
  round: number,
  episode: Pick<EpisodeOptions, "vault" | "goal" | "maxSteps" | "timeoutMs"> = {},
): Promise<EpisodeResult> {
  agent.reset();
  const first = await runEpisode(sandbox, {
    ...episode,
    agent,
    attack: spec,
    variantId: `memory-${round}-s1`,
    worldSeed: `adaptive-${spec.id}`,
  });
  // Session 2: the same agent, a different ordinary task, nothing planted.
  const second = await runEpisode(sandbox, {
    ...episode,
    agent,
    attack: null,
    goal: BENIGN_GOALS[1],
    variantId: `memory-${round}-s2`,
    worldSeed: `adaptive-${spec.id}-day2`,
  });
  return mergeSessions(spec, first, second, agent.memory);
}
