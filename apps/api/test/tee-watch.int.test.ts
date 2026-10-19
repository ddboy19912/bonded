import {
  ANVIL_KEYS,
  createAgentVault,
  Sandbox,
  signAttestation,
  type AgentVault,
  type VerifiedTee,
} from "@bonded/arena";
import { connectChain, type ServiceChain } from "@bonded/keeper";
import { attestationMessage, bondedRegistryAbi, mandateHash } from "@bondedhq/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Attest, runTeeChecks, teeQuoteBlock } from "../src/tee-watch.js";
import { postgres } from "./postgres.js";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const RATED = hash(5);
const CODE = hash(7);
let pg: Awaited<ReturnType<typeof postgres>>;
let sandbox: Sandbox;
let vault: AgentVault;
let chain: ServiceChain;
let key: string;

beforeAll(async () => {
  pg = await postgres();
  sandbox = await Sandbox.start();
  vault = await createAgentVault(sandbox);
  chain = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.operator);
  const d = sandbox.deployment;
  const now = Number((await chain.read.getBlock()).timestamp);
  const signed = await signAttestation(
    {
      agentId: vault.agentId.toString(),
      score: 96,
      securityScore: 96,
      expectedLossBps: 30,
      mandateHash: mandateHash(vault.mandate),
      reportHash: hash(1),
      codeHash: CODE,
      teeMeasurement: RATED,
      modelFamily: "unknown",
      issuedAt: now,
      expiresAt: now + 86400,
    },
    { chainId: d.chainId, registry: d.registry, attesterKey: ANVIL_KEYS.deployer },
  );
  await chain.send(d.registry, bondedRegistryAbi, "postScore", [
    attestationMessage(signed.attestation),
    signed.signature,
  ]);
  key = `${d.chainId}:${vault.agentId}`;
  await pg.db.reconcileAgents(d.chainId, [
    {
      agentId: vault.agentId.toString(),
      config: {
        kind: "hardened",
        mandate: vault.mandate,
        codeHash: CODE,
        tee: { url: "https://agent.example", composeHash: hash(9) },
      },
    },
  ]);
}, 180000);
afterAll(async () => {
  await sandbox?.stop();
  await pg?.stop();
});

const live = (measurement: string) =>
  (async () => ({ measurement }) as unknown as VerifiedTee) as Attest;

it("records each check against the measurement in the agent's on-chain score", async () => {
  expect(await runTeeChecks(pg.db, chain, live(RATED))).toBe(1);
  const ok = await pg.db.teeCheck(key);
  expect(ok).toMatchObject({ status: "verified", measurement: RATED });
  expect(ok?.verifiedAt).toBeInstanceOf(Date);

  await runTeeChecks(pg.db, chain, live(hash(6)));
  const bad = await pg.db.teeCheck(key);
  expect(bad).toMatchObject({ status: "mismatch", measurement: hash(6) });
  // The last time it passed is kept while it fails.
  expect(bad?.verifiedAt?.getTime()).toBe(ok?.verifiedAt?.getTime());
});

it("records an unreachable agent without touching the last good time", async () => {
  await runTeeChecks(pg.db, chain, live(RATED));
  const good = await pg.db.teeCheck(key);
  await runTeeChecks(pg.db, chain, async () => {
    const { TeeUnavailableError } = await import("@bonded/arena");
    throw new TeeUnavailableError("the TEE agent answered 502");
  });
  const down = await pg.db.teeCheck(key);
  expect(down).toMatchObject({ status: "unreachable", detail: "the TEE agent answered 502" });
  expect(down?.verifiedAt?.getTime()).toBe(good?.verifiedAt?.getTime());
});

