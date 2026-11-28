import {
  BROKER_SYSTEM_PROMPT,
  PAYABLES_SYSTEM_PROMPT,
  vulnerableSystemPrompt,
} from "@bonded/demo-agents";
import {
  type AgentRunSummary,
  type AgentTask,
  type AgentToolbox,
  type ArenaAgent,
  agentToolDefinitions,
  type BrokerToolProfile,
  brokerToolDefinitions,
  offchainToolDefinitions,
  type ToolDefinition,
} from "@bondedhq/shared";
import { type ClaudeCodeLoopOptions, ClaudeUsageGate, runClaudeCodeLoop } from "./loop.js";

/** The Arena's worlds, each with the system prompt and tools its Index agent uses. */
export type ClaudeCodeWorld = "vault" | "offchain" | "brokerage";

export interface ClaudeCodeAgentOptions {
  /** A Claude model id, e.g. claude-sonnet-5-5 or claude-opus-5-5. */
  model: string;
  world: ClaudeCodeWorld;
  /** Shared by a run's episodes, so the run pauses and stops on the plan's usage. */
  gate?: ClaudeUsageGate;
  /** Show invoice images to the model (off-chain world). Off by default, as for payables-agent. */
  vision?: boolean;
  /** Passed through to runClaudeCodeLoop (the executable, a test's spawn, the timeout). */
  loop?: Pick<ClaudeCodeLoopOptions, "claudeBin" | "spawn" | "timeoutMs">;
}

/**
 * The world's Index agent, with Claude Code in place of the API model: the same system prompt
 * (vulnerable-agent's, payables-agent's or broker-agent's) and the same tools, so a row run this
 * way differs from the Index's only in how the model is reached.
 */
export class ClaudeCodeAgent implements ArenaAgent {
  readonly name: string;

  constructor(private readonly options: ClaudeCodeAgentOptions) {
    if (!options.model.trim()) throw new Error("ClaudeCodeAgent needs a model");
    this.name = `claude-code/${options.model}`;
  }

  run(task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
    const { system, toolDefinitions } = worldSetup(this.options.world, task, tools);
    return runClaudeCodeLoop({
      model: this.options.model,
      system,
      task,
      tools,
      waitForReset: this.options.world !== "vault",
      toolDefinitions,
      ...(this.options.vision ? { vision: true } : {}),
      ...(this.options.gate ? { gate: this.options.gate } : {}),
      ...this.options.loop,
    });
  }
}

export function worldSetup(
  world: ClaudeCodeWorld,
  task: AgentTask,
  tools: AgentToolbox,
): { system: string; toolDefinitions: ToolDefinition[] } {
  switch (world) {
    case "vault":
      return { system: vulnerableSystemPrompt(task), toolDefinitions: agentToolDefinitions() };
    case "offchain":
      return {
        system: `${PAYABLES_SYSTEM_PROMPT}\nYour mandate: ${task.mandate}`,
        toolDefinitions: offchainToolDefinitions(tools.toolDescriptions),
      };
    case "brokerage":
      return {
        system: `${BROKER_SYSTEM_PROMPT}\nYour mandate: ${task.mandate}`,
        toolDefinitions: brokerToolDefinitions(
          tools.toolDescriptions,
          (tools as { toolProfile?: BrokerToolProfile }).toolProfile,
        ),
      };
  }
}

/** The --model a claude-code run was given: required, and a Claude model id. */
export function claudeModel(model: string | undefined): string {
  if (!model || !/^claude-[a-z0-9.-]+$/.test(model))
    throw new Error(
      "--agent claude-code needs --model with a Claude model id, e.g. claude-sonnet-5-5 or claude-opus-5-5",
    );
  return model;
}

/** True for an agent name the CLIs hand to ClaudeCodeAgent. */
export const isClaudeCodeAgent = (name: string | undefined) => name === "claude-code";

export { ClaudeUsageGate };
