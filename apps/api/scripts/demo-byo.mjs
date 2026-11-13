// `pnpm demo -- --byo`: the bring-your-own-agent part of the local demo (demo.mjs runs it after
// the usual story). Two more agents, both owned by the demo's operator key:
//   1. Your own agent: examples/byo-agent, started by the real @bondedhq/runner, connected to a local
//      Arena Gateway with a runner token made through the API, then rated through the gateway
//      (tool mode, declared binding, plus a held-out set made for this rating alone).
//   2. A smart account protected by a MandateModule: the ERC-7579 reference account (from the
//      forge build), with the module created and installed in one batch, Enforce mode, rated as
//      Bonded's hardened design and covered.
import process from "node:process";
import console from "node:console";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ArenaGateway } from "@bonded/arena";
import {
  EvmMandate,
  bondedRegistryAbi,
  byoaMessage,
  coverManagerAbi,
  mandateHash,
  mandateVaultFactoryAbi,
  mandateVaultAbi,
  operatorBondAbi,
  prepareModuleInstall,
  quoteMessage,
  selfServeMessage,
  testTokenAbi,
  tierForScore,
  toEvmMandateParams,
} from "@bondedhq/shared";
import {
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { gatewayAgents } from "../dist/remote-agent.js";
import { SecretBox } from "../dist/secrets.js";
import { agentUrlSigner, newAgentUrlSigningKey } from "@bondedhq/shared";
import { gatewayCheckRunner, gatewayUrlVerifier } from "../dist/connections.js";
import { workCheckOne } from "../dist/check-worker.js";
import { workPreviewOne } from "../dist/preview-worker.js";
export { DEFAULT_REMOTE_POLICY } from "../dist/remote-policy.js";
import { DbRunnerAuth, RunnerPresenceWriter } from "../dist/runners.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RUNNER_CLI = `${ROOT}apps/runner/dist/cli.js`;
const BYO_AGENT = `${ROOT}examples/byo-agent/dist/main.js`;
/** ERC-4337 EntryPoint v0.7: the reference account accepts `execute` from it (a user operation). */
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const usd = (n) => BigInt(n) * 1_000_000n;

/**
 * The local Arena Gateway, with runner tokens and presence in the demo's database, and what
 * Agent URL mode, connection checks and previews need on this machine: an ephemeral signing key
 * (AGENT_URL_SIGNING_KEY's stand-in, for this run only; the API publishes it, so a handler given
 * `apiUrl` of the local API checks calls with it), an ephemeral secret key for webhooks
 * (AGENT_URL_SECRET_KEY's stand-in) and plain-http loopback Agent URLs.
 */
export async function startGateway(db, chainId) {
  const presence = new RunnerPresenceWriter(db);
  const signer = await agentUrlSigner(await newAgentUrlSigningKey());
  const gateway = new ArenaGateway({
    tokens: new DbRunnerAuth(db, chainId),
    onRunnerPresence: presence.onEvent,
    agentUrl: { allowLoopback: true, signer },
  });
  const url = await gateway.listen({ port: 0, host: "127.0.0.1" });
  const secrets = new SecretBox(randomBytes(32));
  const remote = gatewayAgents(gateway);
  return {
    gateway,
    url,
    remote,
    secrets,
    // What createApi takes for Agent URLs on this machine.
    api: {
      secrets,
      agentUrlSigner: signer,
      verifyAgentUrl: gatewayUrlVerifier(gateway.agentUrls),
      allowLoopbackUrls: true,
    },
    // Connection checks and previews, run alongside the demo's rating worker.
    async workExtras(chain, rpc) {
      await workCheckOne(db, chainId, { runCheck: gatewayCheckRunner(gateway) });
      await workPreviewOne(db, chain, rpc, { remote, heldOut: { perClass: 1 } });
    },
  };
}

/** Forge artifact of a contract (contracts/evm/out), for deploying test-only contracts. */
async function artifact(file, name) {
  const json = JSON.parse(await readFile(`${ROOT}contracts/evm/out/${file}/${name}.json`, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export async function runByoDemo(ctx) {
  const { d, rpc, chain, key, db, app, send, say, gatewayUrl, onStop } = ctx;
  const owner = privateKeyToAccount(key);
  const operator = owner.address;
  const now = () => Math.floor(Date.now() / 1000);
  const signed = async (path, body, request, method = "POST") => {
    const timestamp = now();
    const signature = await owner.signMessage({
      message: selfServeMessage({ ...request, timestamp }),
    });
    const r = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, timestamp, signature }),
    });
    const data = await r.json();
    if (r.status >= 400) throw new Error(`${path}: ${data.error ?? r.status}`);
    return data;
  };
  const register = async (label) => {
    const r = await send(d.registry, bondedRegistryAbi, "register", [
      `ipfs://bonded/demo/${label}`,
    ]);
    return parseEventLogs({ abi: bondedRegistryAbi, logs: r.logs, eventName: "Registered" })[0].args
      .agentId;
  };
  const mandateFor = (agentId, mode, label) =>
    EvmMandate.parse({
      ...ctx.template,
      agentId: agentId.toString(),
      mode,
      description: `Local demo ${label}`,
    });
  const waitFor = async (runId, label) => {
    for (;;) {
      const row = (
        await db.pool.query("SELECT status,error,report FROM ratings WHERE id=$1", [runId])
      ).rows[0];
      if (row.status === "done") return row.report;
      if (row.status === "failed") throw new Error(`${label}'s rating failed: ${row.error}`);
      await delay(2000);
    }
  };
  // Enough test tUSDG for a vault deposit, an account balance and two bonds.
  await send(d.usdg, testTokenAbi, "faucet", [usd(200_000)]);

  say("Your own agent: examples/byo-agent, connected through @bondedhq/runner");
  const byoId = await register("byo-agent");
  const byoMandate = mandateFor(byoId, "monitor", "own agent");
  const made = await send(d.factory, mandateVaultFactoryAbi, "createVault", [
    toEvmMandateParams(byoMandate),
    operator,
    operator,
    byoId,
    "Own agent vault",
    "DEMO",
  ]);
  const byoVault = parseEventLogs({
    abi: mandateVaultFactoryAbi,
    logs: made.logs,
    eventName: "VaultCreated",
  })[0].args.vault;
  await send(d.usdg, testTokenAbi, "approve", [byoVault, usd(50_000)]);
  await send(byoVault, mandateVaultAbi, "deposit", [usd(50_000), operator]);
  // A rating of your own agent needs an operator bond staked (skin in the game).
  await send(d.usdg, testTokenAbi, "approve", [d.bond, usd(2_000)]);
  await send(d.bond, operatorBondAbi, "stake", [byoId, usd(2_000)]);
  const codeHash = keccak256(stringToBytes("examples/byo-agent"));
  const remote = { codeHash, mode: "tools" };
  const base = { chainId: d.chainId, agentId: byoId.toString() };
  await signed(
    "/self/agents",
    { agentId: byoId.toString(), vault: byoVault, kind: "remote", mandate: byoMandate, ...remote },
    {
      action: "register",
      ...base,
      vault: byoVault,
      kind: "remote",
      mandateHash: mandateHash(byoMandate),
      remote,
    },
  );
  const { token } = await signed(
    `/self/agents/${byoId}/runner-token`,
    {},
    {
      action: "runner-token",
      ...base,
    },
  );
  console.log(
    `  agent ${byoId}, vault ${byoVault}; runner token made (shown once, kept in memory)`,
  );
  const runner = spawn(
    process.execPath,
    [RUNNER_CLI, "--gateway", gatewayUrl, "--quiet", "--", process.execPath, BYO_AGENT],
    { env: { ...process.env, BONDED_RUNNER_TOKEN: token }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let runnerLog = "";
  runner.stderr.on("data", (chunk) => (runnerLog += chunk));
  onStop(() => runner.kill("SIGTERM"));
  for (let i = 0; !(await db.runnerIsConnected(`${d.chainId}:${byoId}`)); i++) {
    if (i > 100) throw new Error(`the runner didn't connect:\n${runnerLog}`);
    await delay(200);
  }
  console.log(`  runner connected to the gateway at ${gatewayUrl}`);
  // A rating needs a passing connection check of this connection: one benign episode, run by the
  // demo's check lane through the same gateway, signed by the owner like any other request.
  {
    const timestamp = now();
    const signature = await owner.signMessage({
      message: byoaMessage({ action: "check", ...base, timestamp }),
    });
    const r = await app.request(`/self/agents/${byoId}/checks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timestamp, signature }),
    });
    const made = await r.json();
    if (r.status >= 400) throw new Error(`connection check: ${made.error ?? r.status}`);
    for (let i = 0; ; i++) {
      const check = await db.check(made.checkId);
      if (check.status === "passed") break;
      if (check.status === "failed")
        throw new Error(`the connection check failed: ${check.result?.problems?.join(" ")}`);
      if (i > 120) throw new Error(`the connection check didn't finish:\n${runnerLog}`);
      await delay(1000);
    }
    console.log("  connection check passed (one benign episode)");
  }
  // The rating sandbox forks a few blocks behind the tip; make sure it includes the setup.
  await ctx.mineBlocks(6);
  const started = Date.now();
  const { runId } = await signed(`/self/agents/${byoId}/rate`, {}, { action: "rate", ...base });
  const report = await waitFor(runId, "your own agent");
  const breached = report.classes.filter((c) => c.breaches > 0);
  console.log(
    `  score ${report.scoring.score} (${report.scoring.tier}), binding declared; ` +
      `${report.episodes.total} episodes (${report.heldOut?.attacks ?? 0} held out for this rating alone); ` +
      `read ${report.coverage?.readSurfaces.join(", ") || "nothing"}; ` +
      (breached.length
        ? `breached by ${breached.map((c) => `${c.class} ${c.breaches}/${c.episodes}`).join(", ")}`
        : "no breaches") +
      ` (${Math.round((Date.now() - started) / 1000)} s)`,
  );

  say("A smart account protected by a mandate module (ERC-7579 reference account, Enforce)");
  const moduleId = await register("smart-account");
  const moduleMandate = mandateFor(moduleId, "enforce", "smart account");
  // The reference account (forge build): an implementation, its bootstrap, and a proxy for it.
  const deploy = async ({ abi, bytecode }, args = []) => {
    const hash = await chain.wallet.deployContract({
      abi,
      bytecode,
      args,
      account: chain.wallet.account,
      chain: chain.wallet.chain,
    });
    return (await chain.read.waitForTransactionReceipt({ hash })).contractAddress;
  };
  const msa = await artifact("MSAAdvanced.sol", "MSAAdvanced");
  const bootstrap = await artifact("Bootstrap.sol", "Bootstrap");
  const implementation = await deploy(msa);
  const boot = await deploy(bootstrap);
  const none = [];
  const init = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes" }],
    [
      boot,
      encodeFunctionData({
        abi: bootstrap.abi,
        functionName: "initMSA",
        args: [
          none,
          none,
          { module: "0x0000000000000000000000000000000000000000", data: "0x" },
          none,
        ],
      }),
    ],
  );
  const account = await deploy(await artifact("ModuleTestBase.sol", "TestMSAProxy"), [
    implementation,
    encodeFunctionData({ abi: msa.abi, functionName: "initializeAccount", args: [init] }),
  ]);
  // The account's owner acts as a validated user operation would: through the EntryPoint.
  await chain.read.request({ method: "anvil_impersonateAccount", params: [ENTRY_POINT] });
  await chain.read.request({
    method: "anvil_setBalance",
    params: [ENTRY_POINT, `0x${parseEther("1").toString(16)}`],
  });
  const entryPoint = createWalletClient({
    account: ENTRY_POINT,
    chain: chain.wallet.chain,
    transport: http(rpc),
  });
  const plan = await prepareModuleInstall(chain.read, {
    moduleFactory: d.moduleFactory,
    account,
    params: toEvmMandateParams(moduleMandate),
    agent: operator,
    guardian: operator,
    agentId: moduleId,
    accountType: "erc7579",
  });
  await chain.read.waitForTransactionReceipt({
    hash: await entryPoint.sendTransaction({ to: account, data: plan.execute.data }),
  });
  await send(d.usdg, testTokenAbi, "transfer", [account, usd(50_000)]);
  console.log(
    `  agent ${moduleId}, account ${account}, module ${plan.module} (one batch: create, install)`,
  );
  await signed(
    "/self/agents",
    {
      agentId: moduleId.toString(),
      vault: plan.module,
      kind: "hardened",
      mandate: moduleMandate,
      protection: "module",
    },
    {
      action: "register",
      chainId: d.chainId,
      agentId: moduleId.toString(),
      vault: plan.module,
      kind: "hardened",
      mandateHash: mandateHash(moduleMandate),
      protection: "module",
    },
  );
  await ctx.mineBlocks(6);
  const moduleRun = await signed(
    `/self/agents/${moduleId}/rate`,
    {},
    {
      action: "rate",
      chainId: d.chainId,
      agentId: moduleId.toString(),
    },
  );
  const moduleReport = await waitFor(moduleRun.runId, "the smart account's agent");
  const cover = 10_000;
  const minBond = (cover * tierForScore(moduleReport.scoring.score).minBondBps) / 10_000;
  await send(d.usdg, testTokenAbi, "approve", [d.bond, usd(minBond)]);
  await send(d.bond, operatorBondAbi, "stake", [moduleId, usd(minBond)]);
  const r = await app.request("/quotes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: moduleId.toString(),
      vault: plan.module,
      coverAmount: usd(cover).toString(),
    }),
  });
  const quote = await r.json();
  if (r.status >= 400) throw new Error(`/quotes: ${quote.error}`);
  await send(d.coverManager, coverManagerAbi, "buyCover", [
    quoteMessage(quote.quote),
    quote.signature,
  ]);
  console.log(
    `  rated ${moduleReport.scoring.score} (${moduleReport.scoring.tier}) under the module's commitment; ` +
      `${cover.toLocaleString("en-US")} tUSDG of cover bought for the module at ` +
      `${(quote.quote.premiumRateBps / 100).toFixed(2)}% a year`,
  );
  return { byoId, moduleId };
}
