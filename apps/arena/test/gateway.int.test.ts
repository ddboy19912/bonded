import { ScriptedVulnerableAgent } from "@bonded/demo-agents";
import {
  agentToolJsonSchema,
  mandateVaultAbi,
  RUNNER_CLOSE,
  RUNNER_PROTOCOL_VERSION,
  testTokenAbi,
} from "@bondedhq/shared";
import { encodeFunctionData, parseEther, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addressGroup,
  ANVIL_KEYS,
  ArenaGateway,
  ArenaToolbox,
  CHAIN_MODE_WRITE,
  createAgentVault,
  type GatewayEpisode,
  loadAttackLibrary,
  marketTokens,
  RemoteAgent,
  type RemoteRunSummary,
  type RunnerPresenceEvent,
  runEpisode,
  Sandbox,
  StaticRunnerTokens,
  World,
} from "../src/index.js";
import { eventually, type FakeRunner, fakeRunner, mcpToolbox } from "./fixtures/gateway-client.js";

const RUNNER_TOKEN = "bonded_rt_runner-token-for-tests-0001";
const OTHER_TOKEN = "bonded_rt_runner-token-for-tests-0002";

let sandbox: Sandbox;
let gateway: ArenaGateway;
let url: string;
/** Counts token checks, to show they stay bounded whatever a runner sends. */
class CountingTokens extends StaticRunnerTokens {
  checks = 0;
  override async validate(token: string) {
    this.checks++;
    return super.validate(token);
  }
}
let tokens: CountingTokens;
const presence: RunnerPresenceEvent[] = [];
const cleanup: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  sandbox = await Sandbox.start();
  tokens = new CountingTokens({ [RUNNER_TOKEN]: "agent-1", [OTHER_TOKEN]: "agent-2" });
  gateway = new ArenaGateway({
    tokens,
    onRunnerPresence: (e) => presence.push(e),
    // A one-second heartbeat, so the socket's timers can be tested quickly.
    limits: { bodyBytes: 4096, rpcBatch: 5, readyTimeoutMs: 300, heartbeatMs: 1_000 },
  });
  url = await gateway.listen();
});
afterAll(async () => {
  await gateway?.close();
  await sandbox?.stop();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A fresh tool-mode toolbox and its episode at the gateway. */
async function toolsEpisode(options: { gated?: boolean; maxSteps?: number } = {}) {
  const vault = await createAgentVault(sandbox);
  const world = new World(marketTokens(sandbox), sandbox.address("depositor"));
  const toolbox = new ArenaToolbox(sandbox, world, vault.address, options.maxSteps ?? 20);
  const episode = gateway.openEpisode({
    episodeId: `t-${Math.random()}`,
    toolbox,
    mode: "tools",
    ...(options.gated ? { gated: true } : {}),
  });
  cleanup.push(() => episode.close());
  return { toolbox, episode, vault, world };
}

/** A chain-mode episode whose vault's agent is a fresh session key. */
async function chainEpisode(maxSteps = 20) {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  await sandbox.fund(account.address);
  const vault = await createAgentVault(sandbox, { agent: account.address });
  const world = new World(marketTokens(sandbox), sandbox.address("depositor"));
  const toolbox = new ArenaToolbox(sandbox, world, vault.address, maxSteps);
  const episode = gateway.openEpisode({
    episodeId: `c-${Math.random()}`,
    toolbox,
    mode: "chain",
    chain: {
      upstream: sandbox.rpcUrl,
      chainId: sandbox.chain.id,
      vault: vault.address,
      agent: account.address,
    },
  });
  cleanup.push(() => episode.close());
  return { toolbox, episode, vault, account, key };
}

const post = (target: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const rpc = async (episode: GatewayEpisode, method: string, params: unknown[] = []) =>
  (await (
    await post(episode.endpoints.rpc!, { jsonrpc: "2.0", id: 1, method, params })
  ).json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };

describe("capability tokens", () => {
  it("reach exactly one episode's toolbox", async () => {
    const a = await toolsEpisode();
    const b = await toolsEpisode();
    expect(a.episode.token).not.toBe(b.episode.token);
    expect(a.episode.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await post(`${a.episode.endpoints.tools}/get_prices`, {});
    expect(a.toolbox.trace.map((s) => s.tool)).toEqual(["get_prices"]);
    expect(b.toolbox.trace).toEqual([]);
  });

  it("refuse unknown, malformed and runner tokens", async () => {
    await toolsEpisode();
    const bogus = "A".repeat(43);
    for (const token of [bogus, "short", RUNNER_TOKEN, encodeURIComponent("../x")]) {
      const res = await post(`${url}/e/${token}/tools/get_prices`, {});
      expect(res.status).toBe(404);
    }
    expect((await fetch(`${url}/`)).status).toBe(404);
  });

  it("stop working the moment the episode ends, and after /done", async () => {
    const { episode, toolbox } = await toolsEpisode();
    const done = await post(episode.endpoints.done, { finalMessage: "finished" });
    expect(done.status).toBe(200);
    await expect(episode.done).resolves.toEqual({ finalMessage: "finished" });
    const after = await post(`${episode.endpoints.tools}/get_prices`, {});
    expect(await after.json()).toEqual({ ok: false, error: "the episode is over" });
    episode.close();
    expect((await post(`${episode.endpoints.tools}/get_prices`, {})).status).toBe(404);
    expect((await fetch(episode.endpoints.tools)).status).toBe(404);
    expect(toolbox.trace).toEqual([]);
  });
});

describe("tools over HTTP and MCP", () => {
  it("lists the same tools and schemas as the in-process contract", async () => {
    const { episode } = await toolsEpisode();
    const { tools } = (await (await fetch(episode.endpoints.tools)).json()) as {
      tools: { name: string; inputSchema: Record<string, unknown> }[];
    };
    expect(tools).toHaveLength(13);
    const swap = agentToolJsonSchema("swap");
    expect({ $schema: swap.$schema, ...tools.find((t) => t.name === "swap")?.inputSchema }).toEqual(
      swap,
    );
    const openapi = (await (await fetch(episode.endpoints.openapi)).json()) as {
      openapi: string;
      servers: { url: string }[];
      paths: Record<string, unknown>;
    };
    expect(openapi.openapi).toBe("3.1.0");
    expect(openapi.servers[0]?.url).toBe(episode.endpoints.tools.replace(/\/tools$/, ""));
    expect(Object.keys(openapi.paths)).toContain("/tools/swap");
    expect(Object.keys(openapi.paths)).not.toContain("/rpc");
  });

  it("returns the toolbox's own result, including failures, and logs each read's surface", async () => {
    const { episode, world } = await toolsEpisode();
    const inbox = (await (await post(`${episode.endpoints.tools}/read_inbox`, {})).json()) as {
      ok: boolean;
      output: unknown;
    };
    expect(inbox).toEqual({ ok: true, output: world.inbox });
    const bad = await (await post(`${episode.endpoints.tools}/transfer`, { to: "0xdead" })).json();
    expect(bad).toMatchObject({ ok: false });
    const unknown = await (await post(`${episode.endpoints.tools}/self_destruct`, {})).json();
    expect(unknown).toEqual({ ok: false, error: "unknown tool: self_destruct" });
    // An empty body means no arguments.
    const empty = await fetch(`${episode.endpoints.tools}/get_prices`, { method: "POST" });
    expect(await empty.json()).toMatchObject({ ok: true });
    expect(episode.reads.map((r) => [r.tool, r.surface, r.ok])).toEqual([
      ["read_inbox", "dm", true],
      ["transfer", undefined, false],
      ["self_destruct", undefined, false],
      ["get_prices", "price_feed", true],
    ]);
  });

  it("serves MCP with the official client: list, call and errors", async () => {
    const { episode } = await toolsEpisode();
    const tools = await mcpToolbox(episode.endpoints.mcp);
    cleanup.push(() => tools.close());
    const prices = await tools.call("get_prices", {});
    expect(prices.ok).toBe(true);
    expect(Object.keys((prices as { output: object }).output)).toEqual([
      "tUSDG",
      "tTSLA",
      "tAMZN",
      "tNVDA",
    ]);
    const info = await tools.call("get_token_info", { symbol: "nope" });
    expect(info).toEqual({ ok: false, error: "no token listed as nope" });
    expect((await fetch(episode.endpoints.mcp)).status).toBe(405);
  });

  it("refuses oversized, mistyped and malformed bodies", async () => {
    const { episode } = await toolsEpisode();
    const big = await post(`${episode.endpoints.tools}/get_prices`, { pad: "x".repeat(5000) });
    expect(big.status).toBe(413);
    const typed = await post(`${episode.endpoints.tools}/get_prices`, "{}", {
      "content-type": "text/plain",
    });
    expect(typed.status).toBe(415);
    const broken = await post(`${episode.endpoints.tools}/get_prices`, "{nope");
    expect(broken.status).toBe(400);
    const done = await post(episode.endpoints.done, { finalMessage: 42 });
    expect(done.status).toBe(400);
  });

  it("holds a gated episode's requests until it opens, and caps requests in flight", async () => {
    const { episode } = await toolsEpisode({ gated: true });
    const waiting = post(`${episode.endpoints.tools}/get_prices`, {});
    await eventually(() => episode.inFlight === 1);
    episode.open();
    expect((await waiting).status).toBe(200);

    const closed = await toolsEpisode({ gated: true });
    expect((await post(`${closed.episode.endpoints.tools}/get_prices`, {})).status).toBe(503);

    const busy = await toolsEpisode({ gated: true });
    const held = Array.from({ length: 8 }, () =>
      post(`${busy.episode.endpoints.tools}/get_prices`, {}),
    );
    await eventually(() => busy.episode.inFlight === 8);
    expect((await post(`${busy.episode.endpoints.tools}/get_prices`, {})).status).toBe(429);
    busy.episode.open();
    await Promise.all(held);
  });
});

describe("chain mode", () => {
  it("lists only the reads and turns write tools away without a step", async () => {
    const { episode, toolbox } = await chainEpisode();
    const { tools } = (await (await fetch(episode.endpoints.tools)).json()) as {
      tools: { name: string }[];
    };
    expect(tools.map((t) => t.name)).not.toContain("swap");
    expect(tools).toHaveLength(10);
    const res = await post(`${episode.endpoints.tools}/swap`, {
      tokenIn: "tUSDG",
      tokenOut: "tNVDA",
      amountIn: "1",
    });
    expect(await res.json()).toEqual({ ok: false, error: CHAIN_MODE_WRITE });
    expect(toolbox.trace).toEqual([]);
  });

  it("passes standard reads and refuses every cheat, signing and filter method", async () => {
    const { episode, vault } = await chainEpisode();
    expect((await rpc(episode, "eth_chainId")).result).toBe(`0x${sandbox.chain.id.toString(16)}`);
    expect((await rpc(episode, "eth_blockNumber")).result).toMatch(/^0x/);
    expect((await rpc(episode, "eth_getCode", [vault.address, "latest"])).result).not.toBe("0x");
    const operator = sandbox.address("operator");
    const before = await sandbox.publicClient.getBalance({ address: operator });
    const refused = [
      ["anvil_setBalance", [operator, "0x0"]],
      ["anvil_impersonateAccount", [operator]],
      ["anvil_nodeInfo", []],
      ["anvil_dumpState", []],
      ["hardhat_setBalance", [operator, "0x0"]],
      ["evm_mine", []],
      ["evm_snapshot", []],
      ["evm_increaseTime", [1000]],
      ["evm_setNextBlockTimestamp", [1]],
      ["debug_traceTransaction", ["0x00"]],
      ["trace_block", ["latest"]],
      ["ots_getApiLevel", []],
      ["txpool_content", []],
      ["eth_sendTransaction", [{ from: operator, to: operator, value: "0x1" }]],
      ["eth_sign", [operator, "0x00"]],
      ["eth_signTransaction", [{ from: operator }]],
      ["eth_signTypedData_v4", [operator, "{}"]],
      ["personal_sign", ["0x00", operator]],
      ["eth_accounts", []],
      ["eth_newFilter", [{}]],
      ["eth_subscribe", ["newHeads"]],
      ["__proto__", []],
    ] as const;
    for (const [method, params] of refused) {
      const response = await rpc(episode, method, [...params]);
      expect(response.error?.code, method).toBe(-32601);
    }
    expect(await sandbox.publicClient.getBalance({ address: operator })).toBe(before);
  });

  it("refuses an upstream answer over the size cap instead of passing it on", async () => {
    const small = new ArenaGateway({ tokens, limits: { upstreamResponseBytes: 200 } });
    await small.listen();
    cleanup.push(() => small.close());
    const { vault, toolbox, account } = await chainEpisode();
    const episode = small.openEpisode({
      episodeId: "small",
      toolbox,
      mode: "chain",
      chain: {
        upstream: sandbox.rpcUrl,
        chainId: sandbox.chain.id,
        vault: vault.address,
        agent: account.address,
      },
    });
    expect((await rpc(episode, "eth_chainId")).result).toBeDefined();
    expect((await rpc(episode, "eth_getCode", [vault.address, "latest"])).error).toEqual({
      code: -32005,
      message: "response too large; narrow the request",
    });
  });

  it("answers web3_clientVersion with the configured live value, not the sandbox node's", async () => {
    const { vault, toolbox, account } = await chainEpisode();
    const plain = (
      await rpc(
        gateway.openEpisode({
          episodeId: "plain",
          toolbox,
          mode: "chain",
          chain: {
            upstream: sandbox.rpcUrl,
            chainId: sandbox.chain.id,
            vault: vault.address,
            agent: account.address,
          },
        }),
        "web3_clientVersion",
      )
    ).result;
    expect(plain).toMatch(/anvil/);
    const masked = gateway.openEpisode({
      episodeId: "masked",
      toolbox,
      mode: "chain",
      chain: {
        upstream: sandbox.rpcUrl,
        chainId: sandbox.chain.id,
        vault: vault.address,
        agent: account.address,
        clientVersion: "nitro/v3.12.1",
      },
    });
    cleanup.push(() => masked.close());
    expect((await rpc(masked, "web3_clientVersion")).result).toBe("nitro/v3.12.1");
    // The vault's on-chain name doesn't say "Arena" either.
    const name = await sandbox.publicClient.readContract({
      address: vault.address,
      abi: mandateVaultAbi,
      functionName: "name",
    });
    expect(name).not.toMatch(/arena/i);
  });

  it("lets calls, estimates and simulations run with overrides, without changing the fork", async () => {
    const { episode, vault, account } = await chainEpisode();
    const operator = sandbox.address("operator");
    const read = sandbox.publicClient;
    const before = {
      // Uncached: viem reuses a block number read in the last polling interval, which can be from
      // before the vault's setup transactions were mined.
      block: await read.getBlockNumber({ cacheTime: 0 }),
      balance: await read.getBalance({ address: operator }),
      code: await read.getCode({ address: vault.address }),
      nonce: await read.getTransactionCount({ address: account.address }),
    };
    const breachCount = encodeFunctionData({ abi: mandateVaultAbi, functionName: "breachCount" });
    const freeze = encodeFunctionData({ abi: mandateVaultAbi, functionName: "freeze" });
    const overrides = { [operator]: { balance: "0x1" }, [vault.address]: { code: "0x00" } };

    const call = await rpc(episode, "eth_call", [
      { to: vault.address, data: breachCount },
      "latest",
      overrides,
    ]);
    expect(call.error, JSON.stringify(call)).toBeUndefined();
    const plainCall = await rpc(episode, "eth_call", [
      { to: vault.address, data: breachCount },
      "latest",
    ]);
    const estimate = await rpc(episode, "eth_estimateGas", [
      { from: operator, to: vault.address, data: freeze },
    ]);
    expect(estimate.result).toMatch(/^0x/);
    // The operator may freeze its vault: simulated, it happens; on the fork, it doesn't.
    const simulated = (await rpc(episode, "eth_simulateV1", [
      {
        blockStateCalls: [
          {
            stateOverrides: { [operator]: { balance: "0xde0b6b3a7640000" } },
            calls: [
              { from: operator, to: vault.address, data: freeze },
              { to: vault.address, data: breachCount },
            ],
          },
        ],
      },
      "latest",
    ])) as { result?: { calls: { status: string; returnData: string }[] }[] };
    expect(simulated.result?.[0]?.calls.map((c) => c.status)).toEqual(["0x1", "0x1"]);
    // A simulation shows nothing a plain call can't: the same state, read the same way.
    expect(simulated.result?.[0]?.calls[1]?.returnData).toBe(plainCall.result);

    // Nothing these calls did reached the chain: any block mined since (there should be none)
    // holds no transaction from the operator or the agent key, or to the vault.
    const now = await read.getBlockNumber({ cacheTime: 0 });
    for (let n = before.block + 1n; n <= now; n++) {
      const block = await read.getBlock({ blockNumber: n, includeTransactions: true });
      for (const tx of block.transactions) {
        expect([operator, account.address].map((x) => x.toLowerCase())).not.toContain(
          tx.from.toLowerCase(),
        );
        expect(tx.to?.toLowerCase()).not.toBe(vault.address.toLowerCase());
      }
    }
    expect(await read.getBalance({ address: operator })).toBe(before.balance);
    expect(await read.getCode({ address: vault.address })).toBe(before.code);
    expect(await read.getTransactionCount({ address: account.address })).toBe(before.nonce);
    expect(
      await read.readContract({
        address: vault.address,
        abi: mandateVaultAbi,
        functionName: "frozen",
      }),
    ).toBe(false);
  });

  it("can't be made to amplify: answers, requests, gas and simulations are capped", async () => {
    // The review's proof of concept: a batch of calls to code (set by a state override) that
    // returns megabytes of memory made an 11 KB request return 387 MB.
    const roomy = new ArenaGateway({ tokens, limits: { rpcBatch: 50 } });
    await roomy.listen();
    cleanup.push(() => roomy.close());
    const { vault, toolbox, account } = await chainEpisode();
    const episode = roomy.openEpisode({
      episodeId: "amplify",
      toolbox,
      mode: "chain",
      chain: {
        upstream: sandbox.rpcUrl,
        chainId: sandbox.chain.id,
        vault: vault.address,
        agent: account.address,
      },
    });
    const target = "0x00000000000000000000000000000000000b0b00";
    const returning = (bytes: number) => `0x62${bytes.toString(16).padStart(6, "0")}6000f3`; // PUSH3 bytes PUSH1 0 RETURN
    const call = (id: number, bytes: number, gas?: string) => ({
      jsonrpc: "2.0",
      id,
      method: "eth_call",
      params: [
        { to: target, data: "0x", ...(gas ? { gas } : {}) },
        "latest",
        { [target]: { code: returning(bytes) } },
      ],
    });
    const fetchBytes = async (body: unknown) => {
      const response = await fetch(episode.endpoints.rpc!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return { bytes: text.length, json: JSON.parse(text) as { error?: { code: number } }[] };
    };
    // 3.9 MB of memory needs ~29M gas: asking for 30M gets 10M, and the call runs out.
    const big = await fetchBytes(
      Array.from({ length: 50 }, (_, i) => call(i, 0x3b0000, "0x1c9c380")),
    );
    expect(big.bytes).toBeLessThan(64 * 1024);
    // 2 MB fits in 10M gas, but no single answer may pass 1 MiB, and once one is refused for its
    // size the rest of the request's budget is gone too.
    const wide = await fetchBytes(
      Array.from({ length: 50 }, (_, i) => call(i, 0x200000, "0x989680")),
    );
    expect(wide.bytes).toBeLessThan(64 * 1024);
    expect(wide.json.every((r) => r.error?.code === -32005)).toBe(true);
    // Answers under the cap add up to at most the request's budget (2 MiB).
    const many = await fetchBytes(Array.from({ length: 50 }, (_, i) => call(i, 0x80000)));
    expect(many.bytes).toBeLessThan(2.2 * 1024 * 1024);
    expect(many.json.filter((r) => r.error?.code === -32005).length).toBeGreaterThan(40);
    // Simulations are bounded too: a few blocks and calls.
    const sim = (await (
      await post(episode.endpoints.rpc!, {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_simulateV1",
        params: [{ blockStateCalls: Array.from({ length: 5 }, () => ({ calls: [] })) }, "latest"],
      })
    ).json()) as { error?: { message: string } };
    expect(sim.error?.message).toMatch(/at most 4 blocks/);
  });

  it("budgets the calls one episode may make to the node", async () => {
    const strict = new ArenaGateway({
      tokens,
      limits: { rpcCallsPerEpisode: 8, rpcCallsPerSecond: 1, rpcCallBurst: 5 },
    });
    await strict.listen();
    cleanup.push(() => strict.close());
    const { vault, toolbox, account } = await chainEpisode();
    const episode = strict.openEpisode({
      episodeId: "budget",
      toolbox,
      mode: "chain",
      chain: {
        upstream: sandbox.rpcUrl,
        chainId: sandbox.chain.id,
        vault: vault.address,
        agent: account.address,
      },
    });
    const codes: (number | "ok")[] = [];
    for (let i = 0; i < 7; i++)
      codes.push((await rpc(episode, "eth_blockNumber")).error?.code ?? "ok");
    // A burst of five, then the rate holds it back.
    expect(codes).toEqual(["ok", "ok", "ok", "ok", "ok", -32005, -32005]);
  });

  it("charges a simulation per call it simulates, and every call for the gas it may use", async () => {
    const strict = new ArenaGateway({
      tokens,
      limits: {
        rpcCallsPerEpisode: 10,
        rpcCallBurst: 10,
        rpcGasPerSecond: 1,
        rpcGasBurst: 40_000_000,
      },
    });
    await strict.listen();
    cleanup.push(() => strict.close());
    const { vault, toolbox, account } = await chainEpisode();
    const episode = strict.openEpisode({
      episodeId: "charged",
      toolbox,
      mode: "chain",
      chain: {
        upstream: sandbox.rpcUrl,
        chainId: sandbox.chain.id,
        vault: vault.address,
        agent: account.address,
      },
    });
    const breachCount = encodeFunctionData({ abi: mandateVaultAbi, functionName: "breachCount" });
    const simulate = (calls: number) =>
      rpc(episode, "eth_simulateV1", [
        {
          blockStateCalls: [
            {
              calls: Array.from({ length: calls }, () => ({
                to: vault.address,
                data: breachCount,
                gas: "0x100000",
              })),
            },
          ],
        },
        "latest",
      ]);
    // Eight simulated calls are eight of the ten calls.
    expect((await simulate(8)).error).toBeUndefined();
    expect((await simulate(8)).error?.code).toBe(-32005);

    const gassy = strict.openEpisode({
      episodeId: "gassy",
      toolbox,
      mode: "chain",
      chain: {
        upstream: sandbox.rpcUrl,
        chainId: sandbox.chain.id,
        vault: vault.address,
        agent: account.address,
      },
    });
    // Calls with no gas named get 5M each: the 40M burst covers eight, then the gas runs out.
    const results = [];
    for (let i = 0; i < 9; i++)
      results.push(
        (await rpc(gassy, "eth_call", [{ to: vault.address, data: breachCount }, "latest"])).error
          ?.message ?? "ok",
      );
    expect(results.slice(0, 8).every((r) => r === "ok")).toBe(true);
    expect(results[8]).toMatch(/too much gas/);
  });

  it("checks every request in a batch, in order, and caps the batch size", async () => {
    const { episode } = await chainEpisode();
    const batch = (await (
      await post(episode.endpoints.rpc!, [
        { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
        { jsonrpc: "2.0", id: 2, method: "evm_mine" },
        { jsonrpc: "2.0", id: 3, method: "net_version" },
        { nonsense: true },
      ])
    ).json()) as { id: number; result?: unknown; error?: { code: number } }[];
    expect(batch.map((r) => [r.id, r.error?.code ?? "ok"])).toEqual([
      [1, "ok"],
      [2, -32601],
      [3, "ok"],
      [null, -32600],
    ]);
    const tooMany = Array.from({ length: 6 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "eth_chainId",
    }));
    expect(await (await post(episode.endpoints.rpc!, tooMany)).json()).toMatchObject({
      error: { code: -32600 },
    });
  });

  it("accepts only the agent key's execute() calls to its own vault", async () => {
    const { episode, vault, key, toolbox } = await chainEpisode(2);
    const usdg = marketTokens(sandbox)[0]!.address;
    const transfer = encodeFunctionData({
      abi: testTokenAbi,
      functionName: "transfer",
      args: [sandbox.address("depositor"), parseUnits("1", 6)],
    });
    const execute = encodeFunctionData({
      abi: mandateVaultAbi,
      functionName: "execute",
      args: [usdg, transfer],
    });
    const sign = async (
      signerKey: `0x${string}`,
      tx: { to: `0x${string}`; data?: `0x${string}`; value?: bigint; chainId?: number },
    ) => {
      const signer = privateKeyToAccount(signerKey);
      return signer.signTransaction({
        chainId: sandbox.chain.id,
        nonce: await sandbox.publicClient.getTransactionCount({ address: signer.address }),
        gas: 500_000n,
        maxFeePerGas: 10n ** 10n,
        maxPriorityFeePerGas: 1n,
        type: "eip1559",
        ...tx,
      });
    };
    const send = async (raw: `0x${string}`) => rpc(episode, "eth_sendRawTransaction", [raw]);
    const refusals: [string, Promise<`0x${string}`>][] = [
      // The anvil development keys are public: none of them may act through the gateway.
      [
        "signed by this episode's agent key",
        sign(ANVIL_KEYS.operator, { to: vault.address, data: execute }),
      ],
      [
        "signed by this episode's agent key",
        sign(ANVIL_KEYS.agent, { to: vault.address, data: execute }),
      ],
      ["only call this episode's vault", sign(key, { to: usdg, data: transfer })],
      ["only call this episode's vault", sign(key, { to: sandbox.address("operator") })],
      ["takes no ETH", sign(key, { to: vault.address, data: execute, value: parseEther("0.1") })],
      [
        "only the vault's execute",
        sign(key, {
          to: vault.address,
          data: encodeFunctionData({ abi: mandateVaultAbi, functionName: "unfreeze" }),
        }),
      ],
      ["signed for chain", sign(key, { to: vault.address, data: execute, chainId: 1 })],
    ];
    for (const [reason, raw] of refusals) {
      const response = await send(await raw);
      expect(response.error?.message, reason).toContain(reason);
    }
    expect((await send("0xdeadbeef")).error?.message).toBe("not a valid signed transaction");
    expect(toolbox.trace).toEqual([]);

    // The agent's own execute() goes through, as a step, and its result is the chain's hash.
    const ok = await send(await sign(key, { to: vault.address, data: execute }));
    expect(ok.result).toMatch(/^0x[0-9a-f]{64}$/);
    expect(toolbox.trace).toHaveLength(1);
    expect(toolbox.trace[0]).toMatchObject({
      tool: "execute",
      args: { target: usdg, data: transfer },
      txHashes: [ok.result],
      result: { ok: true },
    });
    // The step cap holds: the third step is refused and never sent.
    await post(`${episode.endpoints.tools}/get_prices`, {});
    const nonce = await sandbox.publicClient.getTransactionCount({
      address: privateKeyToAccount(key).address,
    });
    const capped = await send(await sign(key, { to: vault.address, data: execute }));
    expect(capped.error?.message).toBe("step limit of 2 reached");
    expect(
      await sandbox.publicClient.getTransactionCount({ address: privateKeyToAccount(key).address }),
    ).toBe(nonce);
  });
});

describe("the runner socket", () => {
  const connect = (headers: Record<string, string>, path = "/runner/connect") =>
    new Promise<number | "open">((resolve) => {
      const socket = new WebSocket(`${url.replace(/^http/, "ws")}${path}`, { headers });
      socket.once("open", () => {
        socket.close();
        resolve("open");
      });
      socket.once("unexpected-response", (_, res) => resolve(res.statusCode ?? 0));
      socket.once("error", () => {});
    });

  it("refuses a missing or wrong token and other paths", async () => {
    expect(await connect({})).toBe(401);
    expect(await connect({ authorization: "Bearer not-a-real-token-at-all" })).toBe(401);
    expect(await connect({ authorization: "Bearer bonded_rt_well-formed-but-unknown" })).toBe(401);
    expect(await connect({ authorization: RUNNER_TOKEN })).toBe(401);
    expect(await connect({ authorization: `Bearer ${RUNNER_TOKEN}` }, "/other")).toBe(404);
    expect(await connect({ authorization: `Bearer ${RUNNER_TOKEN}` })).toBe("open");
  });

  const closeCode = (socket: WebSocket) =>
    new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

  async function rawRunner(token = RUNNER_TOKEN) {
    const socket = new WebSocket(`${url.replace(/^http/, "ws")}/runner/connect`, {
      headers: { authorization: `Bearer ${token}` },
    });
    await new Promise((resolve) => socket.once("open", resolve));
    return socket;
  }
  const hello = (mode = "tools", protocol = RUNNER_PROTOCOL_VERSION) =>
    JSON.stringify({ type: "hello", runnerVersion: "test", protocol, mode });

  it("closes on a malformed message, a missing hello or an unknown protocol", async () => {
    const malformed = await rawRunner();
    const code1 = closeCode(malformed);
    malformed.send("{not json");
    expect(await code1).toBe(RUNNER_CLOSE.protocol);

    const noHello = await rawRunner();
    const code2 = closeCode(noHello);
    noHello.send(JSON.stringify({ type: "ping" }));
    expect(await code2).toBe(RUNNER_CLOSE.protocol);

    const future = await rawRunner();
    const code3 = closeCode(future);
    future.send(hello("tools", RUNNER_PROTOCOL_VERSION + 1));
    expect(await code3).toBe(RUNNER_CLOSE.protocol);
  });

  it("reports presence, answers pings, and lets a newer runner replace an older one", async () => {
    presence.length = 0;
    const first = await rawRunner();
    first.send(hello());
    await eventually(() => gateway.runner("agent-1") !== undefined);
    expect(presence.map((p) => [p.type, p.key])).toEqual([["connected", "agent-1"]]);
    const pong = new Promise<string>((resolve) => first.once("message", (d) => resolve(String(d))));
    first.send(JSON.stringify({ type: "ping", at: 1 }));
    expect(JSON.parse(await pong)).toMatchObject({ type: "pong" });
    await eventually(() => presence.some((p) => p.type === "heartbeat"));

    const replaced = closeCode(first);
    const second = await rawRunner();
    second.send(hello("chain"));
    expect(await replaced).toBe(RUNNER_CLOSE.replaced);
    await eventually(() => gateway.runner("agent-1")?.hello?.mode === "chain");
    second.close();
    await eventually(() => gateway.runner("agent-1") === undefined);
    expect(presence.at(-1)).toMatchObject({ type: "disconnected", key: "agent-1" });
  });

  it("disconnects a revoked runner within one heartbeat, even one that never pings", async () => {
    const token = "bonded_rt_a-token-that-will-be-revoked";
    tokens.add(token, "agent-3");
    const socket = await rawRunner(token);
    socket.send(hello());
    await eventually(() => gateway.runner("agent-3") !== undefined);
    tokens.revoke(token);
    const code = closeCode(socket);
    const revokedAt = Date.now();
    // Other messages don't count as liveness, and don't delay the check.
    const chatter = setInterval(
      () => socket.send(JSON.stringify({ type: "episode_started", episodeId: "nothing" })),
      100,
    );
    expect(await code).toBe(RUNNER_CLOSE.revoked);
    clearInterval(chatter);
    expect(Date.now() - revokedAt).toBeLessThan(2_500);
    expect(gateway.runner("agent-3")).toBeUndefined();
  });

  it("drops a runner that sends anything but pings, after three heartbeats", async () => {
    const socket = await rawRunner();
    socket.send(hello());
    await eventually(() => gateway.runner("agent-1") !== undefined);
    const chatter = setInterval(
      () => socket.send(JSON.stringify({ type: "episode_started", episodeId: "nothing" })),
      200,
    );
    expect(await closeCode(socket)).toBe(RUNNER_CLOSE.heartbeat);
    clearInterval(chatter);
  });

  it("closes a socket that floods, with token checks and presence reports bounded", async () => {
    presence.length = 0;
    const socket = await rawRunner();
    socket.send(hello());
    await eventually(() => gateway.runner("agent-1") !== undefined);
    const checksBefore = tokens.checks;
    const code = closeCode(socket);
    for (let i = 0; i < 20_000 && socket.readyState === WebSocket.OPEN; i++)
      socket.send('{"type":"ping"}');
    expect(await code).toBe(RUNNER_CLOSE.rateLimited);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    // At most one check per heartbeat interval, not one per ping.
    expect(tokens.checks - checksBefore).toBeLessThanOrEqual(2);
    expect(presence.filter((p) => p.type === "heartbeat").length).toBeLessThanOrEqual(1);
  });

  /** One upgrade attempt: the HTTP status it was refused with, or "open". */
  const attempt = (target: string, token: string, headers: Record<string, string> = {}) =>
    new Promise<number | "open">((resolve) => {
      const socket = new WebSocket(`${target.replace(/^http/, "ws")}/runner/connect`, {
        headers: { authorization: `Bearer ${token}`, ...headers },
      });
      socket.once("open", () => {
        socket.close();
        resolve("open");
      });
      socket.once("unexpected-response", (_, res) => resolve(res.statusCode ?? 0));
      socket.once("error", () => {});
    });
  const guess = (n: number) => `bonded_rt_guessing-a-token-${String(n).padStart(6, "0")}`;

  it("never checks a malformed token, and can't be starved by them", async () => {
    // The review's finding: behind a proxy every client shares one address, so ~30 anonymous
    // requests a minute locked every runner out.
    const strict = new ArenaGateway({ tokens, limits: { malformedUpgradesPerMinute: 3 } });
    const strictUrl = await strict.listen();
    cleanup.push(() => strict.close());
    const checksBefore = tokens.checks;
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push(await attempt(strictUrl, "not-a-runner-token"));
    expect(codes).toEqual([401, 401, 401, 429, 429, 429]);
    expect(tokens.checks).toBe(checksBefore);
    expect(await attempt(strictUrl, RUNNER_TOKEN)).toBe("open");
  });

  it("refuses an address after too many failed checks, keyed on the trusted proxy's client address", async () => {
    const proxied = new ArenaGateway({ tokens, trustProxy: 1, limits: { upgradesPerMinute: 2 } });
    const proxiedUrl = await proxied.listen();
    cleanup.push(() => proxied.close());
    const from = (ip: string, prefix = "") => ({ "x-forwarded-for": `${prefix}${ip}` });
    const checksBefore = tokens.checks;
    expect(await attempt(proxiedUrl, guess(1), from("203.0.113.7"))).toBe(401);
    expect(await attempt(proxiedUrl, guess(2), from("203.0.113.7"))).toBe(401);
    expect(await attempt(proxiedUrl, guess(3), from("203.0.113.7"))).toBe(429);
    // A forged entry before the proxy's own doesn't change the address counted.
    expect(await attempt(proxiedUrl, guess(4), from("203.0.113.7", "198.51.100.1, "))).toBe(429);
    expect(tokens.checks - checksBefore).toBe(2);
    // Another client behind the same proxy is unaffected.
    expect(await attempt(proxiedUrl, RUNNER_TOKEN, from("198.51.100.20"))).toBe("open");
  });

  it("counts an IPv6 client by its /64", () => {
    expect(addressGroup("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(addressGroup("2001:db8:1:2::abcd")).toBe("2001:db8:1:2::/64");
    expect(addressGroup("2001:0db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressGroup("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressGroup("203.0.113.9")).toBe("203.0.113.9");
  });

  it("refuses a rotating IPv6 block and a global wave of failures, but not a known runner", async () => {
    const strict = new ArenaGateway({
      tokens,
      trustProxy: 1,
      limits: { upgradesPerMinute: 2, failedChecksPerMinute: 4 },
    });
    const strictUrl = await strict.listen();
    cleanup.push(() => strict.close());
    const from = (ip: string) => ({ "x-forwarded-for": ip });
    // A runner that has connected before.
    expect(await attempt(strictUrl, RUNNER_TOKEN, from("198.51.100.30"))).toBe("open");
    // Fresh addresses in one /64 count as one client.
    expect(await attempt(strictUrl, guess(10), from("2001:db8:7:7::1"))).toBe(401);
    expect(await attempt(strictUrl, guess(11), from("2001:db8:7:7::2"))).toBe(401);
    expect(await attempt(strictUrl, guess(12), from("2001:db8:7:7::3"))).toBe(429);
    // Failures spread over many addresses still hit the global cap ...
    expect(await attempt(strictUrl, guess(13), from("203.0.113.40"))).toBe(401);
    expect(await attempt(strictUrl, guess(14), from("203.0.113.41"))).toBe(401);
    expect(await attempt(strictUrl, guess(15), from("203.0.113.42"))).toBe(429);
    // ... but a token that has passed a check keeps its own budget, from anywhere.
    expect(await attempt(strictUrl, RUNNER_TOKEN, from("192.0.2.200"))).toBe("open");
  });

  it("gives each token its own reconnect budget", async () => {
    const strict = new ArenaGateway({ tokens, limits: { upgradesPerToken: 2 } });
    const strictUrl = await strict.listen();
    cleanup.push(() => strict.close());
    expect(await attempt(strictUrl, RUNNER_TOKEN)).toBe("open");
    expect(await attempt(strictUrl, RUNNER_TOKEN)).toBe("open");
    expect(await attempt(strictUrl, RUNNER_TOKEN)).toBe(429);
    expect(await attempt(strictUrl, OTHER_TOKEN)).toBe("open");
  });
});

describe("RemoteAgent", () => {
  const spec = () => loadAttackLibrary().find((s) => s.id === "A6-operator-impersonation-001")!;

  async function runner(options: Parameters<typeof fakeRunner>[0]): Promise<FakeRunner> {
    const r = await fakeRunner({ pingMs: 250, ...options });
    cleanup.push(() => r.close());
    await eventually(
      () =>
        gateway.runner(options.token === RUNNER_TOKEN ? "agent-1" : "agent-2")?.connected === true,
    );
    return r;
  }

  it("runs an episode through the runner and judges it from the vault", async () => {
    const fake = await runner({
      gateway: url,
      token: RUNNER_TOKEN,
      mode: "tools",
      agent: new ScriptedVulnerableAgent(),
      transport: "mcp",
    });
    const agent = new RemoteAgent({ gateway, sandbox, runner: "agent-1", mode: "tools" });
    const result = await runEpisode(sandbox, { agent, attack: spec() });
    expect(result.verdict.breached).toBe(true);
    expect(result.agentSummary).toMatchObject({ stoppedBecause: "done" });
    expect(result.agentSummary.steps).toBe(result.trace.length);
    const episode = fake.received[0]!;
    // The agent is never told which attack it faces, or anything else about it.
    // (Not a bare "A6": a random address or id can contain that.)
    expect(JSON.stringify(episode)).not.toContain(spec().id);
    expect(JSON.stringify(episode)).not.toMatch(/"A6"|attack|impersonation/i);
    expect(JSON.stringify(episode)).not.toContain(result.planted[0]!.text.slice(0, 20));
    expect(episode).not.toHaveProperty("sessionKey");
    expect((result.agentSummary as RemoteRunSummary).remote.reads).toMatchObject({
      dm: 1,
    });
    // The episode's capability died with it.
    expect((await post(`${episode.endpoints.tools}/get_prices`, {})).status).toBe(404);
  });

  it("gives a chain-mode episode a fresh session key the vault names as its agent", async () => {
    const fake = await runner({
      gateway: url,
      token: OTHER_TOKEN,
      mode: "chain",
      agent: new ScriptedVulnerableAgent(),
      transport: "chain",
    });
    const agent = new RemoteAgent({ gateway, sandbox, runner: "agent-2", mode: "chain" });
    const first = await runEpisode(sandbox, { agent, attack: spec() });
    const second = await runEpisode(sandbox, { agent, attack: null });
    const [a, b] = fake.received;
    expect(a?.sessionKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a?.sessionKey).not.toBe(b?.sessionKey);
    const vaultAgent = await sandbox.publicClient.readContract({
      address: first.vault,
      abi: mandateVaultAbi,
      functionName: "agent",
    });
    expect(vaultAgent).toBe(privateKeyToAccount(a!.sessionKey!).address);
    expect(first.verdict.breached).toBe(true);
    expect(first.trace.some((s) => s.tool === "execute")).toBe(true);
    expect(second.verdict.breached).toBe(false);
    expect(second.trace.filter((s) => s.tool === "execute").every((s) => s.result.ok)).toBe(true);
  });

  it("cancels an agent that runs out of time and records no verdict", async () => {
    const fake = await runner({
      gateway: url,
      token: RUNNER_TOKEN,
      mode: "tools",
      onEpisode: () => {},
    });
    const agent = new RemoteAgent({
      gateway,
      sandbox,
      runner: "agent-1",
      mode: "tools",
      episodeTimeoutMs: 500,
    });
    const result = await runEpisode(sandbox, { agent, attack: null });
    expect(result.agentSummary).toMatchObject({
      stoppedBecause: "error",
      finalMessage: "timed out after 500 ms",
    });
    expect(fake.cancels).toEqual([fake.received[0]!.episodeId]);
    expect((result.agentSummary as RemoteRunSummary).remote.signal).toBe("SIGTERM");
  });

  it("fails fast when no runner is connected, or the runner is in the other mode", async () => {
    const none = new RemoteAgent({
      gateway,
      sandbox,
      runner: "nobody",
      mode: "tools",
      runnerWaitMs: 200,
    });
    const missing = await runEpisode(sandbox, { agent: none, attack: null });
    expect(missing.agentSummary.finalMessage).toBe("no runner is connected for this agent");

    await runner({ gateway: url, token: RUNNER_TOKEN, mode: "tools", onEpisode: () => {} });
    const wrong = new RemoteAgent({ gateway, sandbox, runner: "agent-1", mode: "chain" });
    const mismatch = await runEpisode(sandbox, { agent: wrong, attack: null });
    expect(mismatch.agentSummary.finalMessage).toBe(
      "the runner is in tools mode, but this rating is chain",
    );
    // Nothing was sent, so the runner is free for the next episode at once.
    expect(gateway.runner("agent-1")?.episodeId).toBeNull();
  });

  it("never sends a vault episode to a runner started for the brokerage world", async () => {
    const fake = await runner({
      gateway: url,
      token: RUNNER_TOKEN,
      mode: "tools",
      world: "brokerage",
      onEpisode: () => {},
    });
    const agent = new RemoteAgent({ gateway, sandbox, runner: "agent-1", mode: "tools" });
    const result = await runEpisode(sandbox, { agent, attack: null });
    expect(result.agentSummary).toMatchObject({
      stoppedBecause: "error",
      finalMessage:
        "this runner was started for the brokerage world: start one without --world for the vault world",
    });
    expect(fake.received).toEqual([]);
    expect(gateway.runner("agent-1")?.episodeId).toBeNull();
  });

  it("serves a TEE-bound episode only after its evidence is accepted", async () => {
    const seen: unknown[] = [];
    const fake = await runner({
      gateway: url,
      token: RUNNER_TOKEN,
      mode: "tools",
      onEpisode: async (episode, r) => {
        const before = await post(`${episode.endpoints.tools}/get_prices`, {});
        seen.push(before.status);
        r.send({
          type: "tee_evidence",
          episodeId: episode.episodeId,
          evidence: { quote: "0x01", nonce: episode.nonce },
        });
        const after = await post(`${episode.endpoints.tools}/get_prices`, {});
        seen.push(after.status);
        await post(episode.endpoints.done, {});
      },
    });
    const evidence: { nonce: string; evidence: unknown }[] = [];
    const agent = new RemoteAgent({
      gateway,
      sandbox,
      runner: "agent-1",
      mode: "tools",
      tee: {
        keyId: `0x${"ab".repeat(32)}`,
        onEvidence: (e, context) => {
          evidence.push({ nonce: context.nonce, evidence: e });
          if ((e as { nonce?: string }).nonce !== context.nonce) throw new Error("stale nonce");
        },
      },
    });
    const ok = await runEpisode(sandbox, { agent, attack: null });
    expect(ok.agentSummary.stoppedBecause).toBe("done");
    // The first request waited for the gate (the test gateway's 300 ms), the second was served.
    expect(seen).toEqual([503, 200]);
    expect(evidence[0]?.nonce).toBe(fake.received[0]?.nonce);
    // The runner is told which Arena key to have the TEE attest.
    expect(fake.received[0]?.teeKeyId).toBe(`0x${"ab".repeat(32)}`);
    expect((ok.agentSummary as RemoteRunSummary).remote.teeEvidence).toEqual(evidence[0]?.evidence);

    const refusing = new RemoteAgent({
      gateway,
      sandbox,
      runner: "agent-1",
      mode: "tools",
      tee: {
        onEvidence: () => {
          throw new Error("unknown measurement");
        },
      },
    });
    const refused = await runEpisode(sandbox, { agent: refusing, attack: null });
    expect(refused.agentSummary).toMatchObject({
      stoppedBecause: "error",
      finalMessage: "TEE evidence refused: unknown measurement",
    });
  });
});
