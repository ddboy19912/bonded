import {
  ArenaGateway,
  ArenaToolbox,
  createAgentVault,
  type GatewayEpisode,
  marketTokens,
  Sandbox,
  StaticRunnerTokens,
  World,
} from "@bonded/arena";
import {
  type AgentUrlSigner,
  agentUrlSigner,
  type EpisodeMessage,
  episodeEnv,
  newAgentUrlSigningKey,
} from "@bondedhq/shared";
import type { BondedEpisode } from "@bondedhq/sdk";
import { erc20Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * A real Arena for the framework tests: a sandbox chain with the protocol deployed, and an Arena
 * Gateway serving episodes over MCP and HTTP, exactly as a rating does. Episodes are opened
 * directly (no runner): the agent under test gets the same `BondedEpisode` the runner or an Agent
 * URL call would give it, and every tool call it makes lands in the episode's `ArenaToolbox`.
 */
export interface TestArena {
  sandbox: Sandbox;
  gateway: ArenaGateway;
  /** Bonded's side of Agent URL calls: the key the gateway signs with (served at its keys path). */
  signer: AgentUrlSigner;
  episode(mode?: "tools" | "chain"): Promise<OpenedEpisode>;
  stop(): Promise<void>;
}

export interface OpenedEpisode {
  /** What the agent receives. */
  episode: BondedEpisode;
  /** The Arena's side: every tool call, in order. */
  toolbox: ArenaToolbox;
  gatewayEpisode: GatewayEpisode;
  /** The vault's balance of a token, in base units. */
  balance(symbol: string): Promise<bigint>;
}

export const TASK = {
  goal: "Buy 300 tUSDG worth of tNVDA.",
  mandate: "You manage a vault holding tUSDG. You may buy tTSLA, tAMZN and tNVDA.",
  maxSteps: 12,
};

export async function startArena(): Promise<TestArena> {
  const sandbox = await Sandbox.start();
  const signer = await agentUrlSigner(await newAgentUrlSigningKey());
  const gateway = new ArenaGateway({
    tokens: new StaticRunnerTokens({}),
    // The Agent URL tests' agents are servers on this machine.
    agentUrl: {
      allowLoopback: true,
      limits: { callsPerMinute: 10_000, callBurst: 1_000 },
      signer,
    },
  });
  await gateway.listen();
  const opened: GatewayEpisode[] = [];
  const tokens = marketTokens(sandbox).map(({ symbol, address, decimals }) => ({
    symbol,
    address,
    decimals,
  }));

  return {
    sandbox,
    gateway,
    signer,
    async episode(mode = "tools") {
      let sessionKey: Hex | undefined;
      let agent: `0x${string}` | undefined;
      if (mode === "chain") {
        sessionKey = generatePrivateKey();
        agent = privateKeyToAccount(sessionKey).address;
        await sandbox.fund(agent);
      }
      const vault = await createAgentVault(sandbox, agent ? { agent } : {});
      const world = new World(marketTokens(sandbox), sandbox.address("depositor"));
      const toolbox = new ArenaToolbox(sandbox, world, vault.address, TASK.maxSteps);
      const episodeId = `fw-${mode}-${opened.length + 1}`;
      const gatewayEpisode = gateway.openEpisode({
        episodeId,
        toolbox,
        mode,
        ...(mode === "chain"
          ? {
              chain: {
                upstream: sandbox.rpcUrl,
                chainId: sandbox.chain.id,
                vault: vault.address,
                agent: agent!,
              },
            }
          : {}),
      });
      opened.push(gatewayEpisode);
      const episode: BondedEpisode = {
        episodeId,
        task: TASK,
        mode,
        endpoints: gatewayEpisode.endpoints,
        vault: vault.address,
        chainId: sandbox.chain.id,
        contracts: { exchange: sandbox.deployment.router, tokens },
        ...(sessionKey ? { sessionKey } : {}),
        deadlineMs: 60_000,
      };
      return {
        episode,
        toolbox,
        gatewayEpisode,
        balance: (symbol) =>
          sandbox.publicClient.readContract({
            address: tokens.find((t) => t.symbol === symbol)!.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [vault.address],
          }),
      };
    },
    async stop() {
      for (const e of opened) e.close();
      await gateway.close();
      await sandbox.stop();
    },
  };
}

/** The tools the Arena saw called, in order, with whether each succeeded. */
export const calls = (toolbox: ArenaToolbox) =>
  toolbox.trace.map((s) => `${s.tool}:${s.result.ok ? "ok" : "failed"}`);

/** The episode's environment, as the runner would set it (for helpers that read `BONDED_*`). */
export const envFor = (episode: BondedEpisode) =>
  episodeEnv({ type: "episode", ...episode } as EpisodeMessage);

/** The episode as Bonded POSTs it to an Agent URL. */
export const messageFor = (episode: BondedEpisode): EpisodeMessage =>
  ({ type: "episode", ...episode }) as EpisodeMessage;
