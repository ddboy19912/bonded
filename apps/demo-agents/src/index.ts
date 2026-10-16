import type { ArenaAgent } from "@bondedhq/shared";
import { type ActionGuard, PolicyGuard } from "./hardened/guard.js";
import { LlmHardenedAgent } from "./hardened/llm.js";
import { ScriptedHardenedAgent } from "./hardened/scripted.js";
import { GuardedAgent } from "./guarded.js";
import { LlmVulnerableAgent, type LlmVulnerableAgentOptions } from "./vulnerable/llm.js";
import { ScriptedVulnerableAgent } from "./vulnerable/scripted.js";

export { DecisionModelAgent } from "./decision/agent.js";
export {
  allowedAnswers,
  DEFAULT_DECISION_MODEL,
  type Decision,
  type DecisionOptions,
  type DecisionModel,
  type DecisionQuestion,
  LlmDecisionModel,
  type LlmDecisionModelOptions,
  parseDecision,
} from "./decision/model.js";
export { DEFAULT_SENTINEL_BLOCK_THRESHOLD, SentinelGuard } from "./decision/sentinel.js";
export {
  ACTION_RISKS,
  type ActionRisk,
  type CascadeOptions,
  CascadeSentinel,
  DEFAULT_CASCADE_UNSURE_BAND,
  DecisionModelSentinel,
  LayaDecisionModel,
  type LayaOptions,
  LayaSentinel,
  type SentinelAssessment,
  SentinelAssessmentError,
  type SentinelAssessOptions,
  type SentinelFields,
  type SentinelModel,
  validateCascadeOptions,
} from "./decision/laya.js";
export {
  type ActionGuard,
  type GuardContext,
  GuardedToolbox,
  type GuardVerdict,
  PolicyGuard,
} from "./hardened/guard.js";
export { GuardedAgent } from "./guarded.js";
export { LlmHardenedAgent, type LlmHardenedAgentOptions } from "./hardened/llm.js";
export { ScriptedHardenedAgent } from "./hardened/scripted.js";
export { runToolLoop, type ToolLoopOptions } from "./llm-loop.js";
export { mergeUsage, type ModelUsage, trackUsage, usageSince } from "./usage.js";
export { findInstructions, type Instruction } from "./vulnerable/instructions.js";
export {
  DEFAULT_AGENT_MODEL,
  LlmVulnerableAgent,
  type LlmVulnerableAgentOptions,
} from "./vulnerable/llm.js";
export {
  isMemoryAgent,
  type MemoryAgent,
  MemoryBotAgent,
  type MemoryBotOptions,
} from "./custom/memory.js";
export {
  CUSTOM_BOT_DESIGNS,
  CustomBotAgent,
  type CustomBotDesign,
  type CustomBotOptions,
  isCustomBotDesign,
} from "./custom/bots.js";
export { APPROVAL_REFERENCE, GatedVulnerableAgent } from "./vulnerable/gated.js";
export { ScriptedVulnerableAgent } from "./vulnerable/scripted.js";

export type Brain = "scripted" | "llm";

/** vulnerable-agent v0 with the chosen brain. See ADR-005 and ADR-006. */
export function createVulnerableAgent(
  brain: Brain,
  llm: LlmVulnerableAgentOptions = {},
): ArenaAgent {
  return brain === "llm" ? new LlmVulnerableAgent(llm) : new ScriptedVulnerableAgent();
}

/** hardened-agent v0 with the chosen brain and guards (policy guard first). See ADR-007. */
export function createHardenedAgent(
  brain: Brain,
  llm: LlmVulnerableAgentOptions = {},
  extraGuards: ActionGuard[] = [],
): ArenaAgent {
  const guards = [new PolicyGuard(), ...extraGuards];
  return brain === "llm"
    ? new LlmHardenedAgent({ ...llm, guards })
    : new ScriptedHardenedAgent(guards);
}
/**
 * The demo's Agent A (docs/SPECIFICATION.md, Day 14 detail): vulnerable-agent's brain, which acts on
 * instructions it reads, behind the full policy guard except one gap: it checks an address by its
 * first and last characters only. Insurable, with a weakness the Arena can measure (address
 * poisoning, class A5).
 */
export function createPartialAgent(brain: Brain, llm: LlmVulnerableAgentOptions = {}): ArenaAgent {
  return new GuardedAgent(
    createVulnerableAgent(brain, llm),
    [new PolicyGuard({ matchAddressEnds: true })],
    "partial-guard",
  );
}
export * from "./frameworks/index.js";
