import {
  type AgentMode,
  agentUrlSigner,
  type EpisodeWorld,
  isAgentUrlOwner,
  isWellFormedRunnerToken,
  newAgentUrlSigningKey,
} from "@bondedhq/shared";
import { positiveInt } from "./flags.js";
import {
  ArenaGateway,
  BROKERAGE_RUNNER_NEEDED,
  newRunnerToken,
  RemoteAgent,
  StaticRunnerTokens,
} from "./gateway/index.js";
import type { Sandbox } from "./sandbox.js";

/**
 * Local runs of a remote agent (bring your own agent): a gateway on this machine, and the agent
 * reached through its runner or its own URL. Used by `arena run|rate|check --agent remote` (the
 * vault world) and `broker --agent remote [--agent-url <url>]` (the brokerage world).
 */

/**
 * Starts a local Arena Gateway for a remote agent, prints the runner command, and waits for the
 * runner to connect. The token is held in memory only; it works for this run alone.
 */
export async function startRemote(
  sandbox: Sandbox | undefined,
  values: {
    "runner-token"?: string;
    "agent-url"?: string;
    "agent-owner"?: string;
    "gateway-port"?: string;
    "gateway-host"?: string;
    "public-url"?: string;
    "runner-wait"?: string;
    name?: string;
  },
  mode: AgentMode,
  episodeTimeoutMs: number,
  options: { verify: boolean; world?: EpisodeWorld },
): Promise<{
  gateway: ArenaGateway;
  agent: RemoteAgent;
  code?: { hash: `0x${string}`; source: string };
}> {
  if (values["agent-url"]) return startAgentUrl(sandbox, values, mode, episodeTimeoutMs, options);
  const world = options.world ?? "vault";
  const given = values["runner-token"];
  const token = given ?? newRunnerToken();
  if (!isWellFormedRunnerToken(token))
    throw new Error(
      "--runner-token must be bonded_rt_ followed by at least 16 base64url characters",
    );
  // Every flag is checked before the gateway takes its port, so a typo leaves nothing listening.
  const port = positiveInt(values["gateway-port"], "--gateway-port");
  const waitMs = positiveInt(values["runner-wait"], "--runner-wait") * 1000;
  const gateway = new ArenaGateway({
    tokens: new StaticRunnerTokens({ [token]: "local" }),
    ...(values["public-url"] ? { publicUrl: values["public-url"] } : {}),
    onRunnerPresence: (e) => {
      if (e.type === "connected") console.log(`Runner connected (${e.hello?.mode} mode)`);
      if (e.type === "disconnected") console.log(`Runner disconnected (${e.reason})`);
    },
  });
  const url = await gateway.listen({ port, host: values["gateway-host"] ?? "127.0.0.1" });
  try {
    console.log(`\nArena Gateway listening at ${url}`);
    const tokenShown = given ? "<your token>" : token;
    const flags = `--gateway ${url} --mode ${mode}${world === "vault" ? "" : ` --world ${world}`}`;
    const fromRepository = `  BONDED_RUNNER_TOKEN=${tokenShown} node apps/runner/dist/cli.js ${flags} -- <your agent command>\n`;
    // The published runner takes every world since 0.1.4 (protocol 2 for the brokerage world).
    console.log("Start your agent's runner in another terminal:\n");
    console.log(
      `  BONDED_RUNNER_TOKEN=${tokenShown} npx @bondedhq/runner ${flags} -- <your agent command>\n`,
    );
    console.log("or, from this repository:\n");
    console.log(fromRepository);
    const deadline = Date.now() + waitMs;
    console.log(`Waiting up to ${waitMs / 1000} s for the runner...`);
    while (!gateway.runner("local")) {
      if (Date.now() > deadline) throw new Error("no runner connected in time");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const runner = gateway.runner("local");
    const runnerMode = runner?.hello?.mode;
    if (runnerMode !== mode)
      throw new Error(`the runner is in ${runnerMode} mode, but --mode is ${mode}`);
    if (world === "brokerage" && !runner?.canRunBrokerage) throw new Error(BROKERAGE_RUNNER_NEEDED);
    if (world === "vault" && runner?.world !== "vault")
      throw new Error(
        `the runner was started for the ${runner?.world} world: start it without --world`,
      );
    const agent = new RemoteAgent({
      gateway,
      ...(sandbox ? { sandbox } : {}),
      world,
      runner: "local",
      mode,
      name: values.name ?? "remote/local",
      episodeTimeoutMs,
    });
    const code = runner?.code;
    return { gateway, agent, ...(code ? { code } : {}) };
  } catch (error) {
    await gateway.close();
    throw error;
  }
}

/**
 * Agent URL mode for a local run: a gateway whose episodes are POSTed to the agent's URL (http to
 * this machine allowed, since it's local). Calls are signed for --agent-owner with a key made for
 * this run (or AGENT_URL_SIGNING_KEY), published by this gateway for the agent to check them.
 */
async function startAgentUrl(
  sandbox: Sandbox | undefined,
  values: {
    "agent-url"?: string;
    "agent-owner"?: string;
    "gateway-port"?: string;
    "gateway-host"?: string;
    "public-url"?: string;
    name?: string;
  },
  mode: AgentMode,
  episodeTimeoutMs: number,
  options: { verify: boolean; world?: EpisodeWorld },
): Promise<{
  gateway: ArenaGateway;
  agent: RemoteAgent;
  code?: { hash: `0x${string}`; source: string };
}> {
  const url = values["agent-url"]!;
  const owner = (values["agent-owner"] ?? process.env.BONDED_AGENT_OWNER ?? "").toLowerCase();
  if (!isAgentUrlOwner(owner))
    throw new Error(
      "--agent-owner (or BONDED_AGENT_OWNER) must be the wallet in your handler's owner (0x…)",
    );
  const signer = await agentUrlSigner(
    process.env.AGENT_URL_SIGNING_KEY || (await newAgentUrlSigningKey()),
  );
  const port = positiveInt(values["gateway-port"], "--gateway-port");
  const gateway = new ArenaGateway({
    tokens: new StaticRunnerTokens(),
    ...(values["public-url"] ? { publicUrl: values["public-url"] } : {}),
    agentUrl: { allowLoopback: true, signer },
  });
  const base = await gateway.listen({ port, host: values["gateway-host"] ?? "127.0.0.1" });
  try {
    console.log(`\nArena Gateway listening at ${base}`);
    const problem = gateway.agentUrls.urlProblem(url);
    if (problem) throw new Error(problem);
    if (!process.env.AGENT_URL_SIGNING_KEY) {
      console.log(
        "This gateway signs calls with a key made for this run. Point your handler at it so it\n" +
          "checks them with that key:\n",
      );
      console.log(`  createBondedHandler({ owner: "${owner}", apiUrl: "${base}", ... })\n`);
      console.log("Start your agent like that, then press Enter.");
      await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
      process.stdin.pause();
    }
    let code: { hash: `0x${string}`; source: string } | undefined;
    if (options.verify) {
      const verified = await gateway.agentUrls.verify(url, owner);
      if (!verified.ok) throw new Error(verified.problem);
      console.log(`Agent URL verified${verified.version ? ` (version ${verified.version})` : ""}`);
      if (verified.codeHash) code = { hash: verified.codeHash, source: "url" };
    }
    const agent = new RemoteAgent({
      gateway,
      ...(sandbox ? { sandbox } : {}),
      world: options.world ?? "vault",
      transport: { kind: "url", url, owner, registration: "local" },
      mode,
      name: values.name ?? "remote/url",
      episodeTimeoutMs,
    });
    return { gateway, agent, ...(code ? { code } : {}) };
  } catch (error) {
    await gateway.close();
    throw error;
  }
}
