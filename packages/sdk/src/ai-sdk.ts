import { jsonSchema, type Tool, tool } from "ai";
import { SENTINEL_INPUT_CHARS } from "@bondedhq/shared";
import { BondedError } from "./errors.js";
import type { GuardContext } from "./guarded.js";
import { type EpisodeTools, type EpisodeToolsSource, resolveTools } from "./mcp.js";
import { type GuardPaymentsOptions, guardPayments, isPaymentRefusal } from "./payments.js";
import type { SentinelInput } from "./sentinel.js";
import {
  BONDED_VAULT_TOOLS,
  type BondedVaultToolsOptions,
  bondedVaultTools,
} from "./vault-tools.js";

export type { BondedVaultToolsOptions } from "./vault-tools.js";
export type { GuardPaymentsOptions } from "./payments.js";

/**
 * The episode's tools as a Vercel AI SDK tool set, for `generateText`/`streamText`/agents. Each
 * keeps the tool's own JSON Schema; `execute` returns the Arena's output, or `{ error }` when the
 * call failed, so the model can react as it would to a production tool.
 *
 * With no argument it reads the episode from the runner's `BONDED_*` variables. Switch to them
 * only while being rated:
 *
 * ```ts
 * const tools = isBondedEpisode() ? await bondedAiSdkTools() : productionTools;
 * await generateText({ model, tools, stopWhen: stepCountIs(10), prompt: task.goal });
 * ```
 *
 * Peer dependency: `ai` 5 or later (tested with 7).
 */
export async function bondedAiSdkTools(
  from?: EpisodeTools | EpisodeToolsSource,
): Promise<Record<string, Tool>> {
  const episode = await resolveTools(from);
  return Object.fromEntries(
    episode.tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema<Record<string, unknown>>(
          t.inputSchema as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (args: Record<string, unknown>) => {
          const result = await t.call(args ?? {});
          return result.ok ? result.output : { error: result.error };
        },
      }),
    ]),
  );
}

/**
 * The agent's Mandate Vault as an AI SDK tool set, for production: `swap`, `transfer`, `approve`
 * and `vault_status`, every write sent through `BondedVault` so the vault checks it against the
 * mandate. Each write is dry-run first and refused on a predicted breach (`guard`, on by
 * default). With `sentinel`, Sentinel is asked too; what the agent read is taken from the tool
 * results earlier in the conversation, unless you pass `context`. A refusal or failure returns
 * `{ error }`, so the model can react.
 *
 * The names and arguments match the episode's write tools, so the agent's prompts work the same
 * while it is rated:
 *
 * ```ts
 * const tools = isBondedEpisode()
 *   ? await bondedAiSdkTools()
 *   : { ...productionTools, ...bondedVaultAiSdkTools({ vault }) };
 * ```
 */
export function bondedVaultAiSdkTools(options: BondedVaultToolsOptions): Record<string, Tool> {
  return Object.fromEntries(
    bondedVaultTools(options).map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema<Record<string, unknown>>(
          t.inputSchema as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (args: Record<string, unknown>, call?: { messages?: unknown[] }) => {
          const context: GuardContext | undefined =
            options.sentinel && !options.context
              ? { untrustedInputs: toolResultsIn(call?.messages ?? []) }
              : undefined;
          const result = await t.call(args ?? {}, context);
          return result.ok ? result.output : { error: result.error };
        },
      }),
    ]),
  );
}

/** The tool results the model has seen (the last 20), as Sentinel's untrusted inputs. */
function toolResultsIn(messages: unknown[]): SentinelInput[] {
  const own = new Set<string>(BONDED_VAULT_TOOLS);
  const inputs: SentinelInput[] = [];
  for (const message of messages) {
    const m = message as { role?: string; content?: unknown };
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content as { type?: string; toolName?: string; output?: unknown }[]) {
      if (part.type !== "tool-result" || !part.toolName || own.has(part.toolName)) continue;
      const out = part.output as { type?: string; value?: unknown } | undefined;
      const value = out && typeof out === "object" && "value" in out ? out.value : out;
      const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
      inputs.push({ tool: part.toolName, output: text.slice(0, SENTINEL_INPUT_CHARS) });
    }
  }
  return inputs.slice(-20);
}

/**
 * Your own AI SDK pay tool, with every call checked against the payment mandate first (see
 * `PaymentGuard`). Same name, description and input schema. When the guard refuses (Enforce mode
 * blocked it, the guard is frozen, or it can't read the payment) your `execute` is not called and
 * the model gets `{ error }` naming the rules broken, so it can react. In Monitor mode a breaking
 * payment goes through and the guard's `onBreach` reports it. A local check: no receipts.
 *
 * ```ts
 * const guard = paymentGuard({ mandate, vendors, invoices, onBreach: alert });
 * const tools = { ...readOnlyTools, pay_invoice: guardAiSdkPayTool(payInvoice, { guard }) };
 * ```
 *
 * The payment is read from the tool's input: `{ account, amountUsd, invoiceReference }` unless you
 * pass `toPayment`. A streaming `execute` is run to its end before the payment is recorded, and
 * returns its last output.
 */
export function guardAiSdkPayTool<T extends Tool>(
  payTool: T,
  options: GuardPaymentsOptions<Parameters<NonNullable<T["execute"]>>[0]>,
): T {
  const execute = payTool.execute;
  if (!execute) throw new BondedError("CONFIG", "guardAiSdkPayTool needs a tool with execute");
  type Input = Parameters<typeof execute>[0];
  type Call = Parameters<typeof execute>[1];
  const guarded = guardPayments(
    async (input: Input, call: Call) => lastOutput(await execute(input, call)),
    options,
  );
  return {
    ...payTool,
    execute: async (input: Input, call: Call) => {
      try {
        return await guarded(input, call);
      } catch (error) {
        if (isPaymentRefusal(error)) return { error: error.message };
        throw error;
      }
    },
  };
}

/** A tool's output, or a streaming tool's last output. */
async function lastOutput(output: unknown): Promise<unknown> {
  if (!output || typeof output !== "object" || !(Symbol.asyncIterator in output)) return output;
  let last: unknown;
  for await (const part of output as AsyncIterable<unknown>) last = part;
  return last;
}
