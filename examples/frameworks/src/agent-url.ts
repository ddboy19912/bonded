import { createServer, type Server } from "node:http";
import type { LanguageModel } from "ai";
import {
  type AgentUrlPublicKey,
  createBondedHandler,
  toNodeHandler,
} from "@bondedhq/sdk/agent-url";
import { runAiSdkAgent } from "./ai-sdk.js";

/**
 * Agent URL mode: no runner. Bonded POSTs each episode to this server; the handler checks that
 * Bonded signed the call for `owner`, answers at once, and runs the agent in the background. When `onEpisode` resolves the
 * handler posts `/done` with the usage it returns.
 */
export function agentUrlServer(options: {
  /** The wallet the URL is saved from on Bonded: calls for any other wallet are refused. */
  owner: string;
  /** Bonded's public keys, given directly (tests); fetched from Bonded's API without them. */
  keys?: AgentUrlPublicKey[];
  model: LanguageModel;
  version?: string;
}): Server {
  const handler = createBondedHandler({
    owner: options.owner,
    ...(options.keys ? { keys: options.keys } : {}),
    ...(options.version ? { version: options.version } : {}),
    async onEpisode(episode, { signal }) {
      const { text, usage } = await runAiSdkAgent({
        model: options.model,
        tools: {},
        goal: episode.task.goal,
        system: episode.task.mandate,
        maxSteps: episode.task.maxSteps,
        episode,
        abortSignal: signal,
      });
      return { finalMessage: text, usage };
    },
  });
  return createServer(toNodeHandler(handler));
}
