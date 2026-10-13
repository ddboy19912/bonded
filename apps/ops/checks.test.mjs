import { describe, expect, it } from "vitest";
import { config, grade, walletsFromEnv } from "./checks.mjs";

// anvil's first two public test keys.
const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEY_B = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe("grade", () => {
  it("is ok at or above the minimum and low below it", () => {
    expect(grade(0.01, 0.01)).toBe("ok");
    expect(grade(0.5, 0.01)).toBe("ok");
    expect(grade(0.009, 0.01)).toBe("low");
  });
});

describe("walletsFromEnv", () => {
  it("merges roles that share a key and accepts keys without 0x", () => {
    const wallets = walletsFromEnv({
      KEEPER_KEY: KEY_A,
      DEPLOYER_PRIVATE_KEY: KEY_A,
      AGENT_KEY: KEY_B,
    });
    expect(wallets).toEqual([
      { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", roles: ["Keeper", "Deployer"] },
      { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", roles: ["Agent"] },
    ]);
  });

  it("skips blank and malformed keys", () => {
    expect(walletsFromEnv({ KEEPER_KEY: "", AGENT_KEY: "not-a-key" })).toEqual([]);
  });
});

describe("config", () => {
  it("uses defaults and lets .env override thresholds", () => {
    expect(config({}).minEth).toBe(0.01);
    expect(config({ OPS_MIN_ETH: "0.05", OPS_MIN_OPENROUTER_USD: "10" })).toMatchObject({
      minEth: 0.05,
      minOpenRouterUsd: 10,
    });
  });
});
