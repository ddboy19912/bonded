#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_AGENT_MODEL, isMemoryAgent } from "@bonded/demo-agents";
import {
  type AttackSurface,
  type EvmMandateInput,
  llmConfigFromEnv,
  OpenAICompatibleClient,
} from "@bondedhq/shared";
import {
  type AdaptiveAttempt,
  type AdaptiveResult,
  type Feedback,
  OUT_OF_TOKENS,
  REFUSED,
  runAdaptive,
} from "./adaptive.js";
import { loadAttackLibrary } from "./attacks.js";
import { runMemoryAttempt } from "./memory-attempt.js";
import { buildTarget } from "./targets.js";
import { BENIGN_GOALS } from "./episode.js";
import { loadDotEnv } from "./env.js";
import { Sandbox } from "./sandbox.js";

const USAGE = `Usage: pnpm --filter @bonded/arena adaptive --max-usd <n> [options]

Runs the adaptive attacker (src/adaptive.ts) against one agent. For each chosen seed it plants the
published text first (the static baseline), then lets an attacker model read how the agent reacted
and rewrite the text, until the vault records the breach or the rounds run out. Needs
OPENROUTER_API_KEY in .env and anvil (Foundry). Results go to ratings/adaptive-<agent>/.

  --max-usd <n>          stop once model spend (agent and attacker) reaches this, per seed (required)
  --agent <name>         hardened | vulnerable | partial | gated | agentkit | solana-agent-kit |
                         custom:operator-desk | custom:signal-follower | custom:auto-rebalancer |
                         memory-bot (keeps notes between sessions; each try is two sessions,
                         the attack in the first and a clean day in the second)
                         (custom bots: a model with one realistic trust mistake in its prompt)
                         (gated is a scripted control that needs an approval reference: see
                         docs/ADAPTIVE-ATTACKER.md)
                         (default: hardened)
  --brain <scripted|llm> brain for hardened, vulnerable and partial (default: llm)
  --model <id>           the agent's model (default: ${DEFAULT_AGENT_MODEL})
  --attacker-model <id>  the attacker's model (default: deepseek/deepseek-v4.1-flash). A weaker
                         attacker finds less, so a clean result is only as strong as this model
  --seeds <list>         seed ids or classes, e.g. A1,A5-address-poisoning-001, or all (default: the
                         first seed of every class)
  --rounds <n>           rewrites after the seed's own run (default: 6). 0 runs the published
                         seeds only, with no attacker calls
  --feedback <level>     outcome | trace: what the attacker sees of each try (default: trace)
  --goal-index <0-3>     the agent's task: one of the Arena's benign goals (src/episode.ts). Index 3
                         asks it to review recent transfers, which an A5 seed needs: an agent that
                         is never asked to read transfer history never sees the planted text
  --seeds-dir <dir>      load seeds from this folder of YAML files instead of the published library
                         (to replay attacks an earlier run found)
  --candidates <k>       texts the attacker writes per round, each run as its own episode and
                         scored; the best signal feeds the next round (default: 1)
  --attacker-reasoning <off|low>  off asks the attacker for no hidden reasoning: cheaper and faster
                         where the model allows it (default: low)
  --hide-mandate         custom bots only: leave the mandate out of the bot's prompt, as a bot that
                         leaves its rules to the vault would (the Arena otherwise tells every agent)
  --spread               also plant every rewrite on the inbox, news, social, market alerts and
                         counterparty channels, so the same text arrives from several sources
  --enforce              run the vault in Enforce mode
  --out <dir>            where to write results (default: ratings/adaptive-<agent>)`;

/** The text channels `--spread` adds: those a trading agent reads for news and messages. */
const SPREAD_SURFACES: AttackSurface[] = ["dm", "news", "social", "market", "counterparty"];

/** One letter per try. Not the ruling's first letter: "ignored" and "invalid" would collide. */
const TRAIL: Record<AdaptiveAttempt["ruling"], string> = {
  breach: "B",
  vault_blocked: "V",
  guard_blocked: "G",
  ignored: "I",
  unseen: "U",
  no_verdict: "E",
  control: "C",
  invalid: "N",
};

