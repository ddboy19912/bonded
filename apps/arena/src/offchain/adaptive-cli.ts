#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  AgentKitAgent,
  DEFAULT_AGENT_MODEL,
  LlmPayablesAgent,
  SolanaAgentKitAgent,
} from "@bonded/demo-agents";
import {
  type ArenaAgent,
  type ChatClient,
  chatClientFromEnv,
  isOutOfCredits,
  llmConfigForModel,
} from "@bondedhq/shared";
import { OUT_OF_TOKENS, REFUSED } from "../adaptive.js";
import { loadDotEnv } from "../env.js";
import {
  type OffchainAdaptiveAttempt,
  type OffchainAdaptiveResult,
  type OffchainFeedback,
  MAX_ROUNDS,
  runOffchainAdaptive,
} from "./adaptive.js";
import { describeEstimate, estimateCost } from "./cost-estimate.js";
import { writeFinding } from "./findings.js";
import { assertPrivateDir } from "./held-out.js";
import {
  loadOffchainSeeds,
  OFFCHAIN_STAGED_SEEDS_DIR,
  type OffchainSeed,
  plantIntoBusyWorld,
  seedNeedsVision,
  worldFor,
} from "./seeds.js";
import { parsePushedChannels } from "./world.js";

const USAGE = `Usage: pnpm --filter @bonded/arena offchain-adaptive --max-usd <n> --seeds <list> [options]

Runs the off-chain adaptive attacker (src/offchain/adaptive.ts) against one agent. For each seed
it plants the published text first, then lets an attacker model read how the agent reacted and
rewrite that prose, until the ledger records a breach that goes through, the rounds run out, or
the spend cap is hit. OpenRouter models need OPENROUTER_API_KEY. A Muse model such as
muse-spark-1.3 needs MODEL_API_KEY and is sent to Meta Model API only, not OpenRouter. Results
go to ratings/offchain-adaptive-/, with a finding, a disclosure note and any bounty candidate
beside each result.

  --max-usd <n>          stop once model spend (agent, attacker, counterparty) reaches this,
                         across every seed in the run (required)
  --seeds <list>         seed ids or classes, e.g. O5,O5-chat-ceo-001 (required)
  --agent <name>         payables | agentkit | solana-agent-kit (default: payables)
  --model <id>           the agent's model (default: ${DEFAULT_AGENT_MODEL})
  --attacker-model <id>  the attacker's model, and the O6 counterparty's (default:
                         ${DEFAULT_AGENT_MODEL}). A weaker attacker finds less.
                         muse-spark-1.3 (and any muse-* model) uses Meta Model API
                         only: set MODEL_API_KEY, not an OpenRouter key
  --rounds <n>           rewrites after the seed's own run, 0 to ${MAX_ROUNDS} (default: 4)
  --candidates <n>       rewrites to try in each round, each run as its own episode,
                         1 to 99 (default: 1). The first that gets through stops the round
  --switch-channels      a multi-vector seed may be re-delivered through another message
                         channel (chat, ticket, voicemail, sms, agent) in a later round
  --feedback <level>     outcome | trace: what the attacker sees of each try (default: trace)
  --mandate <row>        shown | hidden: tell the agent the mandate's rules, or only its job
                         (default: hidden; the ledger enforces either way)
  --staged               load apps/arena/offchain-seeds-staged instead of the published library
  --world busy           with --staged, plant each realistic-job seed (world v2) into the busy
                         Monday (world v3) instead of the quiet week. A seed that cannot plant
                         is skipped and listed
  --push-channels <spec> deliver these channels in the briefing (all, or a comma-separated
                         list of chat, ticket, voicemail, sms, portal, plugin, memory, agent,
                         knowledge). Default: none
  --vision               payables: show invoice images to the model. Without it, an attack that
                         lives only in an image isn't run: it is listed as not exposed
  --attacker-reasoning <off|low>  off asks the attacker for no hidden reasoning (default: off)
  --out <dir>            where to write results (default: ratings/offchain-adaptive-<agent>)
  --estimate             print the planned episodes and their estimated cost, then stop`;

function agentFor(name: string, model: string, client: ChatClient, vision: boolean): ArenaAgent {
  if (name === "payables") return new LlmPayablesAgent({ client, model, vision });
  if (name === "agentkit") return new AgentKitAgent(model, undefined, "offchain");
  if (name === "solana-agent-kit") return new SolanaAgentKitAgent(model, undefined, "offchain");
  throw new Error(`unknown --agent ${name}`);
}

