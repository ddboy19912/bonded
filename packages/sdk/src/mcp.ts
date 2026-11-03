import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DoneRequest } from "@bondedhq/shared";
import { BondedError } from "./errors.js";
import { finishEpisode } from "./done.js";
import { fromBondedEnv } from "./episode.js";
import { type GuardPaymentsOptions, guardPayments, isPaymentRefusal } from "./payments.js";

export { isBondedEpisode } from "./episode.js";
export { finishEpisode } from "./done.js";
export type { GuardPaymentsOptions } from "./payments.js";

/**
 * Where an episode's tools are. A `BondedEpisode` (from `fromBondedEnv`, or the one an Agent URL
 * handler hands you) has these, and so does the runner protocol's `EpisodeMessage`.
 */
export interface EpisodeToolsSource {
  endpoints: {
    /** MCP over streamable HTTP. The URL carries the episode's capability: it is per episode. */
    mcp: string;
    /** `POST` here when finished. */
    done: string;
  };
}

/** A JSON Schema for a tool's arguments: always an object. */
export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * The result of one tool call, as the Arena returns it. Failures are returned, not thrown, so the
 * agent's model can read them and react, as it would to a production tool's error. `text` is what
 * a model should read: the output as JSON, or the error.
 */
export type EpisodeToolResult =
  { ok: true; output: unknown; text: string } | { ok: false; error: string; text: string };

/** One of the episode's tools, framework-neutral. */
export interface EpisodeTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** Calls the tool at the gateway. */
  call(args?: Record<string, unknown>): Promise<EpisodeToolResult>;
}

/** Usage an agent reports at the end of an episode (recorded, never trusted for limits). */
export type EpisodeUsage = NonNullable<DoneRequest["usage"]>;

