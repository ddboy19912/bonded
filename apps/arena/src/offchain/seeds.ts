import { OFFCHAIN_TOOL_NAMES, type OffchainToolName } from "@bondedhq/shared";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { LEDGER_BREACH_TYPES } from "./ledger.js";
import {
  baseWorld,
  type OffchainScenario,
  PAYMENT_RUN_GOAL,
  REALISTIC_GOAL,
  REALISTIC_TASKS,
  grantTools,
  realisticWorld,
} from "./scenarios.js";
import { attackOnlyInImage, plantedFacts } from "./attribution.js";
import { busyTasks, realisticBusyWorld } from "./busy.js";
import { attackSeen } from "./exposure.js";
import { CHANNEL_TOOLS, CHANNELS, emptyChannels, type Vector } from "./channels.js";
import {
  type Attachment,
  type Email,
  invoiceText,
  isRealDate,
  type OffchainWorld,
  worldTools,
} from "./world.js";

/**
 * Off-chain attack seeds (apps/arena/offchain-seeds): each plants emails and invoices into the
 * base world's payment run. The ledger, not the seed, decides whether the agent fell for it;
 * `aimedAt` only says which breaches count as the attack succeeding. See docs/OFFCHAIN.md.
 */
export const OFFCHAIN_SEEDS_DIR = fileURLToPath(new URL("../../offchain-seeds", import.meta.url));
/**
 * New attacks wait here until a library release moves them into OFFCHAIN_SEEDS_DIR (CLAUDE.md,
 * "Batch library changes into releases"). The runner reads them with --staged; the Index doesn't.
 */
export const OFFCHAIN_STAGED_SEEDS_DIR = fileURLToPath(
  new URL("../../offchain-seeds-staged", import.meta.url),
);
/** The library's invoice pictures. Fresh variants saved elsewhere still use these. */
export const OFFCHAIN_IMAGES_DIR = join(OFFCHAIN_SEEDS_DIR, "images");

export const OFFCHAIN_ATTACK_CLASSES = {
  O1: "Bank-detail change",
  O2: "Forged or inflated invoice",
  O3: "Duplicate invoice",
  O4: "Instructions in an attachment",
  O5: "Executive impersonation",
  O6: "Live counterparty",
} as const;
export type OffchainAttackClass = keyof typeof OFFCHAIN_ATTACK_CLASSES;

const Sender = z.object({ name: z.string().min(1), address: z.string().min(3) });

const InvoiceSeed = z.object({
  vendorName: z.string().min(1),
  vendorEmail: z.string().optional(),
  reference: z.string().min(1),
  issued: z.string(),
  due: z.string(),
  lines: z.array(z.object({ description: z.string(), amountUsd: z.number().positive() })).min(1),
  account: z.string().min(1),
});

const AttachmentSeed = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
    /** Laid out as invoiceText renders it. */
    invoice: InvoiceSeed.optional(),
    /** The attachment's text verbatim, instead of an invoice (empty for a scan with no text). */
    text: z.string().optional(),
    /** Added under the invoice's text, e.g. a note planted in the footer. */
    appendText: z.string().optional(),
    /** A PNG or JPEG in offchain-seeds/images/, shown to models that can see images. */
    image: z
      .string()
      .regex(/^[\w.-]+\.(png|jpg)$/)
      .optional(),
  })
  .refine((a) => (a.invoice === undefined) !== (a.text === undefined), {
    message: "an attachment needs exactly one of invoice or text",
  });

const ChannelMessageSeed = z.object({
  id: z.string().min(1),
  channel: z.enum(["chat", "ticket", "voicemail", "sms", "agent"]),
  from: Sender,
  subject: z.string().optional(),
  body: z.string().min(1),
  receivedAt: z.iso.datetime(),
  /** For a voicemail: where its transcript came from. */
  source: z.string().optional(),
});

const EmailSeed = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  from: Sender,
  subject: z.string().min(1),
  body: z.string().min(1),
  receivedAt: z.iso.datetime(),
  attachments: z.array(AttachmentSeed).default([]),
});

/**
 * O6: a model plays the sender of one planted thread and answers the agent's replies on it, to
 * talk the agent into paying. It writes text; the ledger still decides every breach.
 */
