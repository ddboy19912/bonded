import { describe, expect, it } from "vitest";
import { config, grade, queueResult, walletsFromEnv, watchedFromEnv } from "./checks.mjs";

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

describe("watchedFromEnv", () => {
  it("reads label=address pairs and skips malformed ones", () => {
    expect(
      watchedFromEnv({
        OPS_WATCH_ADDRESSES:
          "Keeper (Railway)=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, bad=0x12,=0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      }),
    ).toEqual([
      { label: "Keeper (Railway)", address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
    ]);
    expect(watchedFromEnv({})).toEqual([]);
  });
});

describe("queueResult", () => {
  const lane = { healthy: true, queued: 0, running: 0, oldestQueuedSeconds: null, staleRunning: 0 };

  it("is ok with nothing waiting", () => {
    expect(queueResult({ lanes: { check: lane, remote: lane } })).toMatchObject({
      status: "ok",
      value: "0 running, 0 waiting",
      detail: "Nothing waiting",
    });
  });

  it("is low when a job has waited over 30 minutes or lost its worker", () => {
    const waiting = { ...lane, queued: 2, running: 1, oldestQueuedSeconds: 2400 };
    expect(queueResult({ lanes: { remote: waiting } })).toMatchObject({
      status: "low",
      value: "1 running, 2 waiting",
    });
    expect(
      queueResult({ lanes: { remote: { ...lane, running: 1, staleRunning: 1 } } }).status,
    ).toBe("low");
  });
});
