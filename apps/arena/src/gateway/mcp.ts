import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentMode, EpisodeWorld, ToolResult } from "@bondedhq/shared";
import { toolList, worldIntro } from "./tools.js";

/**
 * MCP over streamable HTTP for one episode (`POST /e/{t}/mcp`), with the official SDK. Stateless:
 * every request gets its own server and transport, so nothing about one request (or one episode)
 * outlives it, and the capability in the URL is the only state. Responses are plain JSON rather
 * than an event stream; MCP clients accept either.
 *
 * Tool results carry the in-process toolbox's result unchanged: `content` is its output as JSON
 * text (what a model reads), `structuredContent` the whole `ToolResult`, and a failed call sets
 * `isError` with the error as text.
 */
export async function serveMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  episode: {
    mode: AgentMode;
    world: EpisodeWorld;
    callTool(name: string, args: unknown): Promise<ToolResult>;
  },
): Promise<void> {
  const server = new Server(
    { name: "trading-tools", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: worldIntro(episode.world).instructions,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolList(episode.mode, episode.world).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: inputSchema as { type: "object"; [key: string]: unknown },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const result = await episode.callTool(request.params.name, request.params.arguments ?? {});
    return result.ok
      ? {
          content: [{ type: "text", text: JSON.stringify(result.output) ?? "null" }],
          structuredContent: result,
        }
      : {
          content: [{ type: "text", text: result.error }],
          structuredContent: result,
          isError: true,
        };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
