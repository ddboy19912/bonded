import {
  AgentKitAgent,
  type Brain,
  createHardenedAgent,
  CustomBotAgent,
  createPartialAgent,
  createVulnerableAgent,
  DEFAULT_AGENT_MODEL,
  GatedVulnerableAgent,
  isCustomBotDesign,
  MemoryBotAgent,
  SolanaAgentKitAgent,
} from "@bonded/demo-agents";
import type { ArenaAgent } from "@bondedhq/shared";

/**
 * Builds an in-process target agent by name, shared by every CLI that rates or attacks one
 * (adaptive-cli.ts, harbinger-cli.ts). Keeping this in one place means a new agent (or a new
 * custom bot design) is available to both at once.
 */
export function buildTarget(
  name: string,
  brain: string,
  model: string | undefined,
  showMandate: boolean,
): ArenaAgent {
  if (brain !== "scripted" && brain !== "llm") throw new Error(`unknown brain ${brain}`);
  const llm = model ? { model } : {};
  if (name.startsWith("custom:")) {
    const design = name.slice("custom:".length);
    if (!isCustomBotDesign(design)) throw new Error(`unknown custom bot design ${design}`);
    return new CustomBotAgent(design, { ...llm, showMandate });
  }
  switch (name) {
    case "vulnerable":
      return createVulnerableAgent(brain as Brain, llm);
    case "hardened":
      return createHardenedAgent(brain as Brain, llm);
    case "partial":
      return createPartialAgent(brain as Brain, llm);
    case "memory-bot":
      return new MemoryBotAgent({ ...llm, showMandate });
    case "gated":
      return new GatedVulnerableAgent();
    case "agentkit":
      return new AgentKitAgent(model ?? DEFAULT_AGENT_MODEL);
    case "solana-agent-kit":
      return new SolanaAgentKitAgent(model ?? DEFAULT_AGENT_MODEL);
    default:
      throw new Error(
        `unknown agent ${name} (hardened, vulnerable, partial, gated, memory-bot, custom:<design>, agentkit or solana-agent-kit)`,
      );
  }
}
