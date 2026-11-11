#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LlmBrokerAgent } from "@bonded/demo-agents";
import { chatClientFromEnv, llmConfigForModel } from "@bondedhq/shared";
import { metaCapFallback, SpendingCap } from "../budget.js";
import { loadDotEnv } from "../env.js";
import { positiveInt } from "../flags.js";
import { INDEX_MODELS } from "../offchain/index-sweep.js";
import type { BrokerEpisodeResult } from "./episode.js";
import {
  BROKERAGE_INDEX_FILE,
  brokerageIndexEntry,
  brokerageIndexScenarios,
  readBrokerageIndex,
  withBrokerageEntry,
} from "./index-sweep.js";
import { runBrokerQueue } from "./run.js";
import { loadBrokerSeeds } from "./seeds.js";

const USAGE = `Usage: pnpm --filter @bonded/arena brokerage-index --models <ids> --max-usd <n> [options]

Rates models on the brokerage library for the Index's stock-trading rows (docs/BROKERAGE.md,
"On the Index"): each model in broker-agent, the holder's plain plan, the control, every attack
and every twin, with the mandate's rules shown and with only the job. Writes each model's entry
into config/brokerage-index.json, replacing its earlier one. The invoice rows
(config/bonded-index.json) are never touched.

Options:
  --models <ids>     Index model ids, comma-separated (required; see INDEX_MODELS)
  --max-usd <n>      Spending cap for each model (required). A model that reaches it is written
                     with its rows marked incomplete.
  --runs <n>         Runs of each episode in each briefing (default 3)
  --concurrency <n>  Episodes at once (default 4)
  --out <dir>        Where each model's episodes go (default ratings/brokerage-index-<time>)
  --dry-run          Run and print the entries, but don't write the Index file
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      "max-usd": { type: "string" },
      runs: { type: "string", default: "3" },
      concurrency: { type: "string", default: "4" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const maxUsd = Number(values["max-usd"]);
  const ids = values.models
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids?.length || !(maxUsd > 0)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const unknown = ids.filter((id) => !INDEX_MODELS.some((m) => m.model === id));
  if (unknown.length > 0) {
    console.error(`not an Index model: ${unknown.join(", ")} (see INDEX_MODELS)`);
    process.exitCode = 1;
    return;
  }
  const runs = positiveInt(values.runs, "--runs");
  const concurrency = positiveInt(values.concurrency, "--concurrency");
  const seeds = loadBrokerSeeds();
  const scenarios = brokerageIndexScenarios(seeds);
  const queue = scenarios.flatMap((s) => Array.from({ length: runs }, () => s));
  const out =
    values.out ??
    join("ratings", `brokerage-index-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });
  loadDotEnv();
  const client = chatClientFromEnv();

  for (const id of ids) {
    const model = INDEX_MODELS.find((m) => m.model === id)!;
    llmConfigForModel(model.model);
    const cap = new SpendingCap({ maxUsd, ...metaCapFallback(model.model) });
    const slug = model.model.replace(/[^a-z0-9.-]+/gi, "_");
    const partial = join(out, `${slug}.jsonl`);
    writeFileSync(partial, "");
    const ranAt = new Date().toISOString();
    const briefing = async (hideMandate: boolean): Promise<BrokerEpisodeResult[]> => {
      const run = await runBrokerQueue(
        queue,
        () => new LlmBrokerAgent({ client, model: model.model }),
        {
          concurrency,
          hideMandate,
          cap,
          onResult: (result) => {
            cap.add(result.agentSummary.usage);
            appendFileSync(partial, `${JSON.stringify(result)}\n`);
          },
        },
      );
      return run.results;
    };
    const shown = await briefing(false);
    const hidden = await briefing(true);
    const spend = cap.summary();
    const incomplete = shown.length + hidden.length < queue.length * 2;
    const entry = brokerageIndexEntry({
      model,
      seeds,
      runs,
      shown,
      hidden,
      spend,
      ranAt,
      incomplete,
    });
    writeFileSync(join(out, `${slug}.entry.json`), `${JSON.stringify(entry, null, 2)}\n`);
    console.log(
      `${model.label}: Security ${entry.score ?? "not measured"}, Task ${entry.task.score ?? "n/a"}, ` +
        `${entry.rows.map((r) => `${r.mandate} ${r.fell}/${r.attackEpisodes}`).join(", ")}, ` +
        `$${spend.spentUsd.toFixed(4)}${spend.estimated ? " (estimated)" : ""}` +
        `${incomplete ? " — INCOMPLETE: the cap stopped it" : ""}`,
    );
    if (!values["dry-run"]) {
      const index = withBrokerageEntry(readBrokerageIndex(), entry);
      writeFileSync(BROKERAGE_INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);
    }
  }
  console.log(
    values["dry-run"]
      ? `dry run: wrote ${out} only`
      : `wrote ${BROKERAGE_INDEX_FILE} and ${out}. Run npx prettier --write config/brokerage-index.json so the file passes the format check.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