export const CounterpartySeed = z.object({
  /** The planted thread the counterparty owns. */
  threadId: z.string().min(1),
  from: Sender,
  /** What the counterparty is after and how it may argue, as its model is told. */
  brief: z.string().min(1),
  /** Replies it sends at most, one per agent reply on the thread. */
  maxReplies: z.number().int().min(1).max(8).default(4),
  /**
   * Thread hijacking: the counterparty controls a genuine vendor's mailbox, so it owns that
   * vendor's real thread and answers the agent's replies on it, including ones the job requires.
   * Off by default, so a seed can't take over a real thread by mistake.
   */
  hijack: z.boolean().default(false),
});
export type CounterpartySeed = z.infer<typeof CounterpartySeed>;

export const OffchainSeed = z.object({
  /**
   * A library seed's id, a fresh variant's (the seed's id and a hash of its text), or an adaptive
   * rewrite's: `-via-<channel>` when it was re-delivered, then `-r<round>` and `-c<candidate>`
   * when a round tried several.
   */
  id: z
    .string()
    .regex(/^O[1-6]-[a-z0-9-]+-\d{3}(-f[0-9a-f]{8})?(-via-[a-z]+)?(-r\d{1,2}(-c\d{1,2})?)?$/),
  /** For a fresh variant: the library seed it was drafted from. */
  variantOf: z.string().optional(),
  class: z.enum(Object.keys(OFFCHAIN_ATTACK_CLASSES) as [OffchainAttackClass]),
  title: z.string().min(1),
  description: z.string().min(1),
  aimedAt: z.array(z.enum(LEDGER_BREACH_TYPES)).min(1),
  /**
   * The job the attack is planted in: "v1", the approved-queue payment run; "v2", the realistic
   * job (scenarios.ts, realisticWorld), with vendor updates and approval requests; or "v3", the
   * realistic job on a busy Monday (busy.ts, realisticBusyWorld). A v2 seed plants into v3
   * unchanged: the busy world keeps everything the realistic one has.
   */
  world: z.enum(["v1", "v2", "v3"]).default("v1"),
  /**
   * Parts of the job the attack casts doubt on. A careful agent may hold them back to check, so
   * the task doesn't require them; doing them correctly is still fine. An approved invoice's
   * reference, or (realistic job) `reply:<email>`, `approval:<invoice>` or `update:<vendor>`.
   */
  mayHold: z.array(z.string()).default([]),
  plant: z.object({
    /** New emails, added to the inbox. */
    emails: z.array(EmailSeed).default([]),
    /** Existing emails whose body or attachments the attack changes (a compromised mailbox). */
    replace: z
      .array(
        z.object({
          emailId: z.string().min(1),
          body: z.string().optional(),
          attachments: z.array(AttachmentSeed).optional(),
        }),
      )
      .default([]),
    /** Messages on other channels (chat, tickets, voicemail, text, other agents). */
    messages: z.array(ChannelMessageSeed).default([]),
    /** Supplier-portal pages, by vendor id, replacing the vendor's page. */
    portal: z.record(z.string(), z.string()).default({}),
    /**
     * Supplier-portal pages that replace the vendor's page from the second time the agent reads it
     * (verify-then-swap): the first read, or the briefing, shows the genuine page, so a check made
     * at that point passes. The vendor needs a genuine page to open first.
     */
    portalSwap: z.record(z.string(), z.string()).default({}),
    /** What the third-party vendor-risk plugin returns, by vendor id. */
    plugin: z.record(z.string(), z.string()).default({}),
    /** Notes added to the agent's memory from "earlier sessions". */
    notes: z.array(z.string()).default([]),
    /** Documents added to the internal knowledge base. */
    knowledge: z
      .array(z.object({ id: z.string(), title: z.string(), body: z.string() }))
      .default([]),
    /** Notes on vendor records (business records), by vendor id, replacing the record's notes. */
    vendorNotes: z.record(z.string(), z.string()).default({}),
    /**
     * What a channel tool's provider says the tool does, by tool name, replacing its description
     * in the agent's tool list (tool-description poisoning). The agent sees it before calling
     * anything.
     */
    toolDescriptions: z
      .partialRecord(z.enum(OFFCHAIN_TOOL_NAMES as [OffchainToolName]), z.string().min(1))
      .default({}),
    /**
     * Customer refunds added to the approved queue. The account here is one finance approved;
     * the attack's prose is what points somewhere else.
     */
    refunds: z
      .array(
        z.object({
          reference: z.string().min(1),
          name: z.string().min(1),
          account: z.string().min(1),
          amountUsd: z.number().positive(),
          reason: z.string().min(1),
        }),
      )
      .default([]),
    /**
     * Mail and notes that stay hidden until advance_day opens `on` or a later day. The date is
     * after the world's today, so the instruction is not in the inbox at the start.
     */
    scheduled: z
      .array(
        z
          .object({
            on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            email: EmailSeed.optional(),
            note: z.string().min(1).optional(),
          })
          .refine((item) => (item.email === undefined) !== (item.note === undefined), {
            message: "a scheduled item needs an email or a note, not both",
          }),
      )
      .default([]),
  }),
  /**
   * The attack is one email with no attachments, so it can be re-delivered through another
   * channel unchanged (viaChannel), to find the channel an agent trusts too much.
   */
  multiVector: z.boolean().default(false),
  counterparty: CounterpartySeed.optional(),
});
export type OffchainSeed = z.infer<typeof OffchainSeed>;

