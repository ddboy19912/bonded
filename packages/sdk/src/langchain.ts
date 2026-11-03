import { DynamicStructuredTool, type StructuredToolInterface } from "@langchain/core/tools";
import { type EpisodeTools, type EpisodeToolsSource, resolveTools, resultText } from "./mcp.js";
import { type GuardPaymentsOptions, guardPayments, isPaymentRefusal } from "./payments.js";
import { type BondedVaultToolsOptions, bondedVaultTools } from "./vault-tools.js";

export type { BondedVaultToolsOptions } from "./vault-tools.js";
export type { GuardPaymentsOptions } from "./payments.js";

/**
 * The episode's tools as LangChain `StructuredTool`s, for LangChain and LangGraph agents
 * (`createReactAgent`, `ToolNode`, `model.bindTools`). Each takes the tool's own JSON Schema and
 * returns what the Arena returned, as text; a failed call returns `Error: ...` so the model can
 * react, as it would to a production tool.
 *
 * With no argument it reads the episode from the runner's `BONDED_*` variables. Switch to them
 * only while being rated:
 *
 * ```ts
 * const tools = isBondedEpisode() ? await bondedLangChainTools() : productionTools;
 * const agent = createReactAgent({ llm, tools });
 * ```
 *
 * Peer dependency: `@langchain/core` 1.
 */
export async function bondedLangChainTools(
  from?: EpisodeTools | EpisodeToolsSource,
): Promise<DynamicStructuredTool[]> {
  const episode = await resolveTools(from);
  return episode.tools.map(
    (t) =>
      new DynamicStructuredTool({
        name: t.name,
        description: t.description,
        schema: t.inputSchema,
        func: async (args: Record<string, unknown>) => resultText(await t.call(args ?? {})),
      }),
  );
}

/**
 * The agent's Mandate Vault as LangChain tools, for production: `swap`, `transfer`, `approve`
 * and `vault_status`, every write sent through `BondedVault` so the vault checks it against the
 * mandate. Each write is dry-run first and refused on a predicted breach (`guard`, on by
 * default); with `sentinel`, Sentinel is asked too, with what `context()` says the agent read.
 * A refusal or failure comes back as `Error: ...` text, so the model can react.
 *
 * The names and arguments match the episode's write tools, so the agent's prompts work the same
 * while it is rated:
 *
 * ```ts
 * const tools = isBondedEpisode()
 *   ? await bondedLangChainTools()
 *   : [...productionTools, ...bondedVaultLangChainTools({ vault })];
 * ```
 */
export function bondedVaultLangChainTools(
  options: BondedVaultToolsOptions,
): DynamicStructuredTool[] {
  return bondedVaultTools(options).map(
    (t) =>
      new DynamicStructuredTool({
        name: t.name,
        description: t.description,
        schema: t.inputSchema,
        func: async (args: Record<string, unknown>) => resultText(await t.call(args ?? {})),
      }),
  );
}

/**
 * Your own LangChain pay tool, with every call checked against the payment mandate first (see
 * `PaymentGuard`). Same name, description and schema. When the guard refuses (Enforce mode
 * blocked it, the guard is frozen, or it can't read the payment) your tool is not called and the
 * model gets `Error: ...` naming the rules broken, so it can react. In Monitor mode a breaking
 * payment goes through and the guard's `onBreach` reports it. A local check: no receipts.
 *
 * ```ts
 * const guard = paymentGuard({ mandate, vendors, invoices, onBreach: alert });
 * const tools = [...readOnlyTools, guardLangChainPayTool(payInvoice, { guard })];
 * ```
 *
 * The payment is read from the tool's arguments: `{ account, amountUsd, invoiceReference }` unless
 * you pass `toPayment`.
 */
export function guardLangChainPayTool(
  payTool: StructuredToolInterface,
  options: GuardPaymentsOptions<Record<string, unknown>>,
): DynamicStructuredTool {
  const guarded = guardPayments(
    (args: Record<string, unknown>, config?: Parameters<StructuredToolInterface["invoke"]>[1]) =>
      payTool.invoke(args, config),
    options,
  );
  return new DynamicStructuredTool({
    name: payTool.name,
    description: payTool.description,
    schema: payTool.schema,
    func: async (args: Record<string, unknown>, _runManager, config) => {
      try {
        return await guarded(args ?? {}, config);
      } catch (error) {
        if (isPaymentRefusal(error)) return `Error: ${error.message}`;
        throw error;
      }
    },
  });
}
