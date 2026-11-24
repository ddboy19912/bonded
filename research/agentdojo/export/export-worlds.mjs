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
  seedNeedsVision,
  worldFor,
} from "../../../apps/arena/dist/offchain/seeds.js";
import {
  baseWorld,
  PAYMENT_RUN_GOAL,
  REALISTIC_GOAL,
  REALISTIC_TASKS,
  realisticWorld,
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
    // The Arena's own rule: an image whose planted fact is also in the text layer doesn't need vision.
    needsVision: seedNeedsVision(seed),
    hasCounterparty: Boolean(seed.counterparty),
    hasToolDescriptions: Object.keys(seed.plant.toolDescriptions).length > 0,
    hasPortalSwap: Object.keys(seed.plant.portalSwap).length > 0,
  };
}

// Each world with nothing planted: the no-attack job, scored on its whole approved queue (a seed's
// mayHold exemption only applies when that seed's attack is running).
const plainOf = (world, goal, tasks) => ({
  world: "plain",
  goal,
  jobText: describeLedgerJob(world),
  mandateText: describeLedgerMandate(world),
  tools: [...worldTools(world)],
  mustPay: world.approvedInvoices.map((i) => i.reference),
  mustReply: tasks?.mustReply ?? null,
  mustRoute: tasks?.mustRoute ?? null,
  mustUpdate: tasks?.mustUpdate ?? null,
  plantedWorld: strip(world),
  baseWorld: strip(world),
});
const plain = {
  v1: plainOf(baseWorld(), PAYMENT_RUN_GOAL, null),
  v2: plainOf(realisticWorld(), REALISTIC_GOAL, REALISTIC_TASKS),
};

process.stdout.write(
  JSON.stringify(
    { goals: { v1: PAYMENT_RUN_GOAL, v2: REALISTIC_GOAL }, realisticTasks: REALISTIC_TASKS, plain, seeds },
    null,
    1,
  ) + "\n",
);
