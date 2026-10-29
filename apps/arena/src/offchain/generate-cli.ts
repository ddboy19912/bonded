#!/usr/bin/env node
import { parseArgs } from "node:util";
import { chatClientFromEnv, llmConfigForModel } from "@bondedhq/shared";
import { loadDotEnv } from "../env.js";
import {
  assertGenerateDir,
  DEFAULT_GENERATOR_MODEL,
  defaultGenerateDir,
  generateAttacks,
  type GenerateWorld,
  MAX_GENERATED,
} from "./generate.js";

const USAGE = `Usage: pnpm --filter @bonded/arena offchain-generate -- --world <realistic|busy> --count <n> --max-usd <n> [options]

Asks a model for new off-chain attacks and writes the ones that validate as staged seeds.
The model only returns data. It does not run the agent or judge a payment. OpenRouter models
need OPENROUTER_API_KEY. A Muse model needs MODEL_API_KEY and is not sent to OpenRouter.
Nothing here is rated, and the attack library version is not bumped. The default directory
is not read by offchain --staged; move a seed up into offchain-seeds-staged/ to run it.

  --world <name>    realistic (the quiet week) or busy (the busy Monday). Required
  --count <n>       how many attacks to ask for, 1 to ${MAX_GENERATED}. Required
  --max-usd <n>     stop once model spend reaches this (required). One reply is one call
  --model <id>      which model writes the attacks (default: ${DEFAULT_GENERATOR_MODEL})
  --seed <n>        batch seed, part of the prompt and of each saved id (default: 1)
  --out <dir>       where to write kept seeds (default: offchain-seeds-staged/generated/)
  --tries <n>       retries when the reply is a refusal or not JSON, 1 to 4 (default: 2)`;

function worldOf(value: string | undefined): GenerateWorld | undefined {
  if (value === "realistic" || value === "busy") return value;
  return undefined;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      world: { type: "string" },
      count: { type: "string" },
      "max-usd": { type: "string" },
      model: { type: "string", default: DEFAULT_GENERATOR_MODEL },
      seed: { type: "string", default: "1" },
      out: { type: "string" },
      tries: { type: "string", default: "2" },
      help: { type: "boolean", default: false },
    },
  });
  const world = worldOf(values.world);
  const count = Number(values.count);
  const maxUsd = Number(values["max-usd"]);
  const seed = Number(values.seed);
  const tries = Number(values.tries);
  if (
    values.help ||
    !world ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_GENERATED ||
    !(maxUsd > 0) ||
    !Number.isInteger(seed) ||
    seed < 0 ||
    !Number.isInteger(tries) ||
    tries < 1 ||
    tries > 4 ||
    !values.model.trim()
  ) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const out = values.out ?? defaultGenerateDir();
  assertGenerateDir(out);

  loadDotEnv();
  llmConfigForModel(values.model);
  const client = chatClientFromEnv();
  console.log(
    `world ${world}, model ${values.model}, seed ${seed}, asked ${count}. Writing to ${out}`,
  );
  const result = await generateAttacks({
    world,
    count,
    seed,
    model: values.model,
    client,
    out,
    tries,
    maxUsd,
  });
  for (const reject of result.rejected) {
    const where = reject.index < 0 ? "reply" : `[${reject.index}]`;
    const title = reject.title ? ` ${reject.title}:` : "";
    console.log(`rejected ${where}:${title} ${reject.reason}`);
  }
  const spend = result.spend;
  const about = spend.estimated ? "about " : "";
  console.log(
    `kept ${result.kept.length}, rejected ${result.rejected.length}, spend ${about}$${spend.spentUsd.toFixed(4)}`,
  );
  if (result.capped) console.log("spend cap reached; no further call was made");
  if (result.kept.length > 0) console.log(`wrote ${result.kept.length} seed(s) to ${out}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