it("keeps a definite failure through an outage, and a pass clears it", async () => {
  await runTeeChecks(pg.db, chain, live(hash(6)));
  expect((await pg.db.teeCheck(key))?.blockingStatus).toBe("mismatch");
  await runTeeChecks(pg.db, chain, async () => {
    const { TeeUnavailableError } = await import("@bonded/arena");
    throw new TeeUnavailableError("down");
  });
  const down = await pg.db.teeCheck(key);
  expect(down).toMatchObject({ status: "unreachable", blockingStatus: "mismatch" });
  await runTeeChecks(pg.db, chain, live(RATED));
  expect((await pg.db.teeCheck(key))?.blockingStatus).toBeNull();
});

it("records the rated measurement and the key it saw, and flags a different key", async () => {
  const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const withKey = (evmAddress: string) =>
    (async () => ({ measurement: RATED, evmAddress }) as unknown as VerifiedTee) as Attest;
  await pg.db.clearTee(key);
  await runTeeChecks(pg.db, chain, withKey(other));
  expect(await pg.db.teeCheck(key)).toMatchObject({
    status: "verified",
    ratedMeasurement: RATED,
    ratedReportHash: hash(1),
    evmAddress: other,
  });
  // The key recorded for this rating is now the reference: a different one is a mismatch.
  await runTeeChecks(pg.db, chain, withKey("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"));
  expect(await pg.db.teeCheck(key)).toMatchObject({
    status: "mismatch",
    blockingStatus: "mismatch",
    evmAddress: other,
  });
});

it("records a score-read outage without losing custody state and checks the next agent", async () => {
  const evmAddress = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  await pg.db.recordTeeRating({
    agentId: key,
    ratedMeasurement: RATED,
    ratedReportHash: hash(1),
    evmAddress,
  });
  await pg.db.recordTeeCheck({
    agentId: key,
    status: "invalid",
    ratedMeasurement: RATED,
    ratedReportHash: hash(1),
  });
  const before = (await pg.db.teeCheck(key))!;
  const nextKey = `${chain.deployment.chainId}:999`;
  const rows = await pg.db.pool.query("SELECT agent_id,config FROM agents WHERE id=$1", [key]);
  const batch = {
    ...pg.db,
    pool: { query: async () => ({ rows: [rows.rows[0], { ...rows.rows[0], agent_id: "999" }] }) },
    teeCheck: pg.db.teeCheck.bind(pg.db),
    recordTeeCheck: pg.db.recordTeeCheck.bind(pg.db),
  } as unknown as typeof pg.db;
  const failingChain = {
    ...chain,
    read: {
      ...chain.read,
      readContract: async (request: { args: bigint[] }) => {
        if (request.args[0] === vault.agentId) throw new Error("RPC unavailable");
        return { teeMeasurement: RATED, reportHash: hash(1) };
      },
    },
  } as unknown as ServiceChain;
  const attest = (async () => ({ measurement: RATED, evmAddress })) as unknown as Attest;
  expect(await runTeeChecks(batch, failingChain, attest)).toBe(2);
  const down = await pg.db.teeCheck(key);
  expect(down).toMatchObject({
    status: "unreachable",
    detail: "the on-chain score could not be read",
    ratedMeasurement: before.ratedMeasurement,
    evmAddress,
    blockingStatus: "invalid",
  });
  expect(down?.verifiedAt?.getTime()).toBe(before.verifiedAt?.getTime());
  expect(await pg.db.teeCheck(nextKey)).toMatchObject({ status: "verified", evmAddress });
});

