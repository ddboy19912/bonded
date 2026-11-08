import { BondedError } from "./errors.js";
import { type GuardPaymentsOptions, guardPayments, isPaymentRefusal } from "./payments.js";

export type { GuardPaymentsOptions } from "./payments.js";

/**
 * The part of an OpenAI Agents SDK function tool (`tool()` from `@openai/agents`) the guard needs.
 * The SDK calls `invoke` with the run context and the model's arguments as a JSON string.
 */
export interface OpenAiAgentsFunctionTool {
  type: "function";
  name: string;
  invoke: (runContext: never, input: string, details?: never) => Promise<unknown>;
}

/**
 * Your own OpenAI Agents SDK pay tool, with every call checked against the payment mandate first
 * (see `PaymentGuard`, or pass the hosted `PaymentGate` as `guard`). Same name, description,
 * parameters, approval setting and guardrails. When the guard refuses (Enforce mode blocked it,
 * the guard is frozen, the gate couldn't be reached, or it can't read the payment) your tool is not
 * called and the model gets `Error: ...` naming the rules broken, so it can react. In Monitor mode
 * a breaking payment goes through and the guard's `onBreach` reports it.
 *
 * ```ts
 * import { Agent, tool } from "@openai/agents";
 * import { guardOpenAiAgentsPayTool } from "@bondedhq/sdk/openai-agents";
 *
 * const guard = paymentGuard({ mandate, vendors, invoices, onBreach: alert });
 * const agent = new Agent({ name: "AP clerk", tools: [...readOnlyTools, guardOpenAiAgentsPayTool(payInvoice, { guard })] });
 * ```
 *
 * The payment is read from the tool's arguments: `{ account, amountUsd, invoiceReference }` unless
 * you pass `toPayment`. If the tool needs a person's approval, the run stops for it before the
 * guard is asked, so an approved payment can still be blocked.
 */
export function guardOpenAiAgentsPayTool<T extends OpenAiAgentsFunctionTool>(
  payTool: T,
  options: GuardPaymentsOptions<Record<string, unknown>>,
): T {
  if (payTool?.type !== "function" || typeof payTool.invoke !== "function")
    throw new BondedError("CONFIG", "guardOpenAiAgentsPayTool needs a function tool");
  type Invoke = T["invoke"];
  const invoke = payTool.invoke.bind(payTool) as Invoke;
  const guarded = guardPayments(
    (_args: Record<string, unknown>, runContext: never, input: string, details?: never) =>
      invoke(runContext, input, details),
    options,
  );
  return {
    ...payTool,
    invoke: (async (runContext: never, input: string, details?: never) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(input || "{}") as Record<string, unknown>;
      } catch {
        return "Error: the payment's arguments are not valid JSON; no payment was made";
      }
      // A custom toPayment reads fields: null or an array would throw before the guard answers.
      if (!args || typeof args !== "object" || Array.isArray(args))
        return "Error: the payment's arguments must be an object; no payment was made";
      try {
        return await guarded(args, runContext, input, details);
      } catch (error) {
        if (isPaymentRefusal(error)) return `Error: ${error.message}`;
        throw error;
      }
    }) as Invoke,
  };
}
