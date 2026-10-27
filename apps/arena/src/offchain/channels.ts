import type { OffchainToolName } from "@bondedhq/shared";

/**
 * The channels an accounts-payable agent reads, beyond email (docs/OFFCHAIN.md, "Attack
 * vectors"). Each is a source of content, the tools that read it, and a vector name attacks are
 * reported under. A world holds what each channel says; a seed can plant into any of them.
 *
 * Every attack has two axes: what it wants (its class, O1 to O6) and how it arrives (its vector).
 */
export const CHANNELS = [
  "chat",
  "ticket",
  "voicemail",
  "sms",
  "portal",
  "plugin",
  "memory",
  "agent",
  "knowledge",
] as const;
export type Channel = (typeof CHANNELS)[number];

/** The tools that read (or write) each channel. A world without them isn't exposed to it. */
export const CHANNEL_TOOLS: Record<Channel, OffchainToolName[]> = {
  chat: ["list_chat_messages"],
  ticket: ["list_tickets"],
  voicemail: ["list_voicemails"],
  sms: ["list_text_messages"],
  portal: ["open_supplier_portal"],
  plugin: ["vendor_risk_check"],
  memory: ["read_notes", "save_note"],
  agent: ["list_agent_messages"],
  knowledge: ["search_knowledge_base"],
};

/** The email tools: the inbox, its attachments and replies. */
export const EMAIL_TOOLS: OffchainToolName[] = [
  "list_emails",
  "read_email",
  "view_attachment",
  "reply_email",
];

/**
 * The vectors results are reported under: the channels, plus email, invoice images, business
 * records (notes on vendor records) and the live counterparty.
 */
export const VECTORS = ["email", "image", "records", "counterparty", ...CHANNELS] as const;
export type Vector = (typeof VECTORS)[number];

/** A message in a message-like channel (chat, ticket, voicemail, sms, agent). */
export interface ChannelMessage {
  id: string;
  channel: "chat" | "ticket" | "voicemail" | "sms" | "agent";
  from: { name: string; address: string };
  subject?: string;
  /** The message text; for a voicemail, its transcript. */
  body: string;
  /** ISO 8601. */
  receivedAt: string;
  /** For a voicemail: where its transcript came from (the speech-to-text model and file). */
  source?: string;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  body: string;
}

/** What a world's non-email channels hold. */
export interface WorldChannels {
  messages: ChannelMessage[];
  /** Each vendor's billing-portal page, by vendor id. */
  portal: Record<string, string>;
  /** What the vendor-risk plugin returns for each vendor, by vendor id. */
  plugin: Record<string, string>;
  /** The agent's notes from earlier sessions (its memory). */
  notes: string[];
  knowledge: KnowledgeDoc[];
}

export const emptyChannels = (): WorldChannels => ({
  messages: [],
  portal: {},
  plugin: {},
  notes: [],
  knowledge: [],
});

/**
 * The knowledge-base documents matching a query: those containing any query word (three letters
 * or more) in the title or body, ignoring case, ranked by how often the words appear.
 */
export function searchKnowledge(docs: readonly KnowledgeDoc[], query: string): KnowledgeDoc[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  if (words.length === 0) return [];
  return docs
    .map((d) => {
      const text = `${d.title}\n${d.body}`.toLowerCase();
      const hits = words.map((w) => text.split(w).length - 1);
      return { d, ok: hits.some((h) => h > 0), score: hits.reduce((a, b) => a + b, 0) };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score)
    .map((x) => ({ ...x.d }));
}
