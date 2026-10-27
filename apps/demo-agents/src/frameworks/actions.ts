// The same zod 3 package both frameworks resolve to: their checks use `instanceof`.
import { z } from "zod3";
import {
  AGENT_TOOL_NAMES,
  AGENT_TOOLS,
  type AgentToolbox,
  type AgentToolName,
  OFFCHAIN_TOOL_NAMES,
  OFFCHAIN_TOOLS,
  type OffchainToolName,
  splitToolImage,
} from "@bondedhq/shared";

/**
 * The Arena's tools as framework actions (docs/SPECIFICATION.md Section 8.4, "Framework adapters"). Each
 * adapter registers these with its framework's own action interface (AgentKit action provider,
 * Solana Agent Kit actions), so the framework's template agent runs unchanged and only the
 * execution lands in the Arena's sandbox. The schemas are built with zod 3 (as `zod3`), the
 * version both frameworks build their tool definitions with.
 */

const Amount = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
  .describe("Token amount in whole units as a decimal string, e.g. 2000 or 0.5");
const TokenSymbol = z.string().min(1).max(32).describe("Token symbol, e.g. tUSDG or tNVDA");
const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe("A 0x address");
const NoArgs = z.object({});

export interface ArenaAction {
  name: AgentToolName | OffchainToolName;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
}

/** Arguments for each Arena tool, mirroring AGENT_TOOLS in @bondedhq/shared (tested). */
const SCHEMAS: Record<AgentToolName, z.ZodObject<z.ZodRawShape>> = {
  read_inbox: NoArgs,
  read_news: NoArgs,
  read_social: NoArgs,
  get_prices: NoArgs,
  get_token_info: z.object({ symbol: TokenSymbol }),
  get_portfolio: NoArgs,
  get_recent_transfers: NoArgs,
  get_market_report: NoArgs,
  read_market_alerts: NoArgs,
  read_counterparty_messages: NoArgs,
  swap: z.object({ tokenIn: TokenSymbol, tokenOut: TokenSymbol, amountIn: Amount }),
  transfer: z.object({ token: TokenSymbol, to: Address, amount: Amount }),
  approve: z.object({ token: TokenSymbol, spender: Address, amount: Amount }),
};

/** Every Arena tool, with the shared descriptions. */
export const ARENA_ACTIONS: ArenaAction[] = AGENT_TOOL_NAMES.map((name) => ({
  name,
  description: AGENT_TOOLS[name].description,
  schema: SCHEMAS[name],
}));

const Id = z.string().min(1).max(128);

/** Arguments for each off-chain tool, mirroring OFFCHAIN_TOOLS in @bondedhq/shared (tested). */
const OFFCHAIN_SCHEMAS: Record<OffchainToolName, z.ZodObject<z.ZodRawShape>> = {
  list_emails: NoArgs,
  read_email: z.object({ emailId: Id }),
  view_attachment: z.object({ attachmentId: Id }),
  list_vendors: NoArgs,
  get_vendor: z.object({ vendorId: Id }),
  list_payments: NoArgs,
  list_approved_invoices: NoArgs,
  pay_invoice: z.object({
    account: z.string().min(1).max(64).describe("The bank account to pay (IBAN or number)"),
    amountUsd: z.number().positive().describe("Amount in US dollars, e.g. 1840.5"),
    invoiceReference: Id.describe("The invoice reference, e.g. ACM-2291"),
    memo: z.string().max(280).optional(),
  }),
  reply_email: z.object({ emailId: Id, body: z.string().min(1).max(4000) }),
  list_change_tickets: NoArgs,
  update_vendor_bank: z.object({
    vendorId: Id,
    account: z.string().min(1).max(64).describe("The new bank account (IBAN or number)"),
    ticket: Id.optional().describe("The finance change ticket id, e.g. CHG-1043"),
  }),
  list_chat_messages: NoArgs,
  list_tickets: NoArgs,
  list_voicemails: NoArgs,
  list_text_messages: NoArgs,
  open_supplier_portal: z.object({ vendorId: Id }),
  vendor_risk_check: z.object({ vendorId: Id }),
  read_notes: NoArgs,
  save_note: z.object({ text: z.string().min(1).max(1000) }),
  list_agent_messages: NoArgs,
  search_knowledge_base: z.object({ query: z.string().min(1).max(200) }),
  request_approval: z.object({
    invoiceReference: Id,
    vendorId: Id,
    amountUsd: z.number().positive(),
    note: z.string().max(500).optional(),
  }),
};

/** Every off-chain tool (docs/OFFCHAIN.md), with the shared descriptions. */
export const OFFCHAIN_ACTIONS: ArenaAction[] = OFFCHAIN_TOOL_NAMES.map((name) => ({
  name,
  description: OFFCHAIN_TOOLS[name].description,
  schema: OFFCHAIN_SCHEMAS[name],
}));

/** Which of the Arena's rails a framework agent is wired to. */
export type Rail = "onchain" | "offchain";

/** The rail's actions, limited to the tools the episode offers (AgentTask.tools) when it says. */
export function railActions(rail: Rail, tools?: readonly string[]): ArenaAction[] {
  const all = rail === "offchain" ? OFFCHAIN_ACTIONS : ARENA_ACTIONS;
  return tools ? all.filter((a) => tools.includes(a.name)) : all;
}

/**
 * Runs actions against the Arena's toolbox and keeps the episode's step cap: past it, an action
 * returns an error instead of running. Results go back to the framework as text, the way its
 * own actions return them.
 */
export class ArenaBridge {
  steps = 0;
  constructor(
    private readonly tools: AgentToolbox,
    private readonly maxSteps: number,
  ) {}

  async call(name: ArenaAction["name"], args: unknown): Promise<string> {
    if (this.steps >= this.maxSteps) return "Error: the step limit for this session is reached.";
    this.steps++;
    const result = await this.tools.call(name, args ?? {});
    if (!result.ok) return `Error: ${result.error}`;
    // Framework tools return text, so an image (an invoice scan) can't reach the model.
    const { rest, image } = splitToolImage(result.output);
    return JSON.stringify(
      image
        ? { ...(rest as Record<string, unknown>), image: "not shown: tools return text only" }
        : rest,
    );
  }
}
