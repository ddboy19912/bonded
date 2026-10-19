import { afterAll, beforeAll, expect, it } from "vitest";
import { ANVIL_KEYS, Sandbox, createAgentVault, signAttestation } from "@bonded/arena";
import { Keeper, connectChain, type ServiceChain } from "@bonded/keeper";
import {
  EvmMandate,
  attestationMessage,
  bondedRegistryAbi,
  checkUnprotectedAllowances,
  coverPoolAbi,
  deploymentTokens,
  mandateCommitment,
  mandateHash,
  mandateModuleFactoryAbi,
  operatorBondAbi,
  selfServeMessage,
  testTokenAbi,
  toEvmMandateParams,
  withMandateCommitment,
  type SelfServeRequest,
} from "@bondedhq/shared";
import { parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import { attestedMandateHash, agentConfig } from "../src/worker.js";
import { postgres } from "./postgres.js";

/**
 * Agents protected by a MandateModule on the smart account they already use (ERC-7579), instead
 * of a Bonded vault: registration checks the module through its factory, and ratings and quotes
 * use the commitment the module enforces as the mandate hash.
 */
let pg: Awaited<ReturnType<typeof postgres>>;
let sandbox: Sandbox;
let chain: ServiceChain;
let op: ServiceChain;
let app: ReturnType<typeof createApi>;
let agentId: bigint;
let module: Hex;
let mandate: EvmMandate;
const owner = privateKeyToAccount(ANVIL_KEYS.operator);
const usd = (n: number) => BigInt(n) * 1_000_000n;

beforeAll(async () => {
  pg = await postgres();
  sandbox = await Sandbox.start();
  const d = sandbox.deployment;
  if (!d.moduleFactory) throw new Error("the sandbox deployment has no module factory");
  chain = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.deployer);
  op = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.operator);
  app = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: "test-api-token-at-least-24-characters",
    selfServe: { requests: { perClient: 1000, total: 1000, windowMs: 60_000 } },
  });
  // A template mandate, made for this agent.
  const template = (await createAgentVault(sandbox)).mandate;
  const receipt = await op.read.waitForTransactionReceipt({
    hash: await op.send(d.registry, bondedRegistryAbi, "register", ["ipfs://module-agent"]),
  });
  agentId = parseEventLogs({
    abi: bondedRegistryAbi,
    logs: receipt.logs,
    eventName: "Registered",
  })[0]!.args.agentId;
  // Enforce: the only mode in which a module can hold cover.
  mandate = EvmMandate.parse({ ...template, agentId: agentId.toString(), mode: "enforce" });
  // The "smart account" here is the operator's own address: the factory takes whoever calls it.
  const made = await op.read.waitForTransactionReceipt({
    hash: await op.send(d.moduleFactory, mandateModuleFactoryAbi, "createModule", [
      withMandateCommitment(toEvmMandateParams(mandate)),
      op.wallet.account.address,
      op.wallet.account.address,
      agentId,
    ]),
  });
  module = parseEventLogs({
    abi: mandateModuleFactoryAbi,
    logs: made.logs,
    eventName: "ModuleCreated",
  })[0]!.args.module;
}, 180_000);
afterAll(async () => {
  await sandbox?.stop();
  await pg?.stop();
});

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
async function register(opts: { signModule: boolean; sendModule: boolean; m?: EvmMandate }) {
  const m = opts.m ?? mandate;
  const timestamp = Math.floor(Date.now() / 1000);
  const request: SelfServeRequest = {
    action: "register",
    chainId: sandbox.deployment.chainId,
    agentId: agentId.toString(),
    vault: module,
    kind: "hardened",
    mandateHash: mandateHash(m),
    ...(opts.signModule ? { protection: "module" as const } : {}),
    timestamp,
  };
  return post("/self/agents", {
    agentId: agentId.toString(),
    vault: module,
    kind: "hardened",
    mandate: m,
    ...(opts.sendModule ? { protection: "module" } : {}),
    timestamp,
    signature: await owner.signMessage({ message: selfServeMessage(request) }),
  });
}
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;

