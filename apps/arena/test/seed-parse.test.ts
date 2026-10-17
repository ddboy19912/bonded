import { findInstructions } from "@bonded/demo-agents";
import { expect, test } from "vitest";
import { loadAttackLibrary, ORACLE_SIZING_SEEDS, renderPayload } from "../src/attacks.js";
import { goalOk } from "../src/harbinger/goals.js";

// Stand-in vars for template rendering. Every instruction in the library addresses one of
// these four placeholders; a new one must be added here (renderPayload fails loudly, so a
// typo in a seed shows up as an unexplained render error, not a silent test pass).
const VARS: Record<string, string> = {
  attacker: `0x${"ab".repeat(20)}`,
  lookalike: `0x${"cd".repeat(20)}`,
  amount: "4,000",
  token: "tUSDG",
};

const library = loadAttackLibrary();

test("every attack seed's rendered text contains one parseable money-moving instruction", () => {
  for (const seed of library) {
    if ((ORACLE_SIZING_SEEDS as readonly string[]).includes(seed.id)) continue;
    const texts = seed.campaign?.length
      ? seed.campaign.map((s) => renderPayload(s.text, VARS))
      : [renderPayload(seed.payloadTemplate, VARS)];
    // Both lenses the reference agent sees: the raw text, and the JSON.stringify'd form tool
    // outputs take on the wire (a real newline becomes a literal "\n" escape there). The raw
    // lens forbids a real newline in the verb clause; the wire lens allows the escape but a
    // seed must pass both. See docs/HARBINGER-PLAN.md, seed authoring rules.
    const raw = texts.join("\n");
    const wire = texts.map((t) => JSON.stringify(t)).join("\n");
    expect(
      findInstructions(raw).length,
      `${seed.id} parses to nothing as raw text: ${raw.slice(0, 240)}`,
    ).toBeGreaterThan(0);
    expect(
      findInstructions(wire).length,
      `${seed.id} parses to nothing in what the agent actually reads: ${wire.slice(0, 240)}`,
    ).toBeGreaterThan(0);
  }
  expect(library.length).toBeGreaterThan(0);
});

test("the coupled seeds' goals (the engine's primary choices) pass the goal guard", () => {
  for (const seed of library) {
    if (!seed.tags?.includes("coupled")) continue;
    for (const goal of [seed.goal, ...(seed.goalVariants ?? [])]) {
      expect(goalOk(goal!), `${seed.id} has a goal the engine would drop: ${goal}`).toBe(true);
    }
  }
});
