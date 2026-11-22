import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mandateHash, parseEvmDeployment } from "@bondedhq/shared";
import { agentConfig } from "../src/worker.js";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const deployment = parseEvmDeployment(read("contracts/evm/deployments/46630.json"), 46630);
const configs = z.array(agentConfig).parse(JSON.parse(read("config/agents.46630.json")));

/** One operator agent entry, on the current deployment. */
const base = {
  kind: "hardened",
  mandate: {
    version: 1,
    agentId: "1",
    mode: "monitor",
    limits: {
      maxTxNotionalUsd: 5000,
      maxDailyNotionalUsd: 25000,
      maxDrawdownBps: 1500,
      maxSlippageBps: 300,
    },
    freezeOnBreach: true,
    description: "A test entry.",
    chain: { family: "evm", chainId: 46630 },
    baseAsset: deployment.usdg,
    assets: [deployment.usdg, deployment.tsla],
    targets: [{ address: deployment.router, selectors: ["0x6e81221c"] }],
    destinations: [],
  },
  codeHash: `0x${"cd".repeat(32)}`,
};

it("the deployed agents file loads the way the service loads it", () => {
  for (const config of configs) {
    expect(config.mandate.chain.chainId).toBe(deployment.chainId);
    expect(config.mandate.baseAsset.toLowerCase()).toBe(deployment.usdg.toLowerCase());
    for (const asset of config.mandate.assets)
      expect(
        [deployment.usdg, deployment.tsla, deployment.amzn, deployment.nvda].map((a) =>
          a.toLowerCase(),
        ),
      ).toContain(asset.toLowerCase());
  }
  expect(new Set(configs.map((c) => c.mandate.agentId)).size).toBe(configs.length);
});

it("an agent's TEE entry needs an https URL and a compose hash, and nothing else", () => {
  const tee = { url: "https://app-8080.dstack.example", composeHash: `0x${"ab".repeat(32)}` };
  expect(agentConfig.parse({ ...base, tee }).tee).toEqual(tee);
  expect(agentConfig.parse(base).tee).toBeUndefined();
  for (const bad of [
    { ...tee, url: "http://app-8080.dstack.example" },
    { ...tee, composeHash: "0x12" },
    { url: tee.url },
    { ...tee, extra: true },
  ])
    expect(() => agentConfig.parse({ ...base, tee: bad })).toThrow();
});

it("repeats is optional, a whole number from 1 to 10", () => {
  expect(agentConfig.parse(base).repeats).toBeUndefined();
  for (const repeats of [1, 5, 10])
    expect(agentConfig.parse({ ...base, repeats }).repeats).toBe(repeats);
  for (const bad of [0, 11, 1.5, -1, "5", null])
    expect(() => agentConfig.parse({ ...base, repeats: bad })).toThrow();
});

// The demo agents, as seeded on the contracts deployed Oct 20, 2026 (docs/DEVELOPING-REFERENCE.md, "After a
// redeployment"): agent 1 is the Gate 1 hardened agent, agent 2 the TEE agent (Agent B), agent 3
// the demo's partial Agent A.
describe("the demo agents", () => {
  it("are agents 1 to 3", () => {
    expect(configs.map((c) => c.mandate.agentId)).toEqual(["1", "2", "3"]);
  });

  it("agent 1 matches the mandate attested on chain during Gate 1", () => {
    const evidence = JSON.parse(read("docs/progress/evidence/gate-1-testnet.json"));
    const agent = configs.find((c) => c.mandate.agentId === "1");
    expect(evidence.agentId).toBe("1");
    expect(agent && mandateHash(agent.mandate)).toBe(evidence.attestation.attestation.mandateHash);
    // Agent 1 stays the Gate 1 breach demo: no TEE, one run per seed (its evidence is pinned).
    expect(agent?.tee).toBeUndefined();
    expect(agent?.repeats).toBeUndefined();
  });

  it("the TEE agent is agent 2, in Enforce mode, with a dstack URL, a compose hash and 5 runs", () => {
    const tee = configs.filter((c) => c.tee);
    expect(tee).toHaveLength(1);
    expect(tee[0]?.mandate.agentId).toBe("2");
    expect(tee[0]?.mandate.mode).toBe("enforce");
    expect(tee[0]?.tee?.url).toMatch(/^https:\/\/[0-9a-f]{40}-8080\./);
    expect(tee[0]?.tee?.composeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(tee[0]?.repeats).toBe(5);
  });

  it("the demo's Agent A is agent 3: the partial agent, Monitor mode, refunds to the depositor only", () => {
    const a = configs.filter((c) => c.kind === "partial");
    expect(a).toHaveLength(1);
    expect(a[0]?.mandate.agentId).toBe("3");
    expect(a[0]?.mandate.mode).toBe("monitor");
    expect(a[0]?.mandate.freezeOnBreach).toBe(true);
    // The one destination is what its weak address check trusts, and what address poisoning imitates.
    expect(a[0]?.mandate.destinations).toHaveLength(1);
    expect(a[0]?.repeats).toBe(5);
  });
});
