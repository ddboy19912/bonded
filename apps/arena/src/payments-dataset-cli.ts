#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  assertDatasetDir,
  buildPaymentsDataset,
  DEFAULT_EPISODE_PATHS,
  DEFAULT_SEED_DIRS,
  episodeFilePaths,
  exportPaymentRows,
  PAYMENTS_DATASET_DIR,
  PAYMENTS_HELD_OUT_CLASSES,
  plantedBySeed,
  readEpisodeFile,
  SCRIPTED_RUNS_DIR,
} from "./payments-dataset.js";
import { formatAudit } from "./shortcuts.js";

const USAGE = `Usage: pnpm sentinel:payments-dataset [--episodes <file|dir> ...] [options]

Builds Sentinel's payments dataset (docs/SENTINEL.md, "The payments dataset") from off-chain
episodes: Index traces (\`bonded-index\`, saved to ratings/index-traces) and off-chain run results
(\`offchain\`, results.json). One case per distinct state before a payment, labelled from the
judge. Writes train.jsonl, calibration.jsonl, test.jsonl and manifest.json. Prints counts only.

  --episodes <path>    an episode file, or a folder searched for them; repeatable
                       (default: ratings/index-traces)
  --with-scripted      also read the scripted payables agents' runs
                       (${SCRIPTED_RUNS_DIR}, from pnpm sentinel:payments-scripted)
  --seeds <dir>        a folder of seeds to look attack episodes up in; repeatable
                       (default: the library, the staged folder and the Index variants)
  --held-out <classes> comma-separated off-chain classes kept out of training
                       (default: ${PAYMENTS_HELD_OUT_CLASSES.join(",")})
  --allow-shortcuts    write the dataset even if the shortcut audit fails (for analysis only)
  --out <dir>          output folder, under datasets/ or ratings/ (default: ${PAYMENTS_DATASET_DIR})`;

function main(): number {
  const { values } = parseArgs({
    options: {
      episodes: { type: "string", multiple: true },
      "with-scripted": { type: "boolean", default: false },
      seeds: { type: "string", multiple: true },
      "held-out": { type: "string" },
      "allow-shortcuts": { type: "boolean", default: false },
      out: { type: "string", default: PAYMENTS_DATASET_DIR },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  assertDatasetDir(values.out);
  const paths = episodeFilePaths([
    ...(values.episodes ?? DEFAULT_EPISODE_PATHS),
    ...(values["with-scripted"] ? [SCRIPTED_RUNS_DIR] : []),
  ]);
  const files = paths.map((path) => ({ path, file: readEpisodeFile(path) }));
  const { rows, stats, sources } = exportPaymentRows(
    files,
    plantedBySeed(values.seeds ?? DEFAULT_SEED_DIRS),
  );
  console.log(
    `${stats.files} file(s), ${stats.files - stats.ignoredFiles} with off-chain episodes; ${stats.episodes} episodes, ${stats.paymentRows} payment decisions`,
  );
  console.log(
    `  model-driven agents: ${stats.byOrigin.model.episodes} episodes, ${stats.byOrigin.model.paymentRows} payment decisions; scripted agents: ${stats.byOrigin.scripted.episodes} episodes, ${stats.byOrigin.scripted.paymentRows} payment decisions`,
  );
  console.log(
    `skipped: ${stats.skippedUnattributed} attack episode(s) without the judge's attribution, ${stats.skippedUnknownSeed} whose seed wasn't found`,
  );
  if (rows.length === 0) {
    console.error("No payment decisions in the given episodes.");
    return 1;
  }
  const dataset = buildPaymentsDataset({
    rows,
    ...(values["held-out"]
      ? { heldOutClasses: values["held-out"].split(",").map((c) => c.trim()) }
      : {}),
  });
  const m = dataset.manifest;
  console.log(formatAudit(m.shortcuts));
  if (!m.shortcuts.pass && !values["allow-shortcuts"]) {
    console.error(
      "Not written: a surface rule predicts the labels. Fix the data, don't train on it.",
    );
    return 1;
  }
  mkdirSync(values.out, { recursive: true });
  const jsonl = (rows: unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
  for (const part of ["train", "calibration", "test"] as const)
    writeFileSync(join(values.out, `${part}.jsonl`), jsonl(dataset[part]));
  writeFileSync(
    join(values.out, "manifest.json"),
    `${JSON.stringify({ ...m, export: stats, sources }, null, 2)}\n`,
  );
  console.log(`held out: ${m.heldOutClasses.join(", ")} (with their twins) and every control`);
  for (const part of ["train", "calibration", "test"] as const) {
    const cases = dataset[part];
    const manipulated = cases.filter((c) => c.manipulated).length;
    console.log(
      `${part.padEnd(11)} ${String(cases.length).padStart(5)} cases: ${manipulated} manipulated, ${cases.length - manipulated} benign | hash ${m.hashes[part]}`,
    );
  }
  console.log(
    `deduplicated: ${m.duplicateCopies} identical copies merged, ${m.droppedSharedState} left out of a less held-out part, ${m.rejectedConflicting.cases} state(s) with contradictory labels rejected (${m.rejectedConflicting.rows} rows)`,
  );
  console.log(JSON.stringify({ counts: m.counts, labels: m.labels, origins: m.origins }, null, 2));
  console.log(`wrote ${values.out}`);
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
