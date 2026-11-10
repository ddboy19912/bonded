#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_AGENT_MODEL, LlmBrokerAgent } from "@bonded/demo-agents";
import { chatClientFromEnv, llmConfigForModel } from "@bondedhq/shared";
import { metaCapFallback, SpendingCap } from "../budget.js";
import { loadDotEnv } from "../env.js";
import { type BrokerEpisodeResult, runBrokerEpisode } from "./episode.js";
import { brokerReport } from "./report.js";
import { type BrokerScenario, controlScenario } from "./scenarios.js";
import { loadBrokerSeeds, scenarioFor } from "./seeds.js";

const USAGE = `Usage: pnpm --filter @bonded/arena broker --max-usd <n> [options]

Runs broker-agent on the brokerage world (docs/BROKERAGE.md): the control, every staged attack
and every benign twin, judged by the broker ledger. Writes results.json and report.md, a findings
report in plain language. The seeds are staged, so this is findings, not a rating.

Options:
  --max-usd <n>      Stop starting episodes once this much has been spent (required)
  --model <id>       The agent's model (default ${DEFAULT_AGENT_MODEL})
  --runs <n>         Runs of each seed (default 1)
  --seeds <ids>      Only these seeds, comma-separated (the control always runs)
  --hide-mandate     Tell the agent only its job, not the mandate's rules (the ledger enforces
                     them either way)
  --concurrency <n>  Episodes at once (default 4)
  --out <dir>        Results directory (default ratings/broker-<time>)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "max-usd": { type: "string" },
      model: { type: "string", default: DEFAULT_AGENT_MODEL },
      runs: { type: "string", default: "1" },
      seeds: { type: "string" },
      concurrency: { type: "string", default: "4" },
      "hide-mandate": { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const maxUsd = Number(values["max-usd"]);
  const runs = Number(values.runs);
  const concurrency = Number(values.concurrency);
  if (!(maxUsd > 0) || !Number.isInteger(runs) || runs < 1 || !(concurrency >= 1)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  loadDotEnv();
  llmConfigForModel(values.model);
  const client = chatClientFromEnv();
  const cap = new SpendingCap({ maxUsd, ...metaCapFallback(values.model) });

  const wanted = values.seeds?.split(",").map((s) => s.trim());
  const scenarios: BrokerScenario[] = [
    controlScenario(),
    ...loadBrokerSeeds()
      .filter((s) => !wanted || wanted.includes(s.id))
      .map(scenarioFor),
  ];
  const queue = scenarios.flatMap((s) => Array.from({ length: runs }, () => s));
  const out =
    values.out ?? join("ratings", `broker-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });

  const results: BrokerEpisodeResult[] = [];
  let next = 0;
  let stoppedByCap = false;
  const worker = async () => {
    while (next < queue.length) {
      if (cap.exceeded) {
        stoppedByCap = true;
        return;
      }
      const scenario = queue[next++]!;
      const agent = new LlmBrokerAgent({ client, model: values.model });
      const result = await runBrokerEpisode(agent, scenario, {
        hideMandate: values["hide-mandate"],
      });
      cap.add(result.agentSummary.usage);
      results.push(result);
      const v = result.verdict;
      console.log(
        `${scenario.id}: ${
          scenario.kind === "attack"
            ? v.attackSucceeded
              ? `worked, $${v.dollarsAtRiskUsd} at risk`
              : "held"
            : result.taskCompleted && !v.breached
              ? "job done"
              : `missed ${result.missed.join(", ") || "nothing"}${v.breached ? ", breached" : ""}`
        } (spend $${cap.summary().spentUsd.toFixed(4)})`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  const spend = cap.summary();
  writeFileSync(
    join(out, "results.json"),
    `${JSON.stringify(
      {
        model: values.model,
        runs,
        mandateShown: !values["hide-mandate"],
        spend,
        stoppedByCap,
        results,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(out, "report.md"),
    brokerReport(
      {
        agent: `broker-agent/${values.model}`,
        model: values.model,
        date: new Date().toISOString().slice(0, 10),
        runsPerSeed: runs,
        mandateShown: !values["hide-mandate"],
        spentUsd: spend.spentUsd,
        stoppedByCap,
      },
      scenarios,
      results,
    ),
  );
  console.log(
    `wrote ${out}/report.md; spend $${spend.spentUsd.toFixed(4)}${spend.estimated ? " (estimated)" : ""}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
