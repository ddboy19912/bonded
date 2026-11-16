import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPROVED_OS_IMAGES,
  TeeVerificationError,
  verifyTeeEvidence,
  type QuoteFacts,
  type ArenaGateway,
  type QuoteVerifier,
  type Sandbox,
  type VerifiedTee,
} from "@bonded/arena";
import { teeArenaReportData, teeReportData, type ArenaAgent } from "@bondedhq/shared";
import type { Hex } from "viem";
import {
  GATEWAY_UNAVAILABLE,
  RatingRefused,
  TeeBinding,
  arenaKeyProblem,
  forkBudgetExhausted,
  ratingFailure,
  gatewayAgents,
  remoteAgentFor,
} from "../src/remote-agent.js";
import { agentConfig } from "../src/worker.js";
import { DbRunnerAuth, RUNNER_TOKEN_PREFIX, RunnerPresenceWriter } from "../src/runners.js";
import type { Database } from "@bonded/db";

// Evidence a dstack TEE would return, built from the spec's rules (as in apps/arena/test/tee.test.ts),
// with a stand-in quote verifier that returns the facts the "hardware" signed.
const sha384 = (...parts: (Buffer | string)[]) => {
  const h = createHash("sha384");
  parts.forEach((p) => h.update(p));
  return h.digest();
};
const extend = (digests: Buffer[]) =>
  digests.reduce(
    (mr, d) => sha384(mr, Buffer.concat([d, Buffer.alloc(48 - d.length)])),
    Buffer.alloc(48),
  );
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const COMPOSE = "ab".repeat(32);
const CODE = hash(7);
const KEY = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Hex;
const OTHER_KEY = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Hex;
const SOL = "11111111111111111111111111111112";
const OS = Object.values(APPROVED_OS_IMAGES)[0]!;

function runtimeEvent(event: string, payloadHex: string) {
  const type = Buffer.alloc(4);
  type.writeUInt32LE(0x08000001);
  return {
    imr: 3,
    event_type: 0x08000001,
    digest: sha384(type, ":", event, ":", Buffer.from(payloadHex, "hex")).toString("hex"),
    event,
    event_payload: payloadHex,
  };
}

/** One episode's evidence for `nonce`, from a VM with platform `mrTd` and key `evm`. */
function evidence(nonce: Hex, opts: { mrTd?: string; evm?: Hex; keyId?: Hex } = {}) {
  const log = [
    { imr: 0, event_type: 1, digest: "02".repeat(48), event: "", event_payload: "" },
    { imr: 1, event_type: 1, digest: "03".repeat(48), event: "", event_payload: "" },
    { imr: 2, event_type: 1, digest: "04".repeat(48), event: "", event_payload: "" },
    runtimeEvent("compose-hash", COMPOSE),
    runtimeEvent("os-image-hash", OS),
  ];
  const rtmr = (imr: number) =>
    extend(log.filter((e) => e.imr === imr).map((e) => Buffer.from(e.digest, "hex"))).toString(
      "hex",
    );
  const evm = opts.evm ?? KEY;
  const facts: QuoteFacts = {
    status: "UpToDate",
    mrTd: opts.mrTd ?? "01".repeat(48),
    rtMr0: rtmr(0),
    rtMr1: rtmr(1),
    rtMr2: rtmr(2),
    rtMr3: rtmr(3),
    reportData: `${(opts.keyId
      ? teeArenaReportData({ codeHash: CODE, evmAddress: evm, keyId: opts.keyId, nonce })
      : teeReportData({ codeHash: CODE, evmAddress: evm, solanaPublicKey: SOL, nonce })
    ).slice(2)}${"0".repeat(64)}`,
  };
  // The stand-in quote carries its facts, so one verifier serves every episode.
  const quote = `0x${Buffer.from(JSON.stringify(facts)).toString("hex")}`;
  return {
    quote,
    eventLog: JSON.stringify(log),
    composeHash: COMPOSE,
    codeHash: CODE,
    evmAddress: evm,
    ...(opts.keyId ? { purpose: "arena" as const, keyId: opts.keyId } : { solanaPublicKey: SOL }),
    nonce,
  };
}
const verifyQuote: QuoteVerifier = async (quote) =>
  JSON.parse(Buffer.from(quote).toString()) as QuoteFacts;
const expected = { codeHash: CODE, composeHash: COMPOSE, verifyQuote };

async function binding() {
  const reference = await verifyTeeEvidence(evidence(hash(1)), { ...expected, nonce: hash(1) });
  return new TeeBinding(reference, expected);
}

