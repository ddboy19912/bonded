import {
  type AnyEpisodeMessage,
  type ChatClient,
  chatClientForModel,
  type HostedAgentSpec,
  hostedModelLabel,
  modelAccountStop,
} from "@bondedhq/shared";
import { runCodeAgent, type SandboxLimits } from "./code-agent.js";
import {
  type HostedBudget,
  HostedBudgetError,
  HostedEpisode,
  type HostedLimits,
  type HostedUsage,
} from "./episode.js";
import { runInstructionsAgent } from "./instructions-agent.js";

export {
  INSPECT_BUSY,
  INSPECT_SLOTS,
  RUN_SLOTS,
  inspectCodeAgent,
  javascriptOf,
  runCodeAgent,
  SANDBOX_LIMITS,
  ThreadSlots,
} from "./code-agent.js";
export type { CodeAgentOutcome, SandboxLimits } from "./code-agent.js";
export {
  HOSTED_BUDGET,
  HOSTED_LIMITS,
  HostedBudget,
  HostedBudgetError,
  HostedEpisode,
  HostedLimitError,
  type HostedSpendStore,
  type HostedLimits,
  type HostedTool,
  type HostedToolResult,
  type HostedUsage,
} from "./episode.js";
export { runInstructionsAgent } from "./instructions-agent.js";

/** How one hosted episode ended. `bonded` marks a failure that was Bonded's, not the agent's. */
export interface HostedRunResult {
  ok: boolean;
  error?: string;
  /** The model account refused (a key or credit problem): the episode says nothing of the agent. */
  bonded?: boolean;
  /** What a code agent printed. */
  logs: string[];
  usage: HostedUsage;
}

/**
 * An agent Bonded runs itself for its owner, one episode at a time. The gateway's RemoteAgent
 * hands it the same episode message a runner or an Agent URL gets, with endpoints on this machine,
 * and it posts /done like any agent.
 */
export interface HostedAgentRunner {
  readonly name: string;
  run(message: AnyEpisodeMessage, signal: AbortSignal): Promise<HostedRunResult>;
}

export interface HostedAgentOptions {
  /** The model client (default: the routing client for the spec's model, Bonded's keys). */
  client?: ChatClient;
  limits?: Partial<HostedLimits>;
  sandbox?: Partial<SandboxLimits>;
  /** The shared daily spending limit (default HOSTED_BUDGET, from HOSTED_DAILY_USD). */
  budget?: HostedBudget;
  /** The owner's wallet: its share of the daily budget (HOSTED_WALLET_DAILY_USD). */
  owner?: string;
  /** For tests: the HTTP client used for the episode's endpoints. */
  fetch?: typeof fetch;
}

/** The runner for a hosted agent spec. */
export function hostedAgent(
  spec: HostedAgentSpec,
  options: HostedAgentOptions = {},
): HostedAgentRunner {
  const client = options.client ?? chatClientForModel(spec.model);
  const name = `hosted/${spec.kind}/${hostedModelLabel(spec.model)}`;
  return {
    name,
    async run(message, signal) {
      const episode = new HostedEpisode(message, {
        client,
        model: spec.model,
        signal,
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.budget ? { budget: options.budget } : {}),
        ...(options.owner ? { owner: options.owner.toLowerCase() } : {}),
      });
      const failed = (error: unknown, logs: string[] = []): HostedRunResult => {
        const text = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: text,
          ...(modelAccountStop(error) || error instanceof HostedBudgetError
            ? { bonded: true }
            : {}),
          logs,
          usage: episode.usage,
        };
      };
      if (spec.kind === "instructions") {
        try {
          const finalMessage = await runInstructionsAgent(episode, spec.instructions);
          await episode.done(finalMessage);
          return { ok: true, logs: [], usage: episode.usage };
        } catch (error) {
          return failed(error);
        }
      }
      const outcome = await runCodeAgent(
        episode,
        { code: spec.code, language: spec.language },
        options.sandbox,
      );
      if (!outcome.ok)
        return {
          ok: false,
          error: outcome.error,
          ...(outcome.bonded ? { bonded: true } : {}),
          logs: outcome.logs,
          usage: episode.usage,
        };
      await episode.done(outcome.finalMessage);
      return { ok: true, logs: outcome.logs, usage: episode.usage };
    },
  };
}