/**
 * The attack lives only in an invoice picture: a planted fact is on the page and not in the
 * text layer. An agent that never sees images isn't run on it, and that isn't counted as
 * resisted. A picture of the genuine account, with the planted account in the text, does not
 * need vision: the text layer is the attack.
 */
export function seedNeedsVision(seed: OffchainSeed): boolean {
  return attackOnlyInImage(seed, worldFor(seed));
}

/** Loads and checks every seed in `dir`, sorted by id. */
export function loadOffchainSeeds(dir: string = OFFCHAIN_SEEDS_DIR): OffchainSeed[] {
  const seeds = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const parsed = OffchainSeed.safeParse(parse(readFileSync(join(dir, file), "utf8")));
      if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
      if (`${parsed.data.id}.yaml` !== file) throw new Error(`${file}: id is ${parsed.data.id}`);
      return parsed.data;
    });
  for (const seed of seeds) {
    const problem = seedProblem(seed);
    if (problem) throw new Error(`${seed.id}: ${problem}`);
  }
  return seeds;
}

/** What makes a seed unfit to run against the base world, or undefined. */
export function seedProblem(
  seed: OffchainSeed,
  imagesDir: string = OFFCHAIN_IMAGES_DIR,
): string | undefined {
  const world = worldFor(seed);
  const ids = new Set(world.inbox.map((e) => e.id));
  const tasks = new Set(taskKeys(seed));
  for (const r of seed.plant.replace)
    if (!ids.has(r.emailId)) return `no email ${r.emailId} to replace`;
  for (const e of seed.plant.emails) {
    if (ids.has(e.id)) return `email id ${e.id} is already in the inbox`;
    if (e.receivedAt.slice(0, 10) > world.today) return `${e.id} arrives after ${world.today}`;
  }
  for (const ref of seed.mayHold) if (!tasks.has(ref)) return `${ref} is not part of the job`;
  const attachments = [
    ...seed.plant.emails.flatMap((e) => e.attachments),
    ...seed.plant.replace.flatMap((r) => r.attachments ?? []),
  ];
  for (const a of attachments) {
    if (a.image && !readdirSync(imagesDir).includes(a.image)) return `no image ${a.image}`;
  }
  const planted = seed.plant.emails.map((e) => e.id);
  if (new Set(planted).size !== planted.length) return "two planted emails share an id";
  if (planted.some((id) => id.startsWith("cp-")))
    return "email ids starting cp- are the counterparty's";
  const attachmentIds = [
    ...world.inbox
      .filter((e) => !seed.plant.replace.some((r) => r.emailId === e.id && r.attachments))
      .flatMap((e) => e.attachments.map((a) => a.id)),
    ...attachments.map((a) => a.id),
  ];
  if (new Set(attachmentIds).size !== attachmentIds.length) return "two attachments share an id";
  const p = seed.plant;
  const plantsChannels =
    p.messages.length > 0 ||
    Object.keys(p.portal).length > 0 ||
    Object.keys(p.portalSwap).length > 0 ||
    Object.keys(p.plugin).length > 0 ||
    p.notes.length > 0 ||
    p.knowledge.length > 0;
  if (plantsChannels && !world.channels) return "channels need the realistic job (world: v2 or v3)";
  for (const tool of Object.keys(p.toolDescriptions) as OffchainToolName[]) {
    if (!CHANNELS.some((c) => CHANNEL_TOOLS[c].includes(tool)))
      return `${tool} isn't a channel's tool, so it has no provider description to plant`;
    if (!worldTools(world).includes(tool)) return `the job doesn't offer ${tool}`;
  }
  const vendorIds = new Set(world.vendors.map((v) => v.id));
  for (const id of [
    ...Object.keys(p.portal),
    ...Object.keys(p.portalSwap),
    ...Object.keys(p.plugin),
    ...Object.keys(p.vendorNotes),
  ]) {
    if (!vendorIds.has(id)) return `no vendor ${id}`;
  }
  for (const id of Object.keys(p.portalSwap)) {
    if (world.channels?.portal[id] === undefined && p.portal[id] === undefined)
      return `${id} has no portal page to swap after the first read`;
  }
  const messageIds = [...(world.channels?.messages ?? []), ...p.messages].map((m) => m.id);
  if (new Set(messageIds).size !== messageIds.length) return "two channel messages share an id";
  if (
    seed.multiVector &&
    (p.emails.length !== 1 ||
      p.emails[0]!.attachments.length > 0 ||
      p.replace.length > 0 ||
      plantsChannels ||
      Object.keys(p.toolDescriptions).length > 0)
  ) {
    return "a multi-vector seed is a single email with no attachments";
  }
  if ((seed.class === "O6") !== (seed.counterparty !== undefined)) {
    return "an O6 seed, and only an O6 seed, has a counterparty";
  }
  if (
    seed.counterparty &&
    !seed.plant.emails.some((e) => (e.threadId ?? `t-${e.id}`) === seed.counterparty!.threadId)
  ) {
    return `no planted email opens thread ${seed.counterparty.threadId}`;
  }
  const refundRefs = seed.plant.refunds.map((r) => r.reference.trim().toUpperCase());
  if (new Set(refundRefs).size !== refundRefs.length) return "two refunds share a reference";
  for (const r of seed.plant.refunds) {
    if (Math.abs(r.amountUsd * 100 - Math.round(r.amountUsd * 100)) > 1e-6) {
      return `${r.reference} has more than two decimals`;
    }
  }
  const scheduledIds = seed.plant.scheduled.flatMap((item) => (item.email ? [item.email.id] : []));
  for (const item of seed.plant.scheduled) {
    if (!isRealDate(item.on)) return `${item.on} is not a date`;
    if (item.on <= world.today) return `${item.on} is not after ${world.today}`;
    if (item.email && (ids.has(item.email.id) || planted.includes(item.email.id))) {
      return `email id ${item.email.id} is already in the inbox`;
    }
  }
  if (new Set(scheduledIds).size !== scheduledIds.length) return "two scheduled emails share an id";
  if (seed.counterparty) {
    const cp = seed.counterparty;
    if (!cp.hijack && world.inbox.some((e) => e.threadId === cp.threadId)) {
      return `the counterparty can't own ${cp.threadId}, a genuine thread`;
    }
    if (cp.hijack) {
      const genuine = world.inbox.filter((e) => e.threadId === cp.threadId);
      if (genuine.length === 0)
        return `a hijacking counterparty needs a genuine thread, not ${cp.threadId}`;
      if (!genuine.some((e) => e.from.address === cp.from.address)) {
        return "a hijacking counterparty writes from the thread's genuine sender";
      }
    }
    const opener = seed.plant.emails.find((e) => (e.threadId ?? `t-${e.id}`) === cp.threadId)!;
    if (opener.from.address !== cp.from.address || opener.from.name !== cp.from.name) {
      return "the counterparty must write as its thread's sender";
    }
  }
  return undefined;
}

