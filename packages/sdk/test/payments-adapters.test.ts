import { ToolMessage } from "@langchain/core/messages";
import { tool as langChainTool } from "@langchain/core/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { guardAiSdkPayTool } from "../src/ai-sdk.js";
import { type PaymentBreach, paymentGuard, type PaymentMandate } from "../src/index.js";
import { guardLangChainPayTool } from "../src/langchain.js";
import { guardMcpPayHandler } from "../src/mcp.js";

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

const payment = z.object({
  account: z.string(),
  amountUsd: z.number(),
  invoiceReference: z.string(),
});
type Payment = z.infer<typeof payment>;

const blockedText = /payment blocked by the mandate: the account is not in the vendor master/;

const usage = {
  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const step = (toolCallId: string, input: Payment) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId,
      toolName: "pay_invoice",
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});

describe("guardAiSdkPayTool", () => {
  it("a generateText agent's breaking payment is blocked and the model reads why; the correct one is paid", async () => {
    const { guard, breaches } = guardFor("enforce");
    const bank = vi.fn(async (input: Payment) => ({ status: "paid", to: input.account }));
    const payInvoice = tool({
      description: "Pay an invoice from the business account to a bank account.",
      inputSchema: jsonSchema<Payment>(z.toJSONSchema(payment) as Parameters<typeof jsonSchema>[0]),
      execute: bank,
    });
    const model = new MockLanguageModelV4({
      doGenerate: [
        step("t1", BAD),
        step("t2", GOOD),
        {
          content: [{ type: "text", text: "paid ACM-2291 to the account on file" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });
    const result = await generateText({
      model,
      tools: { pay_invoice: guardAiSdkPayTool(payInvoice, { guard }) },
      stopWhen: stepCountIs(5),
      prompt: "Pay this week's invoices.",
    });

    expect(result.text).toBe("paid ACM-2291 to the account on file");
    expect(bank).toHaveBeenCalledTimes(1);
    expect(bank.mock.calls[0]![0]).toEqual(GOOD);
    const outputs = result.steps.flatMap((s) => s.toolResults.map((r) => r.output));
    expect(outputs[0]).toEqual({ error: expect.stringMatching(blockedText) });
    expect(outputs[1]).toEqual({ status: "paid", to: ACME });
    // The model saw the refusal before its next step.
    expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toMatch(blockedText);
    expect(breaches.map((b) => b.rules)).toEqual([["unknown_payee", "unmatched_invoice"]]);
  });

  it("Monitor mode: the breaking payment is made and reported", async () => {
    const { guard, breaches } = guardFor("monitor");
    const bank = vi.fn(async () => "paid");
    const payInvoice = guardAiSdkPayTool(
      tool({ description: "pay", inputSchema: payment, execute: bank }),
      { guard },
    );
    await expect(
      payInvoice.execute!(BAD, { toolCallId: "t1", messages: [], context: {} }),
    ).resolves.toBe("paid");
    expect(bank).toHaveBeenCalledTimes(1);
    expect(breaches[0]).toMatchObject({ blocked: false, lossUsd: 1840.5 });
  });
});

describe("guardLangChainPayTool", () => {
  it("answers a blocked tool call with Error text and never calls the tool", async () => {
    const { guard } = guardFor("enforce");
    const bank = vi.fn(async (input: Payment) => `paid ${input.invoiceReference}`);
    const payInvoice = langChainTool(bank, {
      name: "pay_invoice",
      description: "Pay an invoice from the business account to a bank account.",
      schema: payment,
    });
    const guarded = guardLangChainPayTool(payInvoice, { guard });
    expect(guarded.name).toBe("pay_invoice");

    const blocked: unknown = await guarded.invoke({
      type: "tool_call",
      id: "call-1",
      name: "pay_invoice",
      args: BAD,
    });
    expect(blocked).toBeInstanceOf(ToolMessage);
    expect((blocked as ToolMessage).content).toMatch(/^Error: payment blocked by the mandate/);
    expect(bank).not.toHaveBeenCalled();

    const paid: unknown = await guarded.invoke({
      type: "tool_call",
      id: "call-2",
      name: "pay_invoice",
      args: GOOD,
    });
    expect((paid as ToolMessage).content).toBe("paid ACM-2291");
    expect(bank).toHaveBeenCalledTimes(1);
  });
});

describe("guardMcpPayHandler", () => {
  it("an MCP client's blocked call gets an error result; the handler isn't called", async () => {
    const { guard } = guardFor("enforce");
    const handler = vi.fn(async (args: Payment) => ({
      content: [{ type: "text" as const, text: `paid ${args.invoiceReference}` }],
    }));
    const server = new McpServer({ name: "payments", version: "1" });
    server.registerTool(
      "pay_invoice",
      { description: "Pay an invoice.", inputSchema: payment.shape },
      guardMcpPayHandler(handler, { guard }),
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "agent", version: "1" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const blocked = await client.callTool({ name: "pay_invoice", arguments: BAD });
      expect(blocked.isError).toBe(true);
      expect(blocked.content).toEqual([{ type: "text", text: expect.stringMatching(blockedText) }]);
      expect(handler).not.toHaveBeenCalled();

      const paid = await client.callTool({ name: "pay_invoice", arguments: GOOD });
      expect(paid.isError).toBeFalsy();
      expect(paid.content).toEqual([{ type: "text", text: "paid ACM-2291" }]);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