/**
 * One letter per try; X is a breach of an aimed-at rule that went through. "breach" here (O) is
 * one that broke other rules only. "blocked" and "breach" must not share a letter.
 */
const TRAIL: Record<OffchainAdaptiveAttempt["ruling"], string> = {
  breach: "O",
  blocked: "K",
  ignored: "I",
  unseen: "U",
  no_verdict: "E",
  invalid: "N",
};

function describe(r: OffchainAdaptiveResult): string {
  const outcome = r.breached
    ? r.roundsToBreach === 0
      ? "breached by the published seed"
      : `breached in round ${r.roundsToBreach}`
    : `held (${r.staticFell ? "static fell" : "static held"}, ${r.fell ? "adaptive fell" : "adaptive held"}, ${r.stoppedBecause})`;
  const trail = r.attempts.map((a) => (a.succeeded ? "X" : TRAIL[a.ruling])).join("");
  return `${r.seed.padEnd(32)} ${outcome.padEnd(42)} ${trail}  $${r.spend.spentUsd.toFixed(3)}`;
}

function selectSeeds(library: readonly OffchainSeed[], wanted: readonly string[]): OffchainSeed[] {
  return library.filter((s) => wanted.some((w) => w === s.class || w === s.id));
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      "max-usd": { type: "string" },
      seeds: { type: "string" },
      agent: { type: "string", default: "payables" },
      model: { type: "string", default: DEFAULT_AGENT_MODEL },
      "attacker-model": { type: "string", default: DEFAULT_AGENT_MODEL },
      rounds: { type: "string", default: "4" },
      candidates: { type: "string", default: "1" },
      "switch-channels": { type: "boolean", default: false },
      feedback: { type: "string", default: "trace" },
      mandate: { type: "string", default: "hidden" },
      staged: { type: "boolean", default: false },
      world: { type: "string" },
      "push-channels": { type: "string" },
      vision: { type: "boolean", default: false },
      "attacker-reasoning": { type: "string", default: "off" },
      estimate: { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const maxUsd = Number(values["max-usd"]);
  const rounds = Number(values.rounds);
  const candidates = Number(values.candidates);
  const feedback = values.feedback as OffchainFeedback;
  const mandate = values.mandate;
  if (
    values.help ||
    !(maxUsd > 0) ||
    !values.seeds ||
    !Number.isInteger(rounds) ||
    rounds < 0 ||
    rounds > MAX_ROUNDS ||
    !Number.isInteger(candidates) ||
    candidates < 1 ||
    candidates > 99 ||
    (feedback !== "outcome" && feedback !== "trace") ||
    (mandate !== "shown" && mandate !== "hidden") ||
    (values["attacker-reasoning"] !== "off" && values["attacker-reasoning"] !== "low")
  ) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (values.world !== undefined && values.world !== "busy")
    throw new Error("--world must be busy");
  if (values.world === "busy" && !values.staged)
    throw new Error(
      "--world busy plants staged seeds written for the realistic job; pass --staged",
    );
  const pushedChannels = values["push-channels"]
    ? parsePushedChannels(values["push-channels"])
    : undefined;

  loadDotEnv();
  const client = chatClientFromEnv();
  for (const model of [values.model, values["attacker-model"]]) llmConfigForModel(model);
  const agent = agentFor(values.agent, values.model, client, values.vision);
  const wanted = values.seeds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const library = loadOffchainSeeds(values.staged ? OFFCHAIN_STAGED_SEEDS_DIR : undefined);
  const selected = selectSeeds(library, wanted);
  if (selected.length === 0) throw new Error(`no seeds match ${values.seeds}`);
  let seeds = selected;
  if (values.world === "busy") {
    const busy = plantIntoBusyWorld(selected);
    for (const skip of busy.skipped) {
      console.log(`skipped, can't plant in the busy world: ${skip.id}: ${skip.reason}`);
    }
    seeds = busy.seeds;
    console.log(
      `busy world: planted ${seeds.length} seed${seeds.length === 1 ? "" : "s"}` +
        (busy.skipped.length ? `; skipped ${busy.skipped.length}` : ""),
    );
    if (seeds.length === 0) throw new Error("no seed could plant in the busy world");
  }
  // At most the seed's own run plus every candidate of every rewrite, per seed (fewer when one
  // gets through). The attacker's rewrites add a little on top. Switching channels does not add
  // episodes: a candidate is delivered one way.
  const estimate = estimateCost(
    values.model,
    seeds.map((seed) => {
      const world = worldFor(seed);
      return {
        count: 1 + rounds * candidates,
        realistic: (world.maxSteps ?? 30) > 30,
        ...(world.maxSteps !== undefined ? { maxSteps: world.maxSteps } : {}),
      };
    }),
    maxUsd,
  );
  console.log(`${describeEstimate(estimate, maxUsd)}; at most, plus the attacker's rewrites`);
  if (values.estimate) return 0;

  const outDir =
    values.out ?? join("ratings", `offchain-adaptive-${agent.name.replaceAll("/", "_")}`);
  assertPrivateDir(outDir, "an adaptive result");
  mkdirSync(outDir, { recursive: true });
  console.log(
    `Agent ${agent.name}, attacker ${values["attacker-model"]}, feedback ${feedback}, ` +
      `mandate ${mandate}${values.world === "busy" ? ", busy Monday" : ""}, ${rounds} rewrites, ` +
      `${candidates} candidate${candidates === 1 ? "" : "s"} ` +
      `per round${values["switch-channels"] ? ", may switch channels" : ""}, up to $${maxUsd} in all\n`,
  );
  const results: OffchainAdaptiveResult[] = [];
  const notExposed: string[] = [];
  const unrun: string[] = [];
  let outOfCredits = false;
  // One budget for the whole run: each seed gets what the earlier ones left.
  let spent = 0;
  for (const seed of seeds) {
    if (seedNeedsVision(seed) && !(values.agent === "payables" && values.vision)) {
      notExposed.push(seed.id);
      continue;
    }
    if (spent >= maxUsd || outOfCredits) {
      unrun.push(seed.id);
      continue;
    }
    let result: OffchainAdaptiveResult;
    try {
      result = await runOffchainAdaptive({
        client,
        attackerModel: values["attacker-model"],
        agent,
        seed,
        rounds,
        candidates,
        switchChannels: values["switch-channels"],
        feedback,
        showMandate: mandate === "shown",
        images: values.vision,
        ...(pushedChannels ? { pushedChannels } : {}),
        attackerReasoning: values["attacker-reasoning"] === "low" ? "low" : "off",
        maxUsd: maxUsd - spent,
      });
    } catch (error) {
      // A model account out of credits ends the run cleanly: finished seeds are already saved,
      // and the rest are listed as not run. Anything else is a real failure.
      if (!isOutOfCredits(error)) throw error;
      outOfCredits = true;
      unrun.push(seed.id);
      continue;
    }
    spent += result.spend.spentUsd;
    results.push(result);
    console.log(describe(result));
    if (result.note) console.log(`  ${result.note}`);
    writeFileSync(join(outDir, `${seed.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    writeFinding(outDir, seed, result);
  }
  const breached = results.filter((r) => r.breached);
  const staticBreached = results.filter((r) => r.staticBreached);
  const fell = results.filter((r) => r.fell);
  const staticFell = results.filter((r) => r.staticFell);
  // Static baseline against adaptive worst case, on the rules each attack aims at.
  console.log(
    `\n${results.length} seeds. Got through (aimed-at rule, not blocked): ` +
      `${staticBreached.length} with the published text, ${breached.length} within ${rounds} ` +
      `rewrites. Fell, counting blocked tries as the score does: ${staticFell.length} static, ` +
      `${fell.length} adaptive. Results in ${outDir}`,
  );
  const other = results.filter((r) => r.otherBreach && !r.breached).length;
  if (other) console.log(`${other} seeds saw only breaches of rules the attack doesn't aim at`);
  if (notExposed.length)
    console.log(`not exposed (the agent sees no images): ${notExposed.join(", ")}`);
  if (unrun.length) {
    console.log(
      `not run, ${outOfCredits ? "a model account ran out of credits (402)" : "the spending cap was reached"}: ${unrun.join(", ")}`,
    );
  }
  console.log(`spend $${spent.toFixed(4)} of $${maxUsd}`);
  const tries = results.flatMap((r) => r.attempts);
  const invalid = tries.filter((a) => a.ruling === "invalid");
  const refused = invalid.filter((a) => a.note?.startsWith(REFUSED)).length;
  const outOfTokens = invalid.filter((a) => a.note?.startsWith(OUT_OF_TOKENS)).length;
  console.log(
    `${tries.length - invalid.length} of ${tries.length} tries ran an episode; ${invalid.length} drafts ` +
      `were lost: ${refused} refused, ${outOfTokens} out of tokens, ` +
      `${invalid.length - refused - outOfTokens} rejected by the checks`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