/** An MCP client connected to one episode, with its tools listed. */
export interface EpisodeTools {
  /** The official MCP SDK client, for anything not covered here. */
  readonly client: Client;
  /** The episode's tools, listed once at connect. */
  readonly tools: EpisodeTool[];
  /** MCP `tools/list`, as the server answers it. */
  listTools(): ReturnType<Client["listTools"]>;
  /** Calls a tool by name. */
  callTool(name: string, args?: Record<string, unknown>): Promise<EpisodeToolResult>;
  /** Tells the gateway the agent is finished (`POST {done}`). Later tool calls are refused. */
  done(body?: DoneRequest): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Closes the connection when it fires (e.g. the episode's deadline). */
  signal?: AbortSignal;
  /** The `fetch` to use (default: the global one). */
  fetch?: typeof fetch;
  /** How the client names itself to the server. */
  clientName?: string;
}

/**
 * Connects to the episode's MCP endpoint and lists its tools. With no argument it reads the
 * episode from the runner's `BONDED_*` variables (`fromBondedEnv`); in Agent URL mode pass the
 * episode your handler received.
 *
 * ```ts
 * const episode = await connectEpisodeTools();
 * for (const tool of episode.tools) console.log(tool.name, tool.inputSchema);
 * const prices = await episode.callTool("get_prices");
 * await episode.done({ finalMessage: "bought tNVDA" });
 * ```
 */
export async function connectEpisodeTools(
  episode: EpisodeToolsSource = fromBondedEnv(),
  options: ConnectOptions = {},
): Promise<EpisodeTools> {
  const http = options.fetch ?? fetch;
  const client = new Client({ name: options.clientName ?? "bonded-sdk", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(episode.endpoints.mcp), {
    fetch: http,
  });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new BondedError(
      "EPISODE_TOOLS",
      `couldn't connect to the episode's MCP endpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  options.signal?.addEventListener("abort", () => void client.close(), { once: true });

  const callTool = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<EpisodeToolResult> => {
    const result = await client.callTool({ name, arguments: args });
    return readResult(result);
  };
  const listed = await client.listTools();
  const tools: EpisodeTool[] = listed.tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: { ...(t.inputSchema as ToolInputSchema), type: "object" },
    call: (args) => callTool(t.name, args),
  }));

  return {
    client,
    tools,
    listTools: () => client.listTools(),
    callTool,
    done: (body) => finishEpisode(episode, body, { fetch: http }),
    close: () => client.close(),
  };
}

/** The Arena's `ToolResult`, from MCP's structured content when present, else the text. */
function readResult(result: Awaited<ReturnType<Client["callTool"]>>): EpisodeToolResult {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const structured = result.structuredContent as
    { ok: true; output: unknown } | { ok: false; error: string } | undefined;
  if (structured && typeof structured.ok === "boolean")
    return structured.ok
      ? { ok: true, output: structured.output, text }
      : { ok: false, error: structured.error, text: structured.error };
  if (result.isError) return { ok: false, error: text, text };
  let output: unknown = text;
  try {
    output = JSON.parse(text);
  } catch {
    // Plain text output.
  }
  return { ok: true, output, text };
}

/** The text a string-returning framework (LangChain, AgentKit) gives its model. */
export function resultText(result: EpisodeToolResult): string {
  return result.ok ? result.text : `Error: ${result.error}`;
}

/** Tools from a connection, or a fresh connection to the episode. */
export async function resolveTools(
  from: EpisodeTools | EpisodeToolsSource | undefined,
): Promise<EpisodeTools> {
  if (from && "callTool" in from && "tools" in from) return from;
  return connectEpisodeTools(from ?? fromBondedEnv());
}

/** The `mcp-remote` bridge, pinned, for MCP clients that only start local (stdio) servers. */
export const MCP_REMOTE_PACKAGE = "mcp-remote@0.14.3";

export interface McpConfigOptions {
  /** The server's name in the config. Default `bonded-episode`. */
  name?: string;
  /**
   * - `http` (default): `{ type: "http", url }`, for clients that speak streamable HTTP
   *   (Claude Code's `.mcp.json`, Cursor's `mcp.json`, and most current agents).
   * - `url`: `{ url }` only, for clients that infer the transport from the URL (older Cursor).
   * - `stdio`: `npx mcp-remote <url>`, for clients that only launch local servers (Claude Desktop).
   */
  style?: "http" | "url" | "stdio";
}

export type McpServerEntry =
  { type: "http"; url: string } | { url: string } | { command: string; args: string[] };

/**
 * The `mcpServers` block an MCP-aware agent accepts, pointing at this episode's MCP endpoint.
 * The URL carries the episode's capability and stops working when the episode ends, so write the
 * config afresh for every episode (e.g. at the start of the runner's agent command):
 *
 * ```sh
 * bonded-runner --command 'bonded-mcp-config > .mcp.json && my-agent --mcp-config .mcp.json'
 * ```
 */
export function mcpConfig(
  episode: { endpoints: { mcp: string } } = fromBondedEnv(),
  options: McpConfigOptions = {},
): { mcpServers: Record<string, McpServerEntry> } {
  const url = episode.endpoints.mcp;
  const style = options.style ?? "http";
  const entry: McpServerEntry =
    style === "stdio"
      ? { command: "npx", args: ["-y", MCP_REMOTE_PACKAGE, url] }
      : style === "url"
        ? { url }
        : { type: "http", url };
  return { mcpServers: { [options.name ?? "bonded-episode"]: entry } };
}

/** `mcpConfig` as pretty-printed JSON, ready to write to a file. */
export function mcpConfigJson(
  episode: { endpoints: { mcp: string } } = fromBondedEnv(),
  options: McpConfigOptions = {},
): string {
  return `${JSON.stringify(mcpConfig(episode, options), null, 2)}\n`;
}

/**
 * Your MCP server's pay tool handler, with every call checked against the payment mandate first
 * (see `PaymentGuard`). Register the result in its place:
 *
 * ```ts
 * const guard = paymentGuard({ mandate, vendors, invoices, onBreach: alert });
 * server.registerTool("pay_invoice", config, guardMcpPayHandler(payInvoice, { guard }));
 * ```
 *
 * When the guard refuses (Enforce mode blocked it, the guard is frozen, or it can't read the
 * payment) your handler is not called and the client gets an error result (`isError: true`)
 * naming the rules broken, so the model can react. In Monitor mode a breaking payment goes
 * through and the guard's `onBreach` reports it. The payment is read from the tool's arguments:
 * `{ account, amountUsd, invoiceReference }` unless you pass `toPayment`. A local check: no
 * receipts.
 */
export function guardMcpPayHandler<I, Rest extends unknown[]>(
  handler: (args: I, ...rest: Rest) => CallToolResult | Promise<CallToolResult>,
  options: GuardPaymentsOptions<I>,
): (args: I, ...rest: Rest) => Promise<CallToolResult> {
  const guarded = guardPayments(handler, options);
  return async (args, ...rest) => {
    try {
      return await guarded(args, ...rest);
    } catch (error) {
      if (isPaymentRefusal(error))
        return { content: [{ type: "text", text: error.message }], isError: true };
      throw error;
    }
  };
}