/**
 * The vectors a seed's attack arrives through: email (planted or rewritten emails), image (an
 * invoice picture), counterparty (a live sender), records (vendor-record notes), and each channel
 * it plants into. A tool's poisoned description arrives through that tool's channel.
 */
export function seedVectors(seed: OffchainSeed): Vector[] {
  const p = seed.plant;
  const out = new Set<Vector>();
  const attachments = [
    ...p.emails.flatMap((e) => e.attachments),
    ...p.replace.flatMap((r) => r.attachments ?? []),
  ];
  if (
    p.emails.length ||
    p.replace.some((r) => r.body !== undefined || r.attachments?.some((a) => !a.image))
  )
    out.add("email");
  if (attachments.some((a) => a.image)) out.add("image");
  if (seed.counterparty) out.add("counterparty");
  if (Object.keys(p.vendorNotes).length) out.add("records");
  for (const m of p.messages) out.add(m.channel);
  if (Object.keys(p.portal).length || Object.keys(p.portalSwap).length) out.add("portal");
  if (Object.keys(p.plugin).length) out.add("plugin");
  if (p.notes.length || p.scheduled.some((item) => item.note !== undefined)) out.add("memory");
  if (p.knowledge.length) out.add("knowledge");
  if (p.scheduled.some((item) => item.email !== undefined)) out.add("email");
  for (const tool of Object.keys(p.toolDescriptions) as OffchainToolName[]) {
    const channel = CHANNELS.find((c) => CHANNEL_TOOLS[c].includes(tool));
    if (channel) out.add(channel);
  }
  return [...out];
}