describe("TeeBinding", () => {
  it("accepts every episode that proves the same deployment and key with its own nonce", async () => {
    const b = await binding();
    for (const n of [2, 3, 4]) {
      const live = await b.check(evidence(hash(n)), hash(n));
      expect(live.measurement).toBe(b.reference.measurement);
    }
    expect(b.verified).toBe(3);
    expect(b.verdict(3)).toBeUndefined();
  });

  it("fails the rating when the measurement changes mid-rating", async () => {
    const b = await binding();
    await b.check(evidence(hash(2)), hash(2));
    await expect(b.check(evidence(hash(3), { mrTd: "0f".repeat(48) }), hash(3))).rejects.toThrow(
      /measurement changed during the rating/,
    );
    expect(b.verdict(2)).toMatch(/TEE binding failed: the TEE measurement changed/);
  });

  it("fails the rating when the TEE's key changes, even on the same measurement", async () => {
    const b = await binding();
    await expect(b.check(evidence(hash(2), { evm: OTHER_KEY }), hash(2))).rejects.toThrow(
      /key changed during the rating/,
    );
    expect(b.verdict(1)).toMatch(/key changed/);
  });

  it("refuses evidence for another episode's nonce, and keeps the first failure", async () => {
    const b = await binding();
    await expect(b.check(evidence(hash(2)), hash(3))).rejects.toThrow(TeeVerificationError);
    await expect(b.check(evidence(hash(4), { evm: OTHER_KEY }), hash(4))).rejects.toThrow();
    expect(b.failure).toMatch(/different challenge/);
  });

  it("fails a rating in which any episode brought no evidence", async () => {
    const b = await binding();
    await b.check(evidence(hash(2)), hash(2));
    expect(b.verdict(5)).toBe("TEE binding failed: 4 of 5 episodes had no verified TEE evidence");
  });
});

describe("TeeBinding for a rating's Arena key", () => {
  const KEY_ID = hash(77);
  it("accepts only that key's evidence: not the production keys', not another rating's", async () => {
    const reference = await verifyTeeEvidence(evidence(hash(1), { keyId: KEY_ID }), {
      ...expected,
      nonce: hash(1),
      arenaKeyId: KEY_ID,
    });
    expect(reference.purpose).toBe("arena");
    const b = new TeeBinding(reference, { ...expected, arenaKeyId: KEY_ID });
    await b.check(evidence(hash(2), { keyId: KEY_ID }), hash(2));
    await expect(b.check(evidence(hash(3)), hash(3))).rejects.toThrow(/Arena key/);
    await expect(b.check(evidence(hash(4), { keyId: hash(78) }), hash(4))).rejects.toThrow(
      /Arena key/,
    );
    expect(b.verdict(3)).toMatch(/TEE binding failed/);
  });
});

describe("remoteAgentFor", () => {
  const request = {
    agentKey: "46630:12",
    chainId: 46630,
    agentId: "12",
    mode: "tools" as const,
    codeHash: CODE,
  };

  it("fails clearly, and for good, when the worker has no gateway", () => {
    let error: unknown;
    try {
      remoteAgentFor(undefined, request, {} as Sandbox);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RatingRefused);
    expect((error as RatingRefused).final).toBe(true);
    expect((error as Error).message).toMatch(/^gateway not available/);
  });

  it("hands the gateway the agent's key, mode, code hash and TEE check", async () => {
    const agent: ArenaAgent = { name: "remote", run: async () => ({}) as never };
    let seen: unknown;
    const verify = async () => ({}) as VerifiedTee;
    expect(
      remoteAgentFor(
        (r) => {
          seen = r;
          return agent;
        },
        { ...request, tee: { keyId: hash(42), evmAddress: KEY, verify } },
        {} as Sandbox,
      ),
    ).toBe(agent);
    expect(seen).toMatchObject({ ...request, tee: { evmAddress: KEY } });
  });
});