it("does not assign old custody evidence or failures to a replacement report during an outage", async () => {
  const evmAddress = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  await pg.db.recordTeeRating({
    agentId: key,
    ratedMeasurement: RATED,
    ratedReportHash: hash(1),
    evmAddress,
  });
  await pg.db.recordTeeCheck({
    agentId: key,
    status: "invalid",
    ratedMeasurement: RATED,
    ratedReportHash: hash(1),
  });
  // Even the same deployment can be rated again with another report and key.
  const replacement = {
    ...chain,
    read: {
      ...chain.read,
      readContract: async () => ({ teeMeasurement: RATED, reportHash: hash(2) }),
    },
  } as unknown as ServiceChain;
  await runTeeChecks(pg.db, replacement, async () => {
    const { TeeUnavailableError } = await import("@bonded/arena");
    throw new TeeUnavailableError("down");
  });
  const row = await pg.db.teeCheck(key);
  expect(row).toMatchObject({
    status: "unreachable",
    ratedReportHash: hash(2),
    evmAddress: null,
    verifiedAt: null,
    blockingStatus: null,
  });
  expect(
    teeQuoteBlock({
      onchainMeasurement: RATED,
      onchainReportHash: hash(2),
      vaultAgent: evmAddress,
      row,
    }),
  ).toMatch(/not on record/);
});

it("does not overwrite a worker's replacement rating while a live check is pending", async () => {
  const oldKey = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const newKey = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  for (const remove of [false, true]) {
    await pg.db.recordTeeRating({
      agentId: key,
      ratedMeasurement: RATED,
      ratedReportHash: hash(1),
      evmAddress: oldKey,
    });
    let release!: () => void;
    let reached!: () => void;
    const ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checking = runTeeChecks(pg.db, chain, async () => {
      reached();
      await pending;
      return { measurement: RATED, evmAddress: oldKey } as unknown as VerifiedTee;
    });
    await ready;
    if (remove) await pg.db.recordTeeRating({ agentId: key });
    else
      await pg.db.recordTeeRating({
        agentId: key,
        ratedMeasurement: RATED,
        ratedReportHash: hash(2),
        evmAddress: newKey,
      });
    release();
    await checking;
    const row = await pg.db.teeCheck(key);
    if (remove) expect(row).toBeUndefined();
    else
      expect(row).toMatchObject({
        status: "verified",
        ratedReportHash: hash(2),
        evmAddress: newKey,
      });
  }
});

it("observes the database version before a chain read that races a replacement rating", async () => {
  const oldKey = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const newKey = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  await pg.db.recordTeeRating({
    agentId: key,
    ratedMeasurement: RATED,
    ratedReportHash: hash(1),
    evmAddress: oldKey,
  });
  const racing = {
    ...chain,
    read: {
      ...chain.read,
      readContract: async () => {
        await pg.db.recordTeeRating({
          agentId: key,
          ratedMeasurement: RATED,
          ratedReportHash: hash(2),
          evmAddress: newKey,
        });
        return { teeMeasurement: RATED, reportHash: hash(1) };
      },
    },
  } as unknown as ServiceChain;
  await runTeeChecks(pg.db, racing, (async () => ({
    measurement: RATED,
    evmAddress: oldKey,
  })) as unknown as Attest);
  expect(await pg.db.teeCheck(key)).toMatchObject({ ratedReportHash: hash(2), evmAddress: newKey });
});

it("skips agents with no TEE configured and clears their old failure", async () => {
  await pg.db.recordTeeCheck({
    agentId: key,
    status: "invalid",
    ratedMeasurement: RATED,
    ratedReportHash: hash(1),
  });
  await pg.db.reconcileAgents(sandbox.deployment.chainId, [
    {
      agentId: vault.agentId.toString(),
      config: { kind: "hardened", mandate: vault.mandate, codeHash: CODE },
    },
  ]);
  expect(await runTeeChecks(pg.db, chain, live(RATED))).toBe(0);
  expect(await pg.db.teeCheck(key)).toBeUndefined();
});

it("skips agents with no TEE configured and agents that are disabled", async () => {
  const d = sandbox.deployment;
  await pg.db.reconcileAgents(d.chainId, [
    {
      agentId: vault.agentId.toString(),
      config: { kind: "hardened", mandate: vault.mandate, codeHash: CODE },
    },
  ]);
  expect(await runTeeChecks(pg.db, chain, live(RATED))).toBe(0);
  await pg.db.reconcileAgents(d.chainId, []);
  expect(await runTeeChecks(pg.db, chain, live(RATED))).toBe(0);
});
