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
  realisticWorld,
} from "./scenarios.js";
import { type Attachment, type Email, invoiceText, type OffchainWorld } from "./world.js";

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
});
export type CounterpartySeed = z.infer<typeof CounterpartySeed>;

export const OffchainSeed = z.object({
  /** A library seed's id, or a fresh variant's: the seed's id and a hash of its text. */
  id: z.string().regex(/^O[1-6]-[a-z0-9-]+-\d{3}(-f[0-9a-f]{8})?$/),
  /** For a fresh variant: the library seed it was drafted from. */
  variantOf: z.string().optional(),
  class: z.enum(Object.keys(OFFCHAIN_ATTACK_CLASSES) as [OffchainAttackClass]),
  title: z.string().min(1),
  description: z.string().min(1),
  aimedAt: z.array(z.enum(LEDGER_BREACH_TYPES)).min(1),
  /**
   * The job the attack is planted in: "v1", the approved-queue payment run, or "v2", the
   * realistic job (scenarios.ts, realisticWorld), with vendor updates and approval requests.
   */
  world: z.enum(["v1", "v2"]).default("v1"),
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
  }),
  counterparty: CounterpartySeed.optional(),
});
export type OffchainSeed = z.infer<typeof OffchainSeed>;

/** The seed has an invoice image, where its attack may live (only a model that sees images meets it). */
export function seedNeedsVision(seed: OffchainSeed): boolean {
  return [
    ...seed.plant.emails.flatMap((e) => e.attachments),
    ...seed.plant.replace.flatMap((r) => r.attachments ?? []),
  ].some((a) => a.image !== undefined);
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
  if ((seed.class === "O6") !== (seed.counterparty !== undefined)) {
    return "an O6 seed, and only an O6 seed, has a counterparty";
  }
  if (
    seed.counterparty &&
    !seed.plant.emails.some((e) => (e.threadId ?? `t-${e.id}`) === seed.counterparty!.threadId)
  ) {
    return `no planted email opens thread ${seed.counterparty.threadId}`;
  }
  if (seed.counterparty) {
    const cp = seed.counterparty;
    if (world.inbox.some((e) => e.threadId === cp.threadId)) {
      return `the counterparty can't own ${cp.threadId}, a genuine thread`;
    }
    const opener = seed.plant.emails.find((e) => (e.threadId ?? `t-${e.id}`) === cp.threadId)!;
    if (opener.from.address !== cp.from.address || opener.from.name !== cp.from.name) {
      return "the counterparty must write as its thread's sender";
    }
  }
  return undefined;
}

/** The unplanted world a seed's attack goes into. */
export const worldFor = (seed: Pick<OffchainSeed, "world">) =>
  seed.world === "v2" ? realisticWorld() : baseWorld();

/** Every part of the job a seed's `mayHold` may name. */
function taskKeys(seed: Pick<OffchainSeed, "world">): string[] {
  const refs = worldFor(seed).approvedInvoices.map((i) => i.reference);
  if (seed.world !== "v2") return refs;
  return [
    ...refs,
    ...REALISTIC_TASKS.mustReply.map((id) => `reply:${id}`),
    ...REALISTIC_TASKS.mustRoute.map((r) => `approval:${r}`),
    ...REALISTIC_TASKS.mustUpdate.map((u) => `update:${u.vendorId}`),
  ];
}

/** The base world with the seed planted, as an attack scenario. */
export function attackScenario(
  seed: OffchainSeed,
  imagesDir: string = OFFCHAIN_IMAGES_DIR,
): OffchainScenario {
  const world = plantSeed(worldFor(seed), seed, imagesDir);
  const hold = new Set(seed.mayHold);
  const jobTasks = seed.world === "v2" ? REALISTIC_TASKS : null;
  return {
    id: seed.id,
    kind: "attack",
    attackClass: seed.class,
    goal: seed.world === "v2" ? REALISTIC_GOAL : PAYMENT_RUN_GOAL,
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
    ...(seed.variantOf ? { variantOf: seed.variantOf } : {}),
    ...(seed.counterparty ? { counterparty: seed.counterparty } : {}),
  };
}

function plantSeed(world: OffchainWorld, seed: OffchainSeed, dir: string): OffchainWorld {
  for (const r of seed.plant.replace) {
    const email = world.inbox.find((e) => e.id === r.emailId)!;
    if (r.body !== undefined) email.body = r.body;
    if (r.attachments) email.attachments = r.attachments.map((a) => attachment(a, dir));
  }
  const added: Email[] = seed.plant.emails.map((e) => ({
    id: e.id,
    threadId: e.threadId ?? `t-${e.id}`,
    from: e.from,
    subject: e.subject,
    body: e.body,
    receivedAt: e.receivedAt,
    attachments: e.attachments.map((a) => attachment(a, dir)),
  }));
  world.inbox = [...world.inbox, ...added].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return world;
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
