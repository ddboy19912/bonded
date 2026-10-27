#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { LlmPayablesAgent } from "@bonded/demo-agents";
import { BondedIndex, chatClientFromEnv, llmConfigForModel } from "@bondedhq/shared";
import { metaCapFallback, SpendingCap } from "../budget.js";
import { loadDotEnv } from "../env.js";
import { probeCounterparties, runOffchainBatch } from "./batch.js";
import { draftVariants, saveVariants } from "./fresh.js";
import {
  INDEX_COUNTERPARTY_MODEL,
  INDEX_FILE,
  INDEX_MODELS,
  INDEX_VARIANTS_DIR,
  indexEntry,
  readIndex,
  scoreOf,
  withEntry,
} from "./index-sweep.js";
import { loadOffchainSeeds } from "./seeds.js";

const USAGE = `Usage: node apps/arena/dist/offchain/index-cli.js --max-usd <n> [options]

The Bonded Index sweep (src/offchain/index-sweep.ts): runs every Index model through the same
off-chain attacks (the library seeds plus the committed variants in apps/arena/offchain-index/),
both mandate rows, then asks each to write the attack variants itself for its refusal rate.
Each model's entry is written to config/bonded-index.json as soon as it finishes.

  --max-usd <n>          spending cap per model (required)
  --models <list>        only these model ids (default: every Index model)
  --runs <n>             runs of every scenario in each row (default: 3)
  --parallel <n>         episodes at once (default: 6)
  --make-variants <id>   first draft the committed variant set with this model, replacing it
  --rescore              re-score the entries already in the file from their per-class counts,
                         without running anything (after a scoring change); --max-usd not needed`;

async function main() {
  const { values } = parseArgs({
    options: {
      "max-usd": { type: "string" },
      models: { type: "string" },
      runs: { type: "string", default: "3" },
      parallel: { type: "string", default: "6" },
      "make-variants": { type: "string" },
      rescore: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.rescore) {
    // Read the file raw: entries written before a scoring change may lack the new fields.
    const raw = JSON.parse(readFileSync(INDEX_FILE, "utf8")) as BondedIndex;
    const index = BondedIndex.parse({
      ...raw,
      entries: raw.entries.map((e) => ({ ...e, ...scoreOf(e.rows) })),
    });
    const { entries } = index;
    writeFileSync(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);
    for (const e of entries) {
      const w = e.worstClass;
      console.log(
        `${e.label}: ${e.score} [${e.scoreInterval.join("-")}]` +
          (w ? `, set by ${w.class} with the rules ${w.mandate} (${w.fell} of ${w.episodes})` : ""),
      );
    }
    return;
  }
  if (values.help || values["max-usd"] === undefined) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  const maxUsd = Number(values["max-usd"]);
  const runs = Number(values.runs);
  const parallel = Number(values.parallel);
  if (!(maxUsd > 0) || !(runs >= 1) || !(parallel >= 1))
    throw new Error("--max-usd, --runs and --parallel must be positive");
  const wanted = values.models?.split(",").map((m) => m.trim());
  const models = INDEX_MODELS.filter((m) => !wanted || wanted.includes(m.model));
  if (wanted && models.length !== wanted.length) throw new Error("unknown model in --models");

  loadDotEnv();
  const client = chatClientFromEnv();
  for (const m of [...models.map((m) => m.model), INDEX_COUNTERPARTY_MODEL]) llmConfigForModel(m);
  const library = loadOffchainSeeds();

  if (values["make-variants"]) {
    const cap = new SpendingCap({ maxUsd, ...metaCapFallback(values["make-variants"]) });
    const { variants, candidates } = await draftVariants({
      seeds: library,
      client,
      model: values["make-variants"],
      onUsage: (u) => cap.add(u),
    });
    saveVariants(INDEX_VARIANTS_DIR, variants);
    console.log(
      `variants: ${variants.length} of ${library.length} kept, $${cap.summary().spentUsd.toFixed(3)}`,
    );
    for (const c of candidates.filter((c) => !c.kept)) console.log(`  ${c.seed}: ${c.reason}`);
  }
  const variants = loadOffchainSeeds(INDEX_VARIANTS_DIR);
  const attackSeeds = [...library, ...variants];

  for (const m of models) {
    const cap = new SpendingCap({ maxUsd, ...metaCapFallback(m.model, INDEX_COUNTERPARTY_MODEL) });
    const ranAt = new Date().toISOString();
    console.log(`== ${m.label}`);
    const batch = await runOffchainBatch({
      agent: () => new LlmPayablesAgent({ client, model: m.model, vision: m.vision }),
      seesImages: m.vision,
      images: true,
      attackSeeds,
      rows: ["shown", "hidden"],
      runs,
      parallel,
      cap,
      client,
      counterpartyModel: INDEX_COUNTERPARTY_MODEL,
    });
    // The same model as the attacker: does it write the attacks, and play the supplier?
    const { candidates } = await draftVariants({
      seeds: library,
      client,
      model: m.model,
      onUsage: (u) => cap.add(u),
    });
    const probes = await probeCounterparties({ seeds: library, client, model: m.model, cap });
    const entry = indexEntry({
      model: m,
      agent: new LlmPayablesAgent({ client, model: m.model }).name.split("/")[0]!,
      batch,
      attackSeeds,
      variants: variants.length,
      runs,
      attacker: { candidates, probes },
      spend: cap.summary(),
      ranAt,
    });
    writeFileSync(INDEX_FILE, `${JSON.stringify(withEntry(readIndex(), entry), null, 2)}\n`);
    const [shown, hidden] = entry.rows;
    console.log(
      `   score ${entry.score} [${entry.scoreInterval.join("-")}]; ` +
        `shown fell ${shown?.fell}/${shown?.attackEpisodes}, hidden fell ${hidden?.fell}/${hidden?.attackEpisodes}; ` +
        `lost $${entry.rows.reduce((n, r) => n + r.lossUsd, 0)}, overpaid $${entry.rows.reduce((n, r) => n + r.overpaidUsd, 0)}; ` +
        `attacker refused ${entry.attacker.drafts.refused}/${entry.attacker.drafts.attempts} drafts, ` +
        `${entry.attacker.probe.refused}/${entry.attacker.probe.asked} probes; $${entry.cost.spentUsd}` +
        (batch.skipped.length ? `; ${batch.skipped.length} skipped at the cap` : ""),
    );
  }
  console.log(`wrote ${INDEX_FILE}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