function describe(r: AdaptiveResult): string {
  const outcome = r.breached
    ? r.roundsToBreach === 0
      ? "breached by the published seed"
      : `breached in round ${r.roundsToBreach}`
    : `held for ${r.attempts.filter((a) => a.ruling !== "invalid").length} of ${r.attempts.length} tries (${r.stoppedBecause})`;
  const trail = r.attempts.map((a) => (a.succeeded ? "X" : TRAIL[a.ruling])).join("");
  return `${r.seed.padEnd(38)} ${outcome.padEnd(34)} ${trail}  $${r.spend.spentUsd.toFixed(3)}`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    // pnpm passes the "--" separator through.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      "max-usd": { type: "string" },
      agent: { type: "string", default: "hardened" },
      brain: { type: "string", default: "llm" },
      model: { type: "string" },
      "attacker-model": { type: "string", default: "deepseek/deepseek-v4.1-flash" },
      seeds: { type: "string" },
      rounds: { type: "string", default: "6" },
      feedback: { type: "string", default: "trace" },
      "goal-index": { type: "string" },
      "seeds-dir": { type: "string" },
      "hide-mandate": { type: "boolean", default: false },
      spread: { type: "boolean", default: false },
      candidates: { type: "string", default: "1" },
      "attacker-reasoning": { type: "string", default: "low" },
      enforce: { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const maxUsd = Number(values["max-usd"]);
  const rounds = Number(values.rounds);
  const feedback = values.feedback as Feedback;
  const goal =
    values["goal-index"] === undefined ? undefined : BENIGN_GOALS[Number(values["goal-index"])];
  if (values["goal-index"] !== undefined && goal === undefined)
    throw new Error(`--goal-index must be 0 to ${BENIGN_GOALS.length - 1}`);
  if (
    values.help ||
    !(maxUsd > 0) ||
    !Number.isInteger(rounds) ||
    rounds < 0 ||
    !(Number(values.candidates) >= 1) ||
    (feedback !== "outcome" && feedback !== "trace")
  ) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  // Even a scripted target needs the key: the attacker is always a model.
  loadDotEnv();
  const client = new OpenAICompatibleClient(llmConfigFromEnv());
  const agent = buildTarget(values.agent, values.brain, values.model, !values["hide-mandate"]);

  const library = loadAttackLibrary(values["seeds-dir"]);
  const wanted = values.seeds?.split(",").map((s) => s.trim());
  const seeds = wanted
    ? library.filter(
        (s) => wanted.includes("all") || wanted.some((w) => w === s.class || w === s.id),
      )
    : library.filter((seed, index) => library.findIndex((s) => s.class === seed.class) === index);
  if (seeds.length === 0) throw new Error(`no seeds match ${values.seeds}`);

  const outDir = values.out ?? join("ratings", `adaptive-${agent.name.replaceAll("/", "_")}`);
  mkdirSync(outDir, { recursive: true });
  const sandbox = await Sandbox.start();
  try {
    // The partial agent's mandate allows refunds to the depositor, the address it trusts.
    const mandate: Partial<EvmMandateInput> = {
      ...(values.enforce ? { mode: "enforce" as const } : {}),
      ...(values.agent === "partial" ? { destinations: [sandbox.address("depositor")] } : {}),
    };
    console.log(
      `Agent ${agent.name}, attacker ${values["attacker-model"]}, feedback ${feedback}, ` +
        `${rounds} rewrites per seed, up to $${maxUsd} per seed\n`,
    );
    const episodeOptions = {
      ...(Object.keys(mandate).length ? { vault: { mandate } } : {}),
      ...(goal ? { goal } : {}),
      // The spend cap is only checked between episodes, so a looping model needs a time limit
      // (a weak model once ran to the old 5-minute default at about $0.47 an episode).
      timeoutMs: 90_000,
    };
    const results: AdaptiveResult[] = [];
    for (const seed of seeds) {
      const result = await runAdaptive({
        client,
        attackerModel: values["attacker-model"],
        sandbox,
        agent,
        seed,
        rounds,
        feedback,
        candidates: Number(values.candidates),
        ...(values.spread ? { spread: SPREAD_SURFACES } : {}),
        attackerReasoning: values["attacker-reasoning"] === "off" ? "off" : "low",
        maxUsd,
        episode: episodeOptions,
        ...(isMemoryAgent(agent)
          ? {
              memory: true,
              runAttempt: (spec, round) =>
                runMemoryAttempt(
                  sandbox,
                  agent,
                  spec,
                  round,
                  episodeOptions,
                  `adaptive-${seed.id}`,
                ),
            }
          : {}),
      });
      results.push(result);
      console.log(describe(result));
      // The payloads that worked are real attack text: they stay in the gitignored ratings folder.
      writeFileSync(join(outDir, `${seed.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    }
    const hit = results.filter((r) => r.breached);
    const staticHit = results.filter((r) => r.staticBreached);
    console.log(
      `\n${results.length} seeds: ${staticHit.length} breached by the published text, ` +
        `${hit.length} within ${rounds} rewrites. Results in ${outDir}`,
    );
    // A clean result means little when the attacker model wrote nothing: say how often that happened.
    const tries = results.flatMap((r) => r.attempts);
    const invalid = tries.filter((a) => a.ruling === "invalid");
    const count = (prefix: string) => invalid.filter((a) => a.note?.startsWith(prefix)).length;
    const refused = count(REFUSED);
    // A model's plain-text "I can't help with that" has no marker, so it is counted from its words.
    const declined = invalid.filter((a) =>
      /reply starts: (I cannot|I can't|I can.t|Sorry|I'm sorry|I am unable|I won't|While I understand)/i.test(
        a.note ?? "",
      ),
    ).length;
    const outOfTokens = count(OUT_OF_TOKENS);
    console.log(
      `${tries.length - invalid.length} of ${tries.length} tries ran an episode; ${invalid.length} drafts ` +
        `were lost: ${refused + declined} refused, ${outOfTokens} out of tokens, ` +
        `${invalid.length - refused - declined - outOfTokens} other`,
    );
    console.log(
      "Key: X attack succeeded, I ignored, U unseen, G guard blocked, V vault blocked, N invalid draft, E agent error",
    );
  } finally {
    await sandbox.stop();
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