describe("gatewayAgents", () => {
  const request = {
    agentKey: "46630:12",
    chainId: 46630,
    agentId: "12",
    codeHash: CODE,
  };
  const optionsOf = (agent: ArenaAgent) =>
    (agent as unknown as { options: Record<string, unknown> }).options;

  it("asks for the agent's runner by its key, in its mode", () => {
    const gateway = {} as ArenaGateway;
    const agent = gatewayAgents(gateway)({ ...request, mode: "tools" }, {} as Sandbox);
    expect(agent.name).toBe("remote/agent-12");
    expect(optionsOf(agent)).toMatchObject({
      gateway,
      transport: { kind: "runner", key: "46630:12" },
      mode: "tools",
    });
    expect(optionsOf(agent).tee).toBeUndefined();
  });

  it("gives a stock-trading episode 240 s and a vault episode 90 s, each overridable", () => {
    const gateway = {} as ArenaGateway;
    const vault = gatewayAgents(gateway)({ ...request, mode: "tools" }, {} as Sandbox);
    expect(optionsOf(vault).episodeTimeoutMs).toBe(90_000);
    const stocks = gatewayAgents(gateway)(
      { ...request, mode: "tools", world: "brokerage" },
      undefined,
    );
    expect(optionsOf(stocks).episodeTimeoutMs).toBe(240_000);
    const set = gatewayAgents(gateway, {
      episodeTimeoutMs: 60_000,
      brokerageEpisodeTimeoutMs: 300_000,
    });
    expect(optionsOf(set({ ...request, mode: "tools" }, {} as Sandbox)).episodeTimeoutMs).toBe(
      60_000,
    );
    expect(
      optionsOf(set({ ...request, mode: "tools", world: "brokerage" }, undefined)).episodeTimeoutMs,
    ).toBe(300_000);
  });

  it("sends a TEE agent's evidence to the binding check, and names its key as the vault's agent in chain mode", async () => {
    const seen: unknown[] = [];
    const verify = async (evidence: unknown, nonce: Hex) => {
      seen.push([evidence, nonce]);
      return {} as VerifiedTee;
    };
    const tee = { keyId: hash(42), evmAddress: KEY, verify };
    const chain = gatewayAgents({} as ArenaGateway)(
      { ...request, mode: "chain", tee },
      {} as Sandbox,
    );
    expect(optionsOf(chain).agentAddress).toBe(KEY);
    // The episodes attest the rating's Arena key, by its id.
    expect((optionsOf(chain).tee as { keyId: string }).keyId).toBe(hash(42));
    const onEvidence = (
      optionsOf(chain).tee as {
        onEvidence: (evidence: unknown, context: { episodeId: string; nonce: Hex }) => unknown;
      }
    ).onEvidence;
    await onEvidence({ quote: "x" }, { episodeId: "e1", nonce: hash(3) });
    expect(seen).toEqual([[{ quote: "x" }, hash(3)]]);
    const tools = gatewayAgents({} as ArenaGateway)(
      { ...request, mode: "tools", tee },
      {} as Sandbox,
    );
    expect(optionsOf(tools).agentAddress).toBeUndefined();
    expect(optionsOf(tools).tee).toBeDefined();
  });
});

describe("agentConfig", () => {
  const mandate = {
    version: 1,
    chain: { family: "evm", chainId: 46630 },
    agentId: "12",
    mode: "monitor",
    baseAsset: "0x0000000000000000000000000000000000000001",
    assets: ["0x0000000000000000000000000000000000000001"],
    targets: [],
    destinations: [],
    limits: {
      maxTxNotionalUsd: 100,
      maxDailyNotionalUsd: 1000,
      maxDrawdownBps: 1500,
      maxSlippageBps: 300,
    },
    freezeOnBreach: true,
    description: "x",
  };
  const remote = { kind: "remote", mandate, codeHash: CODE, mode: "chain" };

  it("accepts a remote agent with its mode and an optional https TEE", () => {
    expect(agentConfig.parse(remote)).toMatchObject({ kind: "remote", mode: "chain" });
    expect(
      agentConfig.parse({ ...remote, tee: { url: "https://tee.example", composeHash: COMPOSE } })
        .tee,
    ).toBeTruthy();
  });

  it("refuses an unknown mode, a plain-http TEE and Sentinel for a remote agent", () => {
    expect(agentConfig.safeParse({ ...remote, mode: "both" }).success).toBe(false);
    expect(
      agentConfig.safeParse({
        ...remote,
        tee: { url: "http://tee.example", composeHash: COMPOSE },
      }).success,
    ).toBe(false);
    expect(agentConfig.safeParse({ ...remote, sentinel: true }).success).toBe(false);
    // A TEE in tool mode binds nothing: the tool calls come from the runner, outside it.
    expect(
      agentConfig.safeParse({
        ...remote,
        mode: "tools",
        tee: { url: "https://tee.example", composeHash: COMPOSE },
      }).success,
    ).toBe(false);
  });

  it("still refuses Sentinel with a TEE for a built-in design", () => {
    const builtIn = {
      kind: "hardened",
      mandate,
      codeHash: CODE,
      sentinel: true,
      tee: { url: "https://tee.example", composeHash: COMPOSE },
    };
    expect(agentConfig.safeParse(builtIn).success).toBe(false);
  });
});

describe("RunnerPresenceWriter", () => {
  it("writes one event at a time per agent, in order, and coalesces heartbeats", async () => {
    const writes: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const db = {
      runnerConnected: async () => {
        writes.push("connected");
        await gate;
        return "c1";
      },
      runnerHeartbeat: async () => {
        writes.push("heartbeat");
        return true;
      },
      runnerDisconnected: async () => {
        writes.push("disconnected");
      },
    } as unknown as Database;
    const writer = new RunnerPresenceWriter(db);
    const hello = {
      type: "hello" as const,
      runnerVersion: "1",
      protocol: 1,
      mode: "tools" as const,
    };
    writer.onEvent({ type: "connected", key: "k", at: 0, hello });
    // While the slow write runs, a thousand heartbeats wait as one.
    for (let i = 0; i < 1000; i++) writer.onEvent({ type: "heartbeat", key: "k", at: i });
    expect(writer.pending("k")).toBe(1);
    writer.onEvent({ type: "disconnected", key: "k", at: 2000 });
    expect(writer.pending("k")).toBe(2);
    release();
    await writer.flush();
    expect(writes).toEqual(["connected", "heartbeat", "disconnected"]);
  });
});

