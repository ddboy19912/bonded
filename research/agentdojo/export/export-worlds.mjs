// Export each rated off-chain seed's planted world from the Arena's own code, so the AgentDojo
// port can't drift from it. Needs the Arena built first (pnpm --filter ./apps/arena build).
//
//   node research/agentdojo/export/export-worlds.mjs > research/agentdojo/bonded_ap/data/arena-worlds.json
//
// For every seed: the world the Arena runs it in ("v1" payment run or "v2" realistic job), with
// the seed planted (attackScenario), and the same world with nothing planted. The Python side diffs
// the two to find the text the seed put there. Images are dropped: AgentDojo is text-only.

import {
  attackScenario,
  loadOffchainSeeds,
  worldFor,
} from "../../../apps/arena/dist/offchain/seeds.js";
import {
  PAYMENT_RUN_GOAL,
  REALISTIC_GOAL,
  REALISTIC_TASKS,
} from "../../../apps/arena/dist/offchain/scenarios.js";
import {
  describeLedgerJob,
  describeLedgerMandate,
  worldTools,
} from "../../../apps/arena/dist/offchain/world.js";

const strip = (world) =>
  JSON.parse(
    JSON.stringify(world, (key, value) => (key === "image" || key === "toolDescriptions" ? undefined : value)),
  );

const seeds = {};
for (const seed of loadOffchainSeeds()) {
  const scenario = attackScenario(seed);
  seeds[seed.id] = {
    world: seed.world,
    class: seed.class,
    aimedAt: seed.aimedAt,
    mayHold: seed.mayHold,
    planted: scenario.planted,
    vectors: scenario.vectors,
    mustPay: scenario.mustPay,
    mustReply: scenario.mustReply ?? null,
    mustRoute: scenario.mustRoute ?? null,
    mustUpdate: scenario.mustUpdate ?? null,
    goal: scenario.goal,
    // The agent's briefing as the Arena writes it, with no channel pushed into it.
    jobText: describeLedgerJob(scenario.world),
    mandateText: describeLedgerMandate(scenario.world),
    tools: [...worldTools(scenario.world)],
    plantedWorld: strip(scenario.world),
    baseWorld: strip(worldFor(seed)),
    needsVision: seed.plant.replace.some((r) => r.attachments?.some((a) => a.image)) ||
      seed.plant.emails.some((e) => e.attachments.some((a) => a.image)),
    hasCounterparty: Boolean(seed.counterparty),
    hasToolDescriptions: Object.keys(seed.plant.toolDescriptions).length > 0,
    hasPortalSwap: Object.keys(seed.plant.portalSwap).length > 0,
  };
}

process.stdout.write(
  JSON.stringify(
    { goals: { v1: PAYMENT_RUN_GOAL, v2: REALISTIC_GOAL }, realisticTasks: REALISTIC_TASKS, seeds },
    null,
    1,
  ) + "\n",
);
