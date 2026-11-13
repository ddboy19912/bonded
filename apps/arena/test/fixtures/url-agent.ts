import { createServer, type Server } from "node:http";
import {
  type AgentUrlMessage,
  AgentUrlReplayGuard,
  answerAgentUrlVerify,
  type ArenaAgent,
  type BrokerageEpisodeMessage,
  type DoneRequest,
  type EpisodeMessage,
  verifyAgentUrlRequest,
} from "@bondedhq/shared";
import { OWNER, TEST_KEYS } from "./agent-url-keys.js";
import { toolboxFor, type Transport } from "./gateway-client.js";

/**
 * A stand-in Agent URL for tests: an HTTP server on this machine that checks each call's
 * signature and owner with the shared helper, answers at once, and runs a brain in-process over the
 * episode's real endpoints, as an agent behind its own HTTPS endpoint would.
 */
export interface UrlAgentOptions {
  /** The wallet it belongs to (default OWNER): calls for anyone else are refused. */
  owner?: string;
  /** The brain the default episode handler runs. */
  agent?: ArenaAgent;
  transport?: Transport;
  /** Replaces the default episode handler (run after the 202 is sent). */
  onEpisode?: (episode: EpisodeMessage) => Promise<void> | void;
  /** Runs a brokerage episode (after the 202). Without it, brokerage episodes get 400. */
  onBrokerageEpisode?: (episode: BrokerageEpisodeMessage) => Promise<void> | void;
  /** Usage the default handler reports at /done. */
  usage?: DoneRequest["usage"];
  /** Answers verify with this version. */
  version?: string;
  /** Answer episodes with this status instead of 202 (and run nothing). */
  episodeStatus?: number;
  /** Wait this long before answering an episode (the work starts after the answer). */
  answerDelayMs?: number;
}

export interface UrlAgent {
  url: string;
  received: AgentUrlMessage[];
  cancels: string[];
  /** Calls refused for a bad signature or another owner. */
  refused: number;
  close(): Promise<void>;
}

export async function urlAgent(options: UrlAgentOptions): Promise<UrlAgent> {
  const replay = new AgentUrlReplayGuard();
  const state: UrlAgent = {
    url: "",
    received: [],
    cancels: [],
    refused: 0,
    close: async () => {},
  };
  const run =
    options.onEpisode ??
    (async (episode: EpisodeMessage) => {
      const tools = await toolboxFor(options.transport ?? "http", episode);
      try {
        const summary = await options.agent!.run(episode.task, tools);
        await fetch(episode.endpoints.done, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(summary.finalMessage ? { finalMessage: summary.finalMessage } : {}),
            ...(options.usage ? { usage: options.usage } : {}),
          }),
        });
      } finally {
        await tools.close();
      }
    });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      void verifyAgentUrlRequest({
        owner: options.owner ?? OWNER,
        keys: TEST_KEYS,
        body,
        headers: req.headers,
        replay,
      }).then((checked) => {
        if (!checked.ok) {
          state.refused++;
          res.writeHead(checked.status, { "content-type": "application/json" });
          // As createBondedHandler answers: the reason, and the code for "another wallet".
          res.end(
            JSON.stringify({
              error: checked.reason,
              ...(checked.code ? { code: checked.code } : {}),
            }),
          );
          return;
        }
        const message = checked.message;
        state.received.push(message);
        if (message.type === "verify") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(answerAgentUrlVerify(checked.owner, message, options.version)));
          return;
        }
        if (message.type === "cancel") {
          state.cancels.push(message.episodeId);
          res.writeHead(204).end();
          return;
        }
        if (message.world === "brokerage") {
          const onBrokerage = options.onBrokerageEpisode;
          if (!onBrokerage) {
            res.writeHead(400).end();
            return;
          }
          res.writeHead(202).end();
          void Promise.resolve(onBrokerage(message)).catch(() => {});
          return;
        }
        if (options.episodeStatus) {
          res.writeHead(options.episodeStatus).end();
          return;
        }
        setTimeout(() => {
          res.writeHead(202).end();
          void Promise.resolve(run(message)).catch(() => {});
        }, options.answerDelayMs ?? 0);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/bonded`;
  state.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}