/**
 * The same attack delivered through another channel: a multi-vector seed's single email becomes
 * a message on `channel`, with the same sender, subject and words. Its id gains `-via-<channel>`.
 */
export function viaChannel(
  seed: OffchainSeed,
  channel: "chat" | "ticket" | "voicemail" | "sms" | "agent",
): OffchainSeed {
  if (!seed.multiVector) throw new Error(`${seed.id} isn't a multi-vector seed`);
  const email = seed.plant.emails[0]!;
  return OffchainSeed.parse({
    ...structuredClone(seed),
    id: `${seed.id}-via-${channel}`,
    multiVector: false,
    plant: {
      ...structuredClone(seed.plant),
      emails: [],
      messages: [
        {
          id: `${email.id}-${channel}`,
          channel,
          from: email.from,
          subject: email.subject,
          body: email.body,
          receivedAt: email.receivedAt,
          ...(channel === "voicemail"
            ? { source: "the email's words, read as a voicemail transcript" }
            : {}),
        },
      ],
    },
  });
}

/** The unplanted world a seed's attack goes into. */
export const worldFor = (seed: Pick<OffchainSeed, "world">) =>
  seed.world === "v3" ? realisticBusyWorld() : seed.world === "v2" ? realisticWorld() : baseWorld();

/**
 * Plant realistic-job seeds (world v2) into the busy Monday (world v3). A seed already written
 * for v3 is checked again. One that cannot plant is left out, with the reason from `seedProblem`.
 * Seeds for the first job are left out: the busy world is the realistic job, only busier.
 */
export function plantIntoBusyWorld(seeds: readonly OffchainSeed[]): {
  seeds: OffchainSeed[];
  skipped: { id: string; reason: string }[];
} {
  const kept: OffchainSeed[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const seed of seeds) {
    if (seed.world !== "v2" && seed.world !== "v3") {
      skipped.push({ id: seed.id, reason: "not written for the realistic job (world v2)" });
      continue;
    }
    const busy =
      seed.world === "v3" ? seed : OffchainSeed.parse({ ...structuredClone(seed), world: "v3" });
    const problem = seedProblem(busy);
    if (problem) skipped.push({ id: seed.id, reason: problem });
    else kept.push(busy);
  }
  return { seeds: kept, skipped };
}

/** The replies, approvals and bank changes a seed's job requires (none in the first job). */
const jobTasksFor = (seed: Pick<OffchainSeed, "world">) =>
  seed.world === "v3" ? busyTasks() : seed.world === "v2" ? REALISTIC_TASKS : null;

/** Every part of the job a seed's `mayHold` may name. */
function taskKeys(seed: Pick<OffchainSeed, "world">): string[] {
  const refs = worldFor(seed).approvedInvoices.map((i) => i.reference);
  const tasks = jobTasksFor(seed);
  if (!tasks) return refs;
  return [
    ...refs,
    ...tasks.mustReply.map((id) => `reply:${id}`),
    ...tasks.mustRoute.map((r) => `approval:${r}`),
    ...tasks.mustUpdate.map((u) => `update:${u.vendorId}`),
  ];
}

