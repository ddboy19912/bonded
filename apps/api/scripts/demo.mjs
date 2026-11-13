// The whole Bonded demo on your own machine, in one command, with no keys or accounts
// (docs/SPECIFICATION.md Section 21 and Day 14 detail):
//
//   pnpm demo                    rate both agents with 5 runs per attack, like the published scores
//   pnpm demo -- --runs 1        1 run per attack (faster, wider uncertainty, lower scores)
//   pnpm demo -- --no-web        stop after the break-it run instead of serving the web app
//   pnpm demo -- --byo           also connect your own agent through the runner and gateway, and a
//                                smart account protected by a mandate module (demo-byo.mjs)
//
// It starts a local chain with the contracts and a throwaway Postgres, runs the API, keeper and
// rating worker, then plays the demo:
//   1. Agent A (one gap: it checks addresses by their ends only) and Agent B (hardened, Enforce)
//      get vaults and operator bonds; underwriters fund the pool.
//   2. The Arena rates both; each signed score is posted to the local registry.
//   3. Each operator buys 20,000 tUSDG of cover at its quoted premium.
//   4. Break it: a lookalike of Agent A's depositor asks for a "refund". Agent A's own brain pays
//      it, the vault records the breach and freezes, and the keeper files the claim: bond first,
//      then the pool.
//   5. The web app runs against this chain, so you can click through the result, or onboard,
//      rate, insure and breach an agent of your own (the rating worker keeps running).
// Everything is local and disappears when you stop it (Ctrl-C).
import process from "node:process";
import console from "node:console";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { portIsFree } from "../dist/demo-checks.js";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { clearTimeout, setTimeout } from "node:timers";
import EmbeddedPostgres from "embedded-postgres";
import { serve } from "@hono/node-server";
import { Sandbox, ANVIL_KEYS, loadAttackLibrary, runLiveAttack } from "@bonded/arena";
import { createPartialAgent } from "@bonded/demo-agents";
import { Database, json } from "@bonded/db";
import { Keeper, connectChain } from "@bonded/keeper";
import {
  EvmMandate,
  toEvmMandateParams,
  bondedRegistryAbi,
  mandateVaultFactoryAbi,
  mandateVaultAbi,
  testTokenAbi,
  coverManagerAbi,
  operatorBondAbi,
  coverPoolAbi,
  claimsEngineAbi,
  demoRouterAbi,
  quoteMessage,
  tierForScore,
} from "@bondedhq/shared";
import {
  formatUnits,
  getAbiItem,
  keccak256,
  parseEther,
  parseEventLogs,
  stringToBytes,
  toFunctionSelector,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApi } from "../dist/index.js";
import { workOne } from "../dist/worker.js";

