import { Agent, type Model, RunContext, Runner, tool, Usage } from "@openai/agents-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type PaymentBreach, paymentGuard, type PaymentMandate } from "../src/index.js";
import { guardOpenAiAgentsPayTool } from "../src/openai-agents.js";

const ACME = "DE89 3704 0044 0532 0130 00";
const FRAUD = "LT12 1000 0111 0100 1000";
const GOOD = { account: ACME, amountUsd: 1840.5, invoiceReference: "ACM-2291" };
const BAD = { ...GOOD, account: FRAUD };

function guardFor(mode: PaymentMandate["mode"]) {
  const breaches: PaymentBreach[] = [];
  const guard = paymentGuard({
    mandate: { mode, maxPaymentUsd: 10_000, maxDailyUsd: 10_000, freezeOnBreach: false },
    vendors: [{ id: "acme", account: ACME }],
    invoices: [{ reference: "ACM-2291", vendorId: "acme", amountUsd: 1840.5 }],
    onBreach: (b) => void breaches.push(b),
  });
  return { guard, breaches };
}

function payTool(options: { needsApproval?: boolean } = {}) {
  const bank = vi.fn(
    async (args: { account: string; amountUsd: number }) => `paid ${args.amountUsd}`,
  );
  const t = tool({
    name: "pay_invoice",
    description: "Pay an approved invoice",
    parameters: z.object({
      account: z.string(),
      amountUsd: z.number(),
      invoiceReference: z.string(),
    }),
    execute: bank,
    needsApproval: options.needsApproval ?? false,
  });
  return { tool: t, bank };
}

const run = new RunContext();

/** A model that calls pay_invoice once with `args`, then answers "done". */
function scriptedModel(args: object) {
  const inputs: unknown[] = [];
  const model = {
    async getResponse(request: { input: unknown }) {
      inputs.push(request.input);
      return inputs.length === 1
        ? {
            usage: new Usage(),
            responseId: "r1",
            output: [
              {
                type: "function_call",
                callId: "call-1",
                name: "pay_invoice",
                arguments: JSON.stringify(args),
                status: "completed",
              },
            ],
          }
        : {
            usage: new Usage(),
            responseId: "r2",
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "done" }],
              },
            ],
          };
    },
    async *getStreamedResponse() {},
  } as unknown as Model;
  return { model, inputs };
}

describe("guardOpenAiAgentsPayTool", () => {
  it("keeps the tool's name, description, parameters and approval setting", () => {
    const { guard } = guardFor("enforce");
    const { tool: t } = payTool({ needsApproval: true });
    const guarded = guardOpenAiAgentsPayTool(t, { guard });
    expect(guarded.type).toBe("function");
    expect(guarded.name).toBe("pay_invoice");
    expect(guarded.description).toBe(t.description);
    expect(guarded.parameters).toBe(t.parameters);
    expect(guarded.needsApproval).toBe(t.needsApproval);
    expect(guarded.strict).toBe(t.strict);
  });

  it("in a full agent run, the blocked payment's reason goes back to the model", async () => {
    const { guard } = guardFor("enforce");
    const { tool: t, bank } = payTool();
    const { model, inputs } = scriptedModel(BAD);
    const agent = new Agent({
      name: "AP clerk",
      model,
      tools: [guardOpenAiAgentsPayTool(t, { guard })],
    });

    const result = await new Runner({ tracingDisabled: true }).run(agent, "Pay ACM-2291");

    expect(result.finalOutput).toBe("done");
    expect(bank).not.toHaveBeenCalled();
    expect(JSON.stringify(inputs[1])).toContain("payment blocked by the mandate");
  });

  it("Enforce: a breaking payment is blocked and the model reads why; the correct one is paid", async () => {
    const { guard, breaches } = guardFor("enforce");
    const { tool: t, bank } = payTool();
    const guarded = guardOpenAiAgentsPayTool(t, { guard });

    const blocked = await guarded.invoke(run, JSON.stringify(BAD));
    expect(blocked).toMatch(
      /^Error: payment blocked by the mandate: the account is not in the vendor master/,
    );
    expect(bank).not.toHaveBeenCalled();

    expect(await guarded.invoke(run, JSON.stringify(GOOD))).toBe("paid 1840.5");
    expect(bank).toHaveBeenCalledOnce();
    expect(breaches.map((b) => b.rules)).toEqual([["unknown_payee", "unmatched_invoice"]]);
    expect(guard.state().payments).toHaveLength(1);
  });

  it("Monitor: the breaking payment goes through and is reported", async () => {
    const { guard, breaches } = guardFor("monitor");
    const { tool: t, bank } = payTool();
    const guarded = guardOpenAiAgentsPayTool(t, { guard });
    expect(await guarded.invoke(run, JSON.stringify(BAD))).toBe("paid 1840.5");
    expect(bank).toHaveBeenCalledOnce();
    expect(breaches[0]).toMatchObject({
      rules: ["unknown_payee", "unmatched_invoice"],
      blocked: false,
    });
  });

  it("a second payment of the same invoice is blocked as a duplicate", async () => {
    const { guard } = guardFor("enforce");
    const { tool: t, bank } = payTool();
    const guarded = guardOpenAiAgentsPayTool(t, { guard });
    await guarded.invoke(run, JSON.stringify(GOOD));
    expect(await guarded.invoke(run, JSON.stringify(GOOD))).toMatch(/^Error: .*already paid/);
    expect(bank).toHaveBeenCalledOnce();
  });

  it("arguments that aren't JSON, or that it can't read as a payment, pay nothing", async () => {
    const { guard } = guardFor("enforce");
    const { tool: t, bank } = payTool();
    const guarded = guardOpenAiAgentsPayTool(t, { guard });
    expect(await guarded.invoke(run, "{not json")).toMatch(/^Error: .*not valid JSON/);
    expect(await guarded.invoke(run, JSON.stringify({ account: ACME }))).toMatch(
      /^Error: amountUsd must be a number/,
    );
    expect(bank).not.toHaveBeenCalled();
  });

  it("JSON that isn't an object pays nothing, even with a custom toPayment", async () => {
    const { guard } = guardFor("enforce");
    const { tool: t, bank } = payTool();
    const toPayment = vi.fn((args: Record<string, unknown>) => ({
      account: String(args.to),
      amountUsd: Number(args.usd),
    }));
    const guarded = guardOpenAiAgentsPayTool(t, { guard, toPayment });
    for (const input of ["null", "[1,2]", "42", '"pay"'])
      expect(await guarded.invoke(run, input)).toMatch(/^Error: .*must be an object/);
    expect(toPayment).not.toHaveBeenCalled();
    expect(bank).not.toHaveBeenCalled();
  });

  it("a tool that throws records no payment, so it can be retried", async () => {
    const { guard } = guardFor("enforce");
    const t = tool({
      name: "pay_invoice",
      description: "Pay",
      parameters: z.object({
        account: z.string(),
        amountUsd: z.number(),
        invoiceReference: z.string(),
      }),
      execute: async () => {
        throw new Error("bank down");
      },
      errorFunction: null,
    });
    const guarded = guardOpenAiAgentsPayTool(t, { guard });
    await expect(guarded.invoke(run, JSON.stringify(GOOD))).rejects.toThrow("bank down");
    expect(guard.state().payments).toEqual([]);
  });

  it("refuses something that isn't a function tool", () => {
    const { guard } = guardFor("enforce");
    expect(() => guardOpenAiAgentsPayTool({ type: "hosted_tool" } as never, { guard })).toThrow(
      /needs a function tool/,
    );
  });
});