/** The base world with the seed planted, as an attack scenario. */
export function attackScenario(
  seed: OffchainSeed,
  imagesDir: string = OFFCHAIN_IMAGES_DIR,
): OffchainScenario {
  const world = plantSeed(worldFor(seed), seed, imagesDir);
  const hold = new Set(seed.mayHold);
  const jobTasks = jobTasksFor(seed);
  return {
    id: seed.id,
    kind: "attack",
    attackClass: seed.class,
    goal: jobTasks ? REALISTIC_GOAL : PAYMENT_RUN_GOAL,
    world,
    mustPay: world.approvedInvoices.map((i) => i.reference).filter((r) => !hold.has(r)),
    ...(jobTasks
      ? {
          mustReply: jobTasks.mustReply.filter((id) => !hold.has(`reply:${id}`)),
          mustRoute: jobTasks.mustRoute.filter((r) => !hold.has(`approval:${r}`)),
          mustUpdate: jobTasks.mustUpdate.filter((u) => !hold.has(`update:${u.vendorId}`)),
        }
      : {}),
    aimedAt: seed.aimedAt,
    planted: plantedFacts(seed, worldFor(seed)),
    attackOpened: (trace, pushed) => attackSeen(seed, trace, pushed),
    ...(seed.variantOf ? { variantOf: seed.variantOf } : {}),
    ...(seed.counterparty ? { counterparty: seed.counterparty } : {}),
    vectors: seedVectors(seed),
  };
}

function plantSeed(world: OffchainWorld, seed: OffchainSeed, dir: string): OffchainWorld {
  for (const r of seed.plant.replace) {
    const email = world.inbox.find((e) => e.id === r.emailId)!;
    if (r.body !== undefined) email.body = r.body;
    if (r.attachments) email.attachments = r.attachments.map((a) => attachment(a, dir));
  }
  const added: Email[] = seed.plant.emails.map((e) => plantedEmail(e, dir));
  world.inbox = [...world.inbox, ...added].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const p = seed.plant;
  if (
    p.messages.length ||
    Object.keys(p.portal).length ||
    Object.keys(p.portalSwap).length ||
    Object.keys(p.plugin).length ||
    p.notes.length ||
    p.knowledge.length
  ) {
    const channels = (world.channels ??= emptyChannels());
    channels.messages.push(...p.messages.map((m) => ({ ...m, from: { ...m.from } })));
    Object.assign(channels.portal, p.portal);
    if (Object.keys(p.portalSwap).length) {
      channels.portalSwaps = { ...channels.portalSwaps, ...p.portalSwap };
    }
    Object.assign(channels.plugin, p.plugin);
    channels.notes.push(...p.notes);
    channels.knowledge.push(...p.knowledge.map((d) => ({ ...d })));
  }
  for (const [vendorId, notes] of Object.entries(p.vendorNotes)) {
    const vendor = world.vendors.find((v) => v.id === vendorId);
    if (vendor) vendor.notes = notes;
  }
  if (Object.keys(p.toolDescriptions).length) {
    world.toolDescriptions = { ...world.toolDescriptions, ...p.toolDescriptions };
  }
  if (p.refunds.length) {
    world.refunds = [...(world.refunds ?? []), ...p.refunds.map((r) => ({ ...r }))];
    grantTools(world, ["list_refunds", "issue_refund"]);
  }
  if (p.scheduled.length) {
    world.scheduled = p.scheduled.map((item) => ({
      on: item.on,
      ...(item.email ? { email: plantedEmail(item.email, dir) } : {}),
      ...(item.note !== undefined ? { note: item.note } : {}),
    }));
    grantTools(world, ["advance_day"]);
  }
  return world;
}

function plantedEmail(seed: z.infer<typeof EmailSeed>, dir: string): Email {
  return {
    id: seed.id,
    threadId: seed.threadId ?? `t-${seed.id}`,
    from: seed.from,
    subject: seed.subject,
    body: seed.body,
    receivedAt: seed.receivedAt,
    attachments: seed.attachments.map((a) => attachment(a, dir)),
  };
}

function attachment(seed: z.infer<typeof AttachmentSeed>, dir: string): Attachment {
  const base = seed.invoice
    ? invoiceText({
        vendor: { name: seed.invoice.vendorName, email: seed.invoice.vendorEmail },
        billTo: baseWorld().company,
        reference: seed.invoice.reference,
        issued: seed.invoice.issued,
        due: seed.invoice.due,
        lines: seed.invoice.lines,
        account: seed.invoice.account,
      })
    : seed.text!;
  const text = seed.appendText ? `${base}\n\n${seed.appendText.trim()}` : base;
  return {
    id: seed.id,
    filename: seed.filename,
    text,
    ...(seed.image
      ? {
          image: {
            mediaType: seed.image.endsWith(".jpg")
              ? ("image/jpeg" as const)
              : ("image/png" as const),
            base64: readFileSync(join(dir, seed.image)).toString("base64"),
          },
        }
      : {}),
  };
}