describe("DbRunnerAuth", () => {
  const token = `${RUNNER_TOKEN_PREFIX}${"a".repeat(43)}`;
  const record = {
    tokenId: "t",
    agentKey: "46630:12",
    chainId: 46630,
    agentId: "12",
    createdBy: "0xowner",
    config: {
      kind: "remote",
      mandate: {
        version: 1,
        chain: { family: "evm", chainId: 46630 },
        agentId: "12",
        mode: "monitor",
        baseAsset: "0x0000000000000000000000000000000000000001",
        assets: ["0x0000000000000000000000000000000000000001"],
        targets: [],
        destinations: [],
        limits: {
          maxTxNotionalUsd: 100,
          maxDailyNotionalUsd: 1000,
          maxDrawdownBps: 1500,
          maxSlippageBps: 300,
        },
        freezeOnBreach: true,
        description: "x",
      },
      codeHash: CODE,
      mode: "tools",
    },
  };
  const db = { runnerToken: async () => record } as unknown as Database;

  it("accepts a token only while its maker still owns the agent", async () => {
    let owner = "0xOWNER";
    const auth = new DbRunnerAuth(db, 46630, async () => owner, 0);
    expect(await auth.validate(token)).toMatchObject({ key: "46630:12", mode: "tools" });
    owner = "0xnewowner";
    expect(await auth.validate(token)).toBeNull();
  });

  it("refuses tokens for another chain or of the wrong form", async () => {
    expect(await new DbRunnerAuth(db, 1).validate(token)).toBeNull();
    expect(await new DbRunnerAuth(db, 46630).validate("not-a-token")).toBeNull();
  });
});

describe("arenaKeyProblem", () => {
  it("refuses an Arena key that is the production key, whatever its case", () => {
    expect(arenaKeyProblem(KEY, KEY.toLowerCase())).toMatch(/production key/);
    expect(arenaKeyProblem(OTHER_KEY, KEY)).toBeUndefined();
  });
});

describe("forkBudgetExhausted", () => {
  it("reads the gateway's flag on an episode result and on a run summary", () => {
    expect(forkBudgetExhausted({ agentSummary: { remote: { budgetExhausted: true } } })).toBe(true);
    expect(forkBudgetExhausted({ remote: { budgetExhausted: true, forkFetches: 500 } })).toBe(true);
    expect(forkBudgetExhausted({ agentSummary: { remote: { budgetExhausted: false } } })).toBe(
      false,
    );
    expect(forkBudgetExhausted({ agentSummary: { remote: { forkFetches: 12 } } })).toBe(false);
    // The gateway raises no error of its own for it: an error is never taken as the signal.
    const rpc = Object.assign(new Error("the agent's budget of live-chain requests is spent"), {
      code: -32005,
    });
    expect(forkBudgetExhausted(rpc)).toBe(false);
    expect(forkBudgetExhausted(undefined)).toBe(false);
  });
});

describe("ratingFailure: how a failed rating is recorded", () => {
  const spent = "episode 3 of 40";

  it("charges anything that fails after the agent used up its fork share to the agent, for good", () => {
    for (const error of [
      new Error("could not reach the fork: connection reset"),
      new RatingRefused("stopped: the rating ran past its budget, not because of the agent", false),
    ])
      expect(ratingFailure(error, spent)).toEqual({
        reason: "stopped: the agent used up its share of fork requests in episode 3 of 40",
        final: true,
        agentCaused: true,
      });
  });

  it("keeps a refusal already charged to the agent as it is", () => {
    const crashed = new RatingRefused("stopped: the agent failed in episode 3 of 40", true, {
      caused: true,
      report: "panic",
    });
    expect(ratingFailure(crashed, spent)).toEqual({
      reason: "stopped: the agent failed in episode 3 of 40",
      final: true,
      agentCaused: true,
      agentReport: "panic",
    });
  });

  it("otherwise retries an unexpected error under a generic reason, and keeps a refusal's own", () => {
    expect(ratingFailure(new Error("rpc https://key@rpc.example failed"))).toEqual({
      reason: "rating failed; retry scheduled",
    });
    expect(ratingFailure(new RatingRefused(GATEWAY_UNAVAILABLE, true))).toEqual({
      reason: GATEWAY_UNAVAILABLE,
      final: true,
    });
  });
});
