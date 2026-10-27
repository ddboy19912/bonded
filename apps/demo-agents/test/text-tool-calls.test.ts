import { describe, expect, it } from "vitest";
import { readTextToolCalls } from "../src/text-tool-calls.js";

const tools = new Set(["list_approved_invoices", "get_vendor", "pay_invoice"]);
const args = (r: ReturnType<typeof readTextToolCalls>) =>
  r?.calls.map((c) => [c.function.name, JSON.parse(c.function.arguments)]);

describe("readTextToolCalls", () => {
  it("reads Llama's pythonic calls after a sentence of planning", () => {
    const r = readTextToolCalls(
      "Let's start by listing this week's approved invoices: [list_approved_invoices()]",
      tools,
    );
    expect(r?.before).toBe("Let's start by listing this week's approved invoices:");
    expect(args(r)).toEqual([["list_approved_invoices", {}]]);
    expect(r?.calls[0]).toMatchObject({ id: "text-call-0", type: "function" });
  });

  it("reads several calls, with quoted, bare, numeric and boolean arguments", () => {
    const r = readTextToolCalls(
      `[get_vendor(vendorId=acme), pay_invoice(account="GB33 BUKB 2020 1555 5555 55", amountUsd=1840.5, invoiceReference='ACM-2291', memo=None)]`,
      tools,
    );
    expect(args(r)).toEqual([
      ["get_vendor", { vendorId: "acme" }],
      [
        "pay_invoice",
        {
          account: "GB33 BUKB 2020 1555 5555 55",
          amountUsd: 1840.5,
          invoiceReference: "ACM-2291",
          memo: null,
        },
      ],
    ]);
  });

  it("takes only the first list, dropping a result the model invented after it", () => {
    const r = readTextToolCalls(
      "[get_vendor(vendorId=acme)]\nassistant\nThe vendor's account is XX99 1234. Now [pay_invoice(account=XX99 1234, amountUsd=1840, invoiceReference=ACM-2291)]",
      tools,
    );
    expect(args(r)).toEqual([["get_vendor", { vendorId: "acme" }]]);
  });

  it("ignores text that isn't a call to one of the agent's tools", () => {
    expect(readTextToolCalls("All three invoices are paid.", tools)).toBeNull();
    expect(readTextToolCalls("See [the vendor list] for details.", tools)).toBeNull();
    expect(readTextToolCalls("[transfer(to=0xabc, amount=5)]", tools)).toBeNull();
    expect(readTextToolCalls("[get_vendor(vendorId=acme), transfer(x=1)]", tools)).toBeNull();
    expect(readTextToolCalls(null, tools)).toBeNull();
  });

  it("refuses calls it can't read exactly, rather than guessing", () => {
    expect(readTextToolCalls("[get_vendor(acme)]", tools)).toBeNull(); // positional
    expect(readTextToolCalls("[get_vendor(vendorId=acme]", tools)).toBeNull(); // unclosed
    expect(readTextToolCalls('[pay_invoice(account="unclosed)]', tools)).toBeNull();
    expect(readTextToolCalls("[get_vendor(vendorId={'a': 1})]", tools)).toBeNull(); // nested
  });
});
