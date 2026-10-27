#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chatClientFromEnv, llmConfigForModel } from "@bondedhq/shared";
import { META_MODEL_PRICES } from "../budget.js";
import { loadDotEnv } from "../env.js";
import { invoiceSvg } from "./invoice-image.js";
import {
  forgeImage,
  MetaImageClient,
  MUSE_IMAGE_MODEL,
  MUSE_IMAGE_PRICE_USD,
  MUSE_IMAGE_SPECS,
} from "./muse-image.js";
import { OFFCHAIN_IMAGES_DIR } from "./seeds.js";

const USAGE = `Usage: node apps/arena/dist/offchain/muse-images-cli.js [options]

Makes the Muse Image seeds' forged invoices (src/offchain/muse-image.ts): renders each clean
invoice (needs rsvg-convert), has ${MUSE_IMAGE_MODEL} add the forgery, and keeps a picture only
when the checker model reads its planted account and printed details back exactly. Kept pictures
and their provenance (<file>.json) go to apps/arena/offchain-seeds/images/. Needs MODEL_API_KEY.

  --checker-model <id>  the vision model that reads pictures back (default: muse-spark-1.3)
  --tries <n>           edits per picture before giving up (default: 3)
  --only <file>         make only this picture`;

async function main() {
  const { values } = parseArgs({
    options: {
      "checker-model": { type: "string", default: "muse-spark-1.3" },
      tries: { type: "string", default: "3" },
      only: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return console.log(USAGE);
  loadDotEnv();
  const checkerModel = values["checker-model"];
  llmConfigForModel(checkerModel);
  const images = new MetaImageClient();
  const checker = chatClientFromEnv();
  let made = 0;
  let checkerUsd = 0;
  let refusals = 0;
  for (const spec of MUSE_IMAGE_SPECS.filter((s) => !values.only || s.file === values.only)) {
    const png = execFileSync("rsvg-convert", ["--format", "png"], {
      input: invoiceSvg(spec.base),
    });
    const result = await forgeImage({
      spec,
      base: { mediaType: "image/png", base64: png.toString("base64") },
      images,
      checker,
      checkerModel,
      tries: Number(values.tries),
    });
    made += result.attempts.filter((a) => a.outcome !== "refused" && a.outcome !== "failed").length;
    refusals += result.attempts.filter((a) => a.outcome === "refused").length;
    const price = META_MODEL_PRICES[checkerModel];
    if (price) {
      checkerUsd +=
        (result.checkerUsage.inputTokens * price.inputPerMillion +
          result.checkerUsage.outputTokens * price.outputPerMillion) /
        1e6;
    }
    for (const a of result.attempts)
      console.log(`${spec.file} #${a.attempt}: ${a.outcome}: ${a.detail}`);
    if (!result.image) continue;
    writeFileSync(join(OFFCHAIN_IMAGES_DIR, spec.file), Buffer.from(result.image.base64, "base64"));
    const provenance = {
      file: spec.file,
      model: MUSE_IMAGE_MODEL,
      prompt: spec.prompt,
      base: spec.base,
      checkerModel,
      readBack: result.check,
      attempts: result.attempts,
      madeAt: new Date().toISOString(),
    };
    writeFileSync(
      join(OFFCHAIN_IMAGES_DIR, `${spec.file}.json`),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    console.log(`wrote ${spec.file}`);
  }
  console.log(
    `${made} pictures made, ${refusals} refused; about $${(made * MUSE_IMAGE_PRICE_USD + checkerUsd).toFixed(3)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