const args = process.argv.slice(2);
const { values } = parseArgs({
  args: args[0] === "--" ? args.slice(1) : args,
  options: {
    runs: { type: "string", default: "5" },
    "no-web": { type: "boolean", default: false },
    "api-port": { type: "string", default: "3000" },
    "web-port": { type: "string", default: "5180" },
    byo: { type: "boolean", default: false },
  },
});
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be 1 to 10");
const COVER = 20_000;
const usd = (n) => BigInt(n) * 1_000_000n;
const $ = (v) =>
  `$${Number(formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const say = (text) => console.log(`\n== ${text}`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

let sandbox, pg, db, server, web, directory, stopping, byoGateway;
const loops = [];
/** More to stop (the --byo runner). */
const extraStops = [];
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const step of [
    ...extraStops,
    () => web?.pid && process.kill(-web.pid, "SIGTERM"),
    // Bounded: an open runner connection mustn't hold up the rest of the cleanup.
    () => byoGateway && Promise.race([byoGateway.close(), delay(3000)]),
    () => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve())),
    () => db?.close(),
    () => pg?.stop(),
    () => sandbox?.stop(),
    () => directory && rm(directory, { recursive: true, force: true }),
  ]) {
    try {
      await step();
    } catch {
      // keep cleaning up
    }
  }
  process.exit(code);
}
process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

try {
  // Fail before starting anything if a port the demo needs is taken.
  for (const [name, port] of [
    ["--api-port", values["api-port"]],
    ...(values["no-web"] ? [] : [["--web-port", values["web-port"]]]),
  ])
    if (!(await portIsFree(Number(port))))
      throw new Error(`port ${port} is already in use; free it or pass ${name} <another port>`);

  say("Starting a local chain and deploying the contracts");
  sandbox = await Sandbox.start();
  const d = sandbox.deployment;
  const rpc = sandbox.rpcUrl;
  const key = ANVIL_KEYS.deployer; // a public anvil test key: operator, attester and keeper here
  const chain = connectChain(d, rpc, key);
  const operator = chain.wallet.account.address;
  const send = async (address, abi, name, fnArgs) => {
    const hash = await chain.send(address, abi, name, fnArgs);
    return chain.read.waitForTransactionReceipt({ hash });
  };
  const mineBlocks = async (n) => {
    for (let i = 0; i < n; i++) await chain.read.request({ method: "evm_mine", params: [] });
  };

  say("Underwriters fund the cover pool; operators set up Agent A and Agent B");
  // The test token caps one faucet call at 1,000,000.
  await send(d.usdg, testTokenAbi, "faucet", [usd(1_000_000)]);
  await send(d.usdg, testTokenAbi, "faucet", [usd(200_000)]);
  await send(d.usdg, testTokenAbi, "approve", [d.pool, usd(1_000_000)]);
  await send(d.pool, coverPoolAbi, "deposit", [usd(1_000_000), operator]);
  const router = {
    address: d.router,
    selectors: [toFunctionSelector(getAbiItem({ abi: demoRouterAbi, name: "swap" }))],
  };
  const createAgent = async ({ label, mode, destinations, bond }) => {
    const registered = await send(d.registry, bondedRegistryAbi, "register", [
      `ipfs://bonded/demo/${label}`,
    ]);
    const agentId = parseEventLogs({
      abi: bondedRegistryAbi,
      logs: registered.logs,
      eventName: "Registered",
    })[0].args.agentId;
    const mandate = EvmMandate.parse({
      version: 1,
      chain: { family: "evm", chainId: d.chainId },
      agentId: agentId.toString(),
      mode,
      baseAsset: d.usdg,
      assets: [d.usdg, d.tsla, d.amzn, d.nvda],
      targets: [router],
      destinations,
      limits: {
        maxTxNotionalUsd: 5000,
        maxDailyNotionalUsd: 25000,
        maxDrawdownBps: 1500,
        maxSlippageBps: 300,
      },
      freezeOnBreach: true,
      description: `Local demo ${label}`,
    });
    const agentKey = generatePrivateKey();
    const agentAddress = privateKeyToAccount(agentKey).address;
    const created = await send(d.factory, mandateVaultFactoryAbi, "createVault", [
      toEvmMandateParams(mandate),
      agentAddress,
      operator,
      agentId,
      `${label} vault`,
      "DEMO",
    ]);
    const vault = parseEventLogs({
      abi: mandateVaultFactoryAbi,
      logs: created.logs,
      eventName: "VaultCreated",
    })[0].args.vault;
    await chain.read.request({
      method: "anvil_setBalance",
      params: [agentAddress, `0x${parseEther("1").toString(16)}`],
    });
    await send(d.usdg, testTokenAbi, "approve", [vault, usd(50_000)]);
    await send(vault, mandateVaultAbi, "deposit", [usd(50_000), operator]);
    console.log(`  ${label}: agent ${agentId}, vault ${vault}`);
    return { label, agentId, mandate, vault, agentKey, bond };
  };
  // Agent A's operator stakes the minimum bond for its rated tier (after the rating, below), so
  // a claim shows the bond paying first and the pool the rest. Agent B's stakes generously.
  const agentA = await createAgent({
    label: "Agent A",
    mode: "monitor",
    destinations: [operator],
    bond: null,
  });
  const agentB = await createAgent({
    label: "Agent B",
    mode: "enforce",
    destinations: [],
    bond: 10_000,
  });

  say("Starting the API, keeper and rating worker");
  console.log(
    "  (Agent B here has no TEE, so it carries the operator-held-key assumption and scores a little",
  );
  console.log("  below agent 3 on testnet, which does: ADR-014.)");
  directory = await mkdtemp(join(tmpdir(), "bonded-demo-"));
  const pgPort = await freePort();
  pg = new EmbeddedPostgres({
    databaseDir: join(directory, "db"),
    user: "postgres",
    password: "demo",
    port: pgPort,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  db = new Database(`postgres://postgres:demo@127.0.0.1:${pgPort}/postgres`);
  await db.migrate();
  await db.reconcileAgents(d.chainId, [
    {
      agentId: agentA.agentId.toString(),
      config: {
        kind: "partial",
        mandate: agentA.mandate,
        codeHash: keccak256(stringToBytes("bonded/scripted-partial/v0")),
        repeats: runs,
      },
    },
    {
      agentId: agentB.agentId.toString(),
      config: {
        kind: "hardened",
        mandate: agentB.mandate,
        codeHash: keccak256(stringToBytes("bonded/scripted-hardened/v0")),
        repeats: runs,
      },
    },
  ]);
  const token = randomBytes(24).toString("hex");
  const webOrigin = `http://localhost:${values["web-port"]}`;
  // --byo: the Arena Gateway your own agent's runner connects to (demo-byo.mjs).
  const byo = values.byo ? await import("./demo-byo.mjs") : undefined;
  const started = byo ? await byo.startGateway(db, d.chainId) : undefined;
  byoGateway = started?.gateway;
  const workerOptions = started ? { remote: started.remote, heldOut: { perClass: 1 } } : {};
  const app = createApi({
    db,
    chain,
    attesterKey: key,
    apiToken: token,
    webOrigins: [webOrigin],
    ...(started
      ? {
          ...started.api,
          gatewayUrl: started.url,
          selfServe: {
            repeats: runs,
            remote: { ...byo.DEFAULT_REMOTE_POLICY, repeats: Math.min(runs, 3) },
          },
        }
      : {}),
  });
  server = serve({ fetch: app.fetch, port: Number(values["api-port"]) });
  const apiUrl = `http://localhost:${values["api-port"]}`;
  const post = async (path, body) => {
    const r = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: json(body),
    });
    const data = await r.json();
    if (r.status >= 400) throw new Error(`${path}: ${data.error ?? r.status}`);
    return data;
  };
  const keeper = new Keeper(db, chain, 0n);
  loops.push(
    (async () => {
      while (!stopping) {
        await keeper.tick().catch(() => {});
        await delay(2000);
      }
    })(),
  );

  say(`Rating both agents in the Arena (${runs} run${runs > 1 ? "s" : ""} per attack)`);
  const runIds = [];
  for (const agent of [agentA, agentB])
    runIds.push((await post("/arena/runs", { agentId: agent.agentId.toString() })).runId);
  // The rating sandbox forks a few blocks behind the tip; make sure it includes the setup.
  await mineBlocks(6);
  for (const [i, agent] of [agentA, agentB].entries()) {
    const started = Date.now();
    while (true) {
      await workOne(db, chain, rpc, key, (e) =>
        console.error(`  worker: ${e instanceof Error ? e.message : e}`),
      );
      const row = (await db.pool.query("SELECT status FROM ratings WHERE id=$1", [runIds[i]]))
        .rows[0];
      if (row.status === "done") break;
      if (row.status === "failed") throw new Error(`${agent.label}'s rating failed`);
    }
    const report = (await db.pool.query("SELECT report FROM ratings WHERE id=$1", [runIds[i]]))
      .rows[0].report;
    const s = report.scoring;
    agent.score = s.score;
    const breached = report.classes.filter((c) => c.breaches > 0);
    console.log(
      `  ${agent.label}: score ${s.score} (${s.tier}), expected loss ${(s.expectedLossBps / 100).toFixed(2)}%, ` +
        `premium ${(s.premiumRateBps / 100).toFixed(2)}% a year; ` +
        (breached.length
          ? `breached by ${breached.map((c) => `${c.class} ${c.breaches}/${c.episodes}`).join(", ")}`
          : "no breaches") +
        ` (${Math.round((Date.now() - started) / 1000)} s)`,
    );
  }

  say(`Each operator stakes a bond and buys ${COVER.toLocaleString("en-US")} tUSDG of cover`);
  for (const agent of [agentA, agentB]) {
    const minBond = (COVER * tierForScore(agent.score).minBondBps) / 10_000;
    const bond = agent.bond ?? minBond;
    await send(d.usdg, testTokenAbi, "approve", [d.bond, usd(bond)]);
    await send(d.bond, operatorBondAbi, "stake", [agent.agentId, usd(bond)]);
    const signed = await post("/quotes", {
      agentId: agent.agentId.toString(),
      vault: agent.vault,
      coverAmount: usd(COVER).toString(),
    });
    await send(d.coverManager, coverManagerAbi, "buyCover", [
      quoteMessage(signed.quote),
      signed.signature,
    ]);
    console.log(
      `  ${agent.label}: bond ${bond.toLocaleString("en-US")} tUSDG (tier minimum ${minBond.toLocaleString("en-US")}), ` +
        `premium ${(signed.quote.premiumRateBps / 100).toFixed(2)}% a year after the bond discount`,
    );
  }

  // From here the rating worker keeps running, so ratings asked for in the web app (self-serve
  // onboarding) are picked up while the demo runs.
  loops.push(
    (async () => {
      while (!stopping) {
        await workOne(db, chain, rpc, key, () => {}, undefined, workerOptions).catch(() => {});
        // --byo: connection checks and previews asked for in the web app, too.
        if (started) await started.workExtras(chain, rpc).catch(() => {});
        await delay(2000);
      }
    })(),
  );

  say('Break it: a lookalike of Agent A\'s depositor asks for a "refund"');
  const bondBefore = await chain.read.readContract({
    address: d.bond,
    abi: operatorBondAbi,
    functionName: "bondOf",
    args: [agentA.agentId],
  });
  const agentWallet = connectChain(d, rpc, agentA.agentKey).wallet;
  const result = await runLiveAttack({
    chain: { deployment: d, publicClient: chain.read, wallet: () => agentWallet },
    vault: agentA.vault,
    mandate: agentA.mandate,
    agent: createPartialAgent("scripted"),
    attack: loadAttackLibrary().find((s) => s.id === "A5-address-poisoning-001"),
  });
  console.log(`  depositor ${agentA.mandate.destinations[0]}`);
  console.log(`  lookalike ${result.planted[0]?.sender}`);
  for (const step of result.trace.filter((s) => s.tool === "transfer"))
    console.log(`  Agent A sends ${step.args.amount} ${step.args.token} to ${step.args.to}`);
  if (!result.breachIds.length) throw new Error("the vault recorded no breach");
  console.log(`  The vault records the breach and freezes Agent A (frozen: ${result.frozen}).`);

  let paid;
  for (let i = 0; i < 60 && !paid; i++) {
    const logs = await chain.read.getLogs({
      address: d.claimsEngine,
      event: getAbiItem({ abi: claimsEngineAbi, name: "ClaimPaid" }),
      args: { vault: agentA.vault },
      fromBlock: 0n,
      toBlock: "latest",
      strict: true,
    });
    paid = logs.at(-1);
    if (!paid) {
      await mineBlocks(1);
      await delay(1000);
    }
  }
  if (!paid) throw new Error("the keeper did not claim within a minute");
  const c = paid.args;
  say("The keeper filed the claim; the contract paid it");
  console.log(`  loss      ${$(c.lossBase)}`);
  console.log(`  payout    ${$(c.payout)} (loss minus the 10% deductible)`);
  console.log(`  from bond ${$(c.fromBond)} (Agent A's operator had ${$(bondBefore)} staked)`);
  console.log(`  from pool ${$(c.fromPool)}`);
  if (c.premiumNetted > 0n) console.log(`  premium owed, netted: ${$(c.premiumNetted)}`);

  const extra = byo
    ? await byo.runByoDemo({
        d,
        rpc,
        chain,
        key,
        db,
        app,
        send,
        say,
        mineBlocks,
        template: agentA.mandate,
        gatewayUrl: started.url,
        onStop: (fn) => extraStops.push(fn),
      })
    : undefined;

  if (values["no-web"]) await stop(0);
  say("Serving the web app against this chain");
  web = spawn(
    "pnpm",
    ["--filter", "@bonded/web", "exec", "vite", "--port", values["web-port"], "--strictPort"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so stopping kills Vite too, not just the pnpm wrapper.
      detached: true,
      env: {
        ...process.env,
        VITE_DEPLOYMENT_JSON: JSON.stringify(d),
        VITE_RPC_URL: rpc,
        VITE_API_URL: apiUrl,
      },
    },
  );
  // Advertise the URLs only once this Vite instance says it is serving on our port; if it exits
  // first (e.g. the port was taken after the check above), stop everything.
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("the web app did not start within 60 s")),
      60_000,
    );
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(`localhost:${values["web-port"]}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    web.stdout.on("data", onData);
    web.stderr.on("data", onData);
    web.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    web.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the web app exited (code ${code}): ${output.trim().split("\n").at(-1)}`));
    });
  });
  web.removeAllListeners("exit");
  web.once("exit", (code) => {
    if (stopping) return;
    console.error(`\nThe web app stopped (code ${code}); stopping the demo.`);
    void stop(1);
  });
  console.log(`  Web app:       ${webOrigin}`);
  console.log(`  Agent A:       ${webOrigin}/agents/${agentA.agentId}`);
  console.log(`  Agent B:       ${webOrigin}/agents/${agentB.agentId}`);
  if (extra) {
    console.log(`  Own agent:     ${webOrigin}/agents/${extra.byoId}`);
    console.log(`  Smart account: ${webOrigin}/agents/${extra.moduleId}`);
  }
  console.log(`  Claims:        ${webOrigin}/claims`);
  console.log(`  API:           ${apiUrl}/health`);
  console.log("\nPress Ctrl-C to stop everything.");
} catch (error) {
  console.error(`\nThe demo stopped: ${error instanceof Error ? error.message : error}`);
  await stop(1);
}
