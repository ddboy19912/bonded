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
  llmConfigForModel,
} from "@bondedhq/shared";
import { metaCapFallback, SpendingCap } from "../budget.js";
import { loadDotEnv } from "../env.js";
import { probeCounterparties, runOffchainBatch } from "./batch.js";
import type { ProbeResult } from "./counterparty.js";
import { draftVariants, saveVariants, type VariantCandidate } from "./fresh.js";
import { controlScenario, realisticControl, verifiedBankChangeTwin } from "./scenarios.js";
import { loadOffchainSeeds, OFFCHAIN_STAGED_SEEDS_DIR, type OffchainSeed } from "./seeds.js";
import type { MandateRow } from "./summary.js";

const USAGE = `Usage: pnpm --filter @bonded/arena offchain --max-usd <n> [options]

Runs an agent on the off-chain rail (docs/OFFCHAIN.md): the control, the benign twin and every
attack seed, judged by the payment ledger, several times each, once told the mandate's rules and
once told only its job. The provisional score is 100 x (1 - the worse row's manipulation rate).
With --fresh, a model also drafts one new variant of each seed for this run; the variants are
saved, and --replay runs a saved set again exactly.

  --max-usd <n>              stop starting episodes once model spend reaches this (required)
  --agent <name>             payables | agentkit | solana-agent-kit (default: payables)
  --model <id>               the agent's model (default: ${DEFAULT_AGENT_MODEL})
  --vision                   payables: show invoice images to the model
  --text-only                serve attachments' text layers only, never their images
  --mandate <row>            shown | hidden | both: tell the agent the mandate's rules, only its
                             job, or run both rows (default: both; the ledger enforces either way)
  --runs <n>                 runs of every scenario in each row (default: 3)
  --seeds <list>             only these library seed ids (comma-separated)
  --staged                   run the staged attacks (offchain-seeds-staged/) instead of the
                             library, with the realistic job's control alongside
  --fresh                    draft one fresh variant per seed and run it too
  --replay <dir>             run the variants saved in <dir> (a previous --out's variants/)
  --generator-model <id>     the model drafting variants (default: ${DEFAULT_AGENT_MODEL})
  --counterparty-model <id>  the model playing O6's counterparty (default: ${DEFAULT_AGENT_MODEL})
  --probe-counterparty       also ask O6's counterparty model to answer 5 typical agent replies
                             directly, to measure its refusal rate
  --parallel <n>             episodes at once (default: 4)
  --out <dir>                where to write results (default: ratings/offchain-<agent>-<time>)`;