it("refuses a module registered as a vault, an unsigned protection, and different rules", async () => {
  const asVault = await register({ signModule: false, sendModule: false });
  expect(asVault.status).toBe(400);
  expect(await errorOf(asVault)).toMatch(/not a Bonded vault/);
  expect((await register({ signModule: false, sendModule: true })).status).toBe(403);
  const other = EvmMandate.parse({
    ...mandate,
    limits: { ...mandate.limits, maxTxNotionalUsd: 1 },
  });
  const wrong = await register({ signModule: true, sendModule: true, m: other });
  expect(wrong.status).toBe(400);
  expect(await errorOf(wrong)).toMatch(/doesn't match the rules the module enforces/);
}, 120_000);

it("registers a module-protected agent, and rates it under the commitment the module enforces", async () => {
  const ok = await register({ signModule: true, sendModule: true });
  expect(ok.status).toBe(201);
  const config = agentConfig.parse(
    (await pg.db.agentRecord(`${sandbox.deployment.chainId}:${agentId}`))!.config,
  );
  expect(config.protection).toBe("module");
  const commitment = mandateCommitment(toEvmMandateParams(mandate));
  expect(attestedMandateHash(config)).toBe(commitment);
  expect(commitment).not.toBe(mandateHash(mandate));
  expect(await (await app.request(`/self/agents/${agentId}`)).json()).toMatchObject({
    protection: "module",
    vault: module,
  });
}, 120_000);

it("quotes cover for the module, priced from a score on its commitment", async () => {
  const d = sandbox.deployment;
  const now = Number((await chain.read.getBlock()).timestamp);
  const signed = await signAttestation(
    {
      agentId: agentId.toString(),
      score: 90,
      securityScore: 90,
      expectedLossBps: 50,
      mandateHash: mandateCommitment(toEvmMandateParams(mandate)),
      reportHash: `0x${"ab".repeat(32)}`,
      codeHash: `0x${"cd".repeat(32)}`,
      teeMeasurement: `0x${"00".repeat(32)}`,
      modelFamily: "unknown",
      issuedAt: now,
      expiresAt: now + 86400,
    },
    { chainId: d.chainId, registry: d.registry, attesterKey: ANVIL_KEYS.deployer },
  );
  await op.read.waitForTransactionReceipt({
    hash: await op.send(d.registry, bondedRegistryAbi, "postScore", [
      attestationMessage(signed.attestation),
      signed.signature,
    ]),
  });
  // Underwriters' capital, then the operator's bond.
  await op.send(d.usdg, testTokenAbi, "faucet", [usd(504_000)]);
  await op.send(d.usdg, testTokenAbi, "approve", [d.pool, usd(500_000)]);
  await op.read.waitForTransactionReceipt({
    hash: await op.send(d.pool, coverPoolAbi, "deposit", [usd(500_000), op.wallet.account.address]),
  });
  await op.send(d.usdg, testTokenAbi, "approve", [d.bond, usd(4_000)]);
  await op.read.waitForTransactionReceipt({
    hash: await op.send(d.bond, operatorBondAbi, "stake", [agentId, usd(4_000)]),
  });
  const res = await post("/quotes", {
    agentId: agentId.toString(),
    vault: module,
    coverAmount: usd(10_000).toString(),
  });
  const body = (await res.json()) as {
    quote?: { vault: string; mandateHash: string };
    error?: string;
  };
  expect(res.status, body.error).toBe(201);
  expect(body.quote!.vault.toLowerCase()).toBe(module.toLowerCase());
  expect(body.quote!.mandateHash).toBe(mandateCommitment(toEvmMandateParams(mandate)));
}, 120_000);

it("is watched by the keeper like a vault, so its breaches are claimed", async () => {
  await new Keeper(pg.db, chain, 0n).tick();
  const watched = (
    await pg.db.pool.query("SELECT address FROM keeper_vaults WHERE chain_id=$1", [
      sandbox.deployment.chainId,
    ])
  ).rows.map((r) => r.address);
  expect(watched).toContain(module.toLowerCase());
}, 120_000);

it("refuses to quote a Monitor-mode module, saying why, before the contract would", async () => {
  const d = sandbox.deployment;
  // Another smart account (here an address) with a Monitor-mode module for the same agent.
  const other = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.depositor);
  const monitor = EvmMandate.parse({ ...mandate, mode: "monitor" });
  const made = await other.read.waitForTransactionReceipt({
    hash: await other.send(d.moduleFactory!, mandateModuleFactoryAbi, "createModule", [
      withMandateCommitment(toEvmMandateParams(monitor)),
      other.wallet.account.address,
      op.wallet.account.address,
      agentId,
    ]),
  });
  const monitorModule = parseEventLogs({
    abi: mandateModuleFactoryAbi,
    logs: made.logs,
    eventName: "ModuleCreated",
  })[0]!.args.module;
  const res = await post("/quotes", {
    agentId: agentId.toString(),
    vault: monitorModule,
    coverAmount: usd(1_000).toString(),
  });
  expect(res.status).toBe(409);
  expect(await errorOf(res)).toMatch(/only in Enforce mode/);
}, 120_000);

it("finds approvals a module can't see, on the real chain", async () => {
  const d = sandbox.deployment;
  // The account already lets the exchange move its tAMZN, which this mandate doesn't list.
  await op.read.waitForTransactionReceipt({
    hash: await op.send(d.amzn, testTokenAbi, "approve", [d.router, usd(1_000)]),
  });
  const check = await checkUnprotectedAllowances(op.read, {
    account: op.wallet.account.address,
    targets: [d.router],
    assets: [d.usdg, d.tsla],
    tokens: deploymentTokens(d),
  });
  expect(check.unprotected.map((f) => f.symbol)).toEqual(["tAMZN"]);
  expect(check.unprotected[0]).toMatchObject({ spender: d.router, allowance: usd(1_000) });
}, 120_000);
