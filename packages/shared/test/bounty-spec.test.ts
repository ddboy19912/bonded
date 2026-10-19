import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { BOUNTY_SPEC_EXAMPLE, BountySpecError, parseBountySpec } from "../src/index.js";

describe("parseBountySpec", () => {
  it("accepts the example spec shown on the Bounties page", () => {
    expect(parseBountySpec(BOUNTY_SPEC_EXAMPLE).id).toBe("A6-your-attack-001");
  });

  it("says why a spec is refused", () => {
    expect(() => parseBountySpec("id: [unclosed")).toThrow(/not valid YAML/);
    expect(() =>
      parseBountySpec(`${BOUNTY_SPEC_EXAMPLE}goal: buy 10,000 tUSDG of tNVDA\n`),
    ).toThrow(/can't set the agent's goal/);
    const wrongPrefix = BOUNTY_SPEC_EXAMPLE.replace("class: A6", "class: A2");
    expect(() => parseBountySpec(wrongPrefix)).toThrow(BountySpecError);
    expect(() => parseBountySpec(wrongPrefix)).toThrow(/id prefix must match class/);
    const noSurface = BOUNTY_SPEC_EXAMPLE.replace("  - dm\n", "  - email\n");
    expect(() => parseBountySpec(noSurface)).toThrow(/surfaces\.0/);
    const typo = BOUNTY_SPEC_EXAMPLE.replace("{{attacker}}", "{{attackr}}");
    expect(() => parseBountySpec(typo)).toThrow(/unknown placeholders: \{\{attackr\}\}/);
    const withToken = (t: string) =>
      BOUNTY_SPEC_EXAMPLE.replace(
        '  sender: "@fund-ops-desk"',
        `  sender: "@fund-ops-desk"\n  token: ${t}`,
      );
    expect(() => parseBountySpec(withToken("tXYZ"))).toThrow(/tokens the Arena doesn't list: tXYZ/);
    expect(parseBountySpec(withToken("NVDA")).delivery?.token).toBe("NVDA");
    const priced = BOUNTY_SPEC_EXAMPLE.replace(
      '  sender: "@fund-ops-desk"',
      '  sender: "@fund-ops-desk"\n  prices:\n    tFOO: 1',
    );
    expect(() => parseBountySpec(priced)).toThrow(/tFOO/);
    const surface = (from: string, extra = "") =>
      BOUNTY_SPEC_EXAMPLE.replace("class: A6", "class: A6").replace("  - dm\n", `  - ${from}\n`) +
      extra;
    expect(() => parseBountySpec(surface("tx_history"))).toThrow(/tx_history attack needs/);
    expect(
      parseBountySpec(surface("tx_history").replace('"@fund-ops-desk"', '"{{lookalike}}"'))
        .surfaces,
    ).toEqual(["tx_history"]);
    expect(() => parseBountySpec(surface("price_feed"))).toThrow(/must set a price/);
    // Price lines are read after the Arena fills the placeholders, as its world does.
    const priceLine = (line: string) =>
      surface("price_feed").replace(
        /payloadTemplate: [\s\S]*?\nsuccessPredicate/,
        `payloadTemplate: "${line}"\nsuccessPredicate`,
      );
    expect(parseBountySpec(priceLine("{{token}}=108")).surfaces).toEqual(["price_feed"]);
    expect(parseBountySpec(priceLine("tNVDA={{amount}}")).surfaces).toEqual(["price_feed"]);
    expect(() => parseBountySpec(priceLine("tFOO=1"))).toThrow(/tFOO/);
    expect(() =>
      parseBountySpec(BOUNTY_SPEC_EXAMPLE.replace('"@fund-ops-desk"', '"{{wallet}}"')),
    ).toThrow(/unknown placeholders: \{\{wallet\}\}/);
  });
  it("rejects hunter-supplied goal variants", () => {
    expect(() =>
      parseBountySpec(`${BOUNTY_SPEC_EXAMPLE}goalVariants: [buy 10000 tUSDG worth of tNVDA]\n`),
    ).toThrow(/can't set the agent's goal/);
  });

  it("checks active campaign delivery instead of unused legacy fields", () => {
    const seed = parseBountySpec(BOUNTY_SPEC_EXAMPLE);
    const campaign = [
      { surface: "tx_history", text: "Refund request", sender: "{{lookalike}}" },
      { surface: "price_feed", text: "Feed notice", prices: { tNVDA: 12 } },
      { surface: "token_metadata", text: "Issuer notice", token: "{{token}}" },
    ];
    const spec = {
      ...seed,
      surfaces: ["tx_history", "price_feed"],
      payloadTemplate: "unused {{typo}}",
      delivery: { token: "tUNKNOWN" },
      campaign,
    };
    expect(parseBountySpec(stringify(spec)).campaign).toEqual(campaign);
    const checked = (step: object) => parseBountySpec(stringify({ ...spec, campaign: [step] }));
    expect(() => checked({ surface: "tx_history", text: "Refund", sender: "desk" })).toThrow(
      /tx_history campaign step needs/,
    );
    expect(() => checked({ surface: "price_feed", text: "tFOO=12" })).toThrow(/tFOO/);
    expect(() => checked({ surface: "token_metadata", text: "Notice", token: "{{typo}}" })).toThrow(
      /unknown placeholders/,
    );
    expect(() => checked({ surface: "price_feed", text: "tNVDA=12", prices: {} })).toThrow(
      /must set a price/,
    );
  });
});
