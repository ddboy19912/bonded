#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chatClientFromEnv } from "@bondedhq/shared";
import { stringify } from "yaml";
import { loadAttackLibrary } from "./attacks.js";
import { loadDotEnv } from "./env.js";
import { generateHeldOut } from "./held-out.js";
import { assertHeldOutOffMetaApi } from "./held-out-guard.js";
import { Sandbox } from "./sandbox.js";

const USAGE = `Usage: pnpm heldout:generate --max-usd <n> [options]

Drafts new, unpublished attacks with a model, one per library seed, and keeps only those that pass
the bounty checks and differ from their seed (src/held-out.ts). Kept attacks are written as YAML
to a private folder outside the repository; upload them with pnpm heldout:upload. Needs
OPENROUTER_API_KEY in .env and anvil (Foundry).

  --max-usd <n>     stop once model spend reaches this (required)
  --per-class <n>   keep at most this many per class (default: 2)
  --model <id>      any OpenRouter model id (default: deepseek/deepseek-v4.1-flash). Not a
                    muse-* model: held-out attacks never go to Meta Model API
  --classes <list>  only draft from seeds of these classes, e.g. A1,A3 (default: all)
  --out <dir>       where to write them (default: ~/.config/bonded/held-out/<today>). Attacks
                    already there count toward --per-class, so a rerun only fills the gaps`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    // pnpm passes the "--" separator through (pnpm heldout:generate -- --max-usd 2).
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      "max-usd": { type: "string" },
      "per-class": { type: "string", default: "2" },
      model: { type: "string", default: "deepseek/deepseek-v4.1-flash" },
      out: { type: "string" },
      classes: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const maxUsd = Number(values["max-usd"]);
  const perClass = Number(values["per-class"]);
  if (values.help || !(maxUsd > 0) || !Number.isInteger(perClass) || perClass < 1) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  // Checked before the sandbox starts; generateHeldOut checks it again.
  assertHeldOutOffMetaApi([{ role: "the held-out drafter", model: values.model }]);
  loadDotEnv();
  const out = resolve(
    values.out ??
      join(homedir(), ".config", "bonded", "held-out", new Date().toISOString().slice(0, 10)),
  );
  const library = loadAttackLibrary();
  const existing = existsSync(out) ? loadAttackLibrary(out) : [];
  const classes = values.classes?.split(",").map((c) => c.trim());
  const seeds = classes ? library.filter((s) => classes.includes(s.class)) : library;
  const sandbox = await Sandbox.start();
  try {
    const result = await generateHeldOut({
      client: chatClientFromEnv(),
      model: values.model,
      sandbox,
      library,
      seeds,
      existing,
      perClass,
      maxUsd,
      onCandidate: (c) =>
        console.log(
          `${c.kept ? "kept   " : "dropped"} ${c.seed.padEnd(34)} ${c.id ?? ""} ${c.reason}`,
        ),
    });
    mkdirSync(out, { recursive: true, mode: 0o700 });
    for (const spec of result.kept)
      writeFileSync(join(out, `${spec.id}.yaml`), stringify(spec), { mode: 0o600 });
    // The summary has no payloads, so it can be shared or quoted.
    writeFileSync(
      // One summary per run, so a rerun that fills gaps keeps the earlier run's record.
      join(out, `summary-${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          model: values.model,
          kept: existing.length + result.kept.length,
          byClass: Object.fromEntries(
            [...new Set([...existing, ...result.kept].map((k) => k.class))]
              .sort()
              .map((c) => [c, [...existing, ...result.kept].filter((k) => k.class === c).length]),
          ),
          candidates: result.candidates.map(({ seed, kept, reason, breaches }) => ({
            seed,
            kept,
            reason: kept
              ? "kept"
              : reason.replace(/A(10|[1-9])-held-out-[0-9a-f]{8}/g, "a held-out attack"),
            ...(breaches ? { breaches } : {}),
          })),
          spend: result.spend,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.log(
      `\nKept ${result.kept.length} of ${result.candidates.length} drafts in ${out}. Spend: $${result.spend.spentUsd.toFixed(4)}`,
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