function agentFor(name: string, model: string, client: ChatClient, vision: boolean): ArenaAgent {
  if (name === "payables") return new LlmPayablesAgent({ client, model, vision });
  if (name === "agentkit") return new AgentKitAgent(model, undefined, "offchain");
  if (name === "solana-agent-kit") return new SolanaAgentKitAgent(model, undefined, "offchain");
  throw new Error(`unknown --agent ${name}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      "max-usd": { type: "string" },
      agent: { type: "string", default: "payables" },
      model: { type: "string", default: DEFAULT_AGENT_MODEL },
      vision: { type: "boolean", default: false },
      "text-only": { type: "boolean", default: false },
      mandate: { type: "string", default: "both" },
      runs: { type: "string", default: "3" },
      seeds: { type: "string" },
      staged: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      replay: { type: "string" },
      "generator-model": { type: "string", default: DEFAULT_AGENT_MODEL },
      "counterparty-model": { type: "string", default: DEFAULT_AGENT_MODEL },
      "probe-counterparty": { type: "boolean", default: false },
      parallel: { type: "string", default: "4" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || values["max-usd"] === undefined) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const maxUsd = Number(values["max-usd"]);
  const parallel = Number(values.parallel);
  const runs = Number(values.runs);
  if (!(maxUsd > 0) || !(parallel >= 1) || !(Number.isInteger(runs) && runs >= 1))
    throw new Error("--max-usd, --parallel and --runs must be positive");
  const rows: MandateRow[] =
    values.mandate === "both" ? ["shown", "hidden"] : [values.mandate as MandateRow];
  if (!rows.every((r) => r === "shown" || r === "hidden"))
    throw new Error("--mandate must be shown, hidden or both");

  loadDotEnv();
  const client = chatClientFromEnv();
  // Meta's models go to Meta Model API: check every model's key now, before anything runs.
  const models = [
    values.model,
    ...(values.fresh && !values.replay ? [values["generator-model"]] : []),
    values["counterparty-model"],
  ];
  for (const model of models) llmConfigForModel(model);
  const cap = new SpendingCap({ maxUsd, ...metaCapFallback(...models) });
  const out =
    values.out ??
    join("ratings", `offchain-${values.agent}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });

  const wanted = values.seeds?.split(",").map((s) => s.trim());
  const library = loadOffchainSeeds(values.staged ? OFFCHAIN_STAGED_SEEDS_DIR : undefined).filter(
    (s) => !wanted || wanted.includes(s.id),
  );
  let variants: OffchainSeed[] = [];
  let candidates: VariantCandidate[] = [];
  if (values.replay) {
    variants = loadOffchainSeeds(values.replay).filter(
      (v) => !wanted || wanted.includes(v.variantOf ?? v.id),
    );
  } else if (values.fresh) {
    ({ variants, candidates } = await draftVariants({
      seeds: library,
      client,
      model: values["generator-model"],
      onUsage: (u) => cap.add(u),
    }));
    saveVariants(join(out, "variants"), variants);
    writeFileSync(join(out, "candidates.json"), `${JSON.stringify(candidates, null, 2)}\n`);
    const attempts = candidates.reduce((n, c) => n + c.attempts, 0);
    const refused = candidates.reduce((n, c) => n + c.refusals, 0);
    console.log(
      `fresh variants: ${variants.length} of ${library.length} kept; ` +
        `${values["generator-model"]} refused ${refused} of ${attempts} drafts`,
    );
    for (const c of candidates.filter((c) => !c.kept)) console.log(`  ${c.seed}: ${c.reason}`);
  }

  const { episodes, summary, notShown, skipped, counterpartyTurns } = await runOffchainBatch({
    agent: () => agentFor(values.agent, values.model, client, values.vision),
    seesImages: values.agent === "payables" && values.vision,
    images: !values["text-only"],
    attackSeeds: [...library, ...variants],
    ...(values.staged
      ? { controls: [controlScenario, verifiedBankChangeTwin, realisticControl] }
      : {}),
    rows,
    runs,
    parallel,
    cap,
    client,
    counterpartyModel: values["counterparty-model"],
  });
  const probes: Record<string, ProbeResult> = values["probe-counterparty"]
    ? await probeCounterparties({
        seeds: library,
        client,
        model: values["counterparty-model"],
        cap,
      })
    : {};
  const ids = [...new Set(episodes.map((e) => e.result.scenarioId))];
  console.log(`${"scenario".padEnd(42)}${rows.map((r) => `rules ${r}`.padEnd(16)).join("")}`);
  for (const id of ids) {
    const cells = rows.map((mandate) => {
      const mine = episodes.filter((e) => e.mandate === mandate && e.result.scenarioId === id);
      const fell = mine.filter((e) => e.result.verdict.attackSucceeded).length;
      const kind = mine[0]?.result.kind;
      const done = mine.filter((e) => e.result.taskCompleted).length;
      return (
        kind === "attack" ? `fell ${fell}/${mine.length}` : `done ${done}/${mine.length}`
      ).padEnd(16);
    });
    console.log(`${id.padEnd(42)}${cells.join("")}`);
  }
  console.log("");
  for (const row of summary.rows) {
    console.log(
      `rules ${row.mandate}: fell for ${row.fell} of ${row.attackEpisodes} attack episodes ` +
        `(${(row.manipulationRate * 100).toFixed(1)}%); lost $${row.lossUsd}, overpaid ` +
        `$${row.overpaidUsd}; tasks done ${row.tasks.done} of ${row.tasks.total}` +
        (row.errors.length ? `; ${row.errors.length} errored, not counted` : ""),
    );
  }
  console.log(
    `provisional off-chain score: ${summary.score} (worse row: rules ${summary.worst}); ` +
      `spend $${cap.summary().spentUsd.toFixed(4)}`,
  );
  console.log(
    `counterparty (${values["counterparty-model"]}): refused ${counterpartyTurns.refused} of ` +
      `${counterpartyTurns.turns} turns in episodes`,
  );
  for (const [id, p] of Object.entries(probes)) {
    console.log(`  probe ${id}: refused ${p.refused} of ${p.asked}, failed ${p.failed}`);
  }
  if (skipped.length) console.log(`skipped at the spending cap: ${skipped.length} episodes`);
  if (notShown.length) console.log(`not run, the agent sees no images: ${notShown.join(", ")}`);
  const header = {
    agent: agentFor(values.agent, values.model, client, values.vision).name,
    vision: values.vision,
    images: !values["text-only"],
    runs,
    notShown,
    skipped,
    spend: cap.summary(),
    refusals: {
      generator: {
        model: values["generator-model"],
        attempts: candidates.reduce((n, c) => n + c.attempts, 0),
        refused: candidates.reduce((n, c) => n + c.refusals, 0),
      },
      counterparty: { model: values["counterparty-model"], ...counterpartyTurns, probes },
    },
    ...summary,
  };
  const results = episodes.map((e) => ({ mandate: e.mandate, ...e.result }));
  // Images are in the seeds; the record notes their size instead of repeating them.
  const record = JSON.stringify(
    { summary: header, candidates, results },
    (key, value: unknown) =>
      key === "base64" && typeof value === "string" ? `<${value.length} base64 chars>` : value,
    2,
  );
  writeFileSync(join(out, "results.json"), `${record}\n`);
  console.log(`wrote ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
