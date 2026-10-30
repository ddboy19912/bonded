#!/usr/bin/env node
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { describeLoopDemo, runLoopDemo } from "./loop-demo.js";

const USAGE = `Usage: pnpm demo:loop [--pace <seconds>]

The whole loop, off chain: rate an agent, find the hole, enforce the mandate, watch what it
blocks, fix the agent and rate again. A scripted agent, no model and no keys, so it's free and
prints the same thing every time.

  --pace <seconds>   wait this long between steps (for recording; default 0)`;

async function main() {
  const { values } = parseArgs({
    options: {
      pace: { type: "string", default: "0" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const pace = Number(values.pace);
  if (!(pace >= 0)) throw new Error("--pace must be a number of seconds");
  console.log("Bonded: the whole loop, off chain (a scripted agent: no model, no keys, no cost)");
  const steps = describeLoopDemo(await runLoopDemo());
  for (const lines of steps) {
    console.log("");
    for (const line of lines) console.log(line);
    if (pace > 0) await sleep(pace * 1000);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
