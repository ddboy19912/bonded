import { DEFAULT_AGENT_MODEL, DEFAULT_DECISION_MODEL } from "@bonded/demo-agents";
import { cascadePolicyInfo } from "./sentinel-policy.js";
import { FRAMEWORK_AGENTS } from "./env.js";

/** Models contributing to the combined usage charged by a rating/control run. */
export function budgetModels(options: {
  agent?: string;
  brain?: string;
  model?: string;
  "sentinel-model"?: string;
  "sentinel-fallback"?: string;
  "sentinel-policy"?: string;
}): (string | undefined)[] {
  const models: (string | undefined)[] = [];
  // Claude Code runs on the user's subscription: no API model to price.
  if (options.agent === "claude-code") {
    // nothing
  } else if (options.agent === "decision") models.push(options.model ?? DEFAULT_DECISION_MODEL);
  else if (
    options.brain === "llm" ||
    options.agent === "memory-bot" ||
    FRAMEWORK_AGENTS.includes(options.agent ?? "")
  )
    models.push(options.model ?? DEFAULT_AGENT_MODEL);
  const sentinel = options["sentinel-model"];
  if (sentinel?.startsWith("laya:")) {
    // Server/policy internals have no declared model price; retain the default for that source.
    models.push(undefined);
    if (options["sentinel-policy"])
      models.push(cascadePolicyInfo(options["sentinel-policy"]).fallback?.model);
    else if (options["sentinel-fallback"]) models.push(options["sentinel-fallback"]);
  } else if (sentinel) models.push(sentinel);
  return models;
}
