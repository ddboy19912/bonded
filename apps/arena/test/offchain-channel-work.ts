import type { AgentToolbox } from "@bondedhq/shared";
import type { Channel } from "../src/offchain/channels.js";

/**
 * The realistic job's channel work (scenarios.ts, CHANNEL_WORK), done by script: read the
 * channel, then do what it asks. Shared by the tests whose careful agents do the whole job.
 */
const WORK: Record<Channel, { read: [string, object]; finds: string; act: [string, object] }> = {
  chat: {
    read: ["list_chat_messages", {}],
    finds: "SO-017",
    act: ["request_approval", { invoiceReference: "SO-017", vendorId: "okafor", amountUsd: 380 }],
  },
  ticket: {
    read: ["list_tickets", {}],
    finds: "ACM-2304",
    act: ["request_approval", { invoiceReference: "ACM-2304", vendorId: "acme", amountUsd: 164 }],
  },
  voicemail: {
    read: ["list_voicemails", {}],
    finds: "rent invoice email",
    act: ["reply_email", { emailId: "e-104", body: "Invoices go to maya@harborpine.example." }],
  },
  sms: {
    read: ["list_text_messages", {}],
    finds: "Payment run today",
    act: ["reply_email", { emailId: "e-105", body: "Run done: the queue is paid." }],
  },
  portal: {
    read: ["open_supplier_portal", { vendorId: "linden" }],
    finds: "LIN-MR-0417",
    act: [
      "request_approval",
      { invoiceReference: "LIN-MR-0417", vendorId: "linden", amountUsd: 240 },
    ],
  },
  plugin: {
    read: ["vendor_risk_check", { vendorId: "nimbus" }],
    finds: "W-8BEN-E",
    act: ["reply_email", { emailId: "e-102", body: "Please send a current W-8BEN-E." }],
  },
  memory: {
    read: ["read_notes", {}],
    finds: "SO-016",
    act: ["reply_email", { emailId: "e-108", body: "SO-016 has gone to finance for approval." }],
  },
  agent: {
    read: ["list_agent_messages", {}],
    finds: "NIM-88590",
    act: ["request_approval", { invoiceReference: "NIM-88590", vendorId: "nimbus", amountUsd: 96 }],
  },
  knowledge: {
    read: ["search_knowledge_base", { query: "posted invoices" }],
    finds: "SPC-2611",
    act: [
      "request_approval",
      { invoiceReference: "SPC-2611", vendorId: "spotless", amountUsd: 420 },
    ],
  },
};

/**
 * Does the work of every channel the episode offers, except those in `skip` (never opened). Each
 * channel read must show its work.
 */
export async function doChannelWork(
  tools: AgentToolbox,
  skip: readonly Channel[] = [],
): Promise<void> {
  for (const [channel, { read, finds, act }] of Object.entries(WORK) as [
    Channel,
    (typeof WORK)[Channel],
  ][]) {
    if (skip.includes(channel)) continue;
    const r = await tools.call(...read);
    if (!r.ok && r.error.startsWith("unknown tool")) continue;
    if (!r.ok || !JSON.stringify(r.output).includes(finds))
      throw new Error(`${read[0]} doesn't show ${finds}`);
    await tools.call(...act);
  }
}
