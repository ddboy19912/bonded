import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  ATTACKS_DIR,
  OFFCHAIN_ATTACK_CLASSES,
  OFFCHAIN_IMAGES_DIR,
  OFFCHAIN_SEEDS_DIR,
  isHeldOutSpec,
  loadAttackLibrary,
  loadOffchainSeeds,
  payloadHash,
  proseHash,
  seedVectors,
  type OffchainSeed,
} from "@bonded/arena";
import { DataApiStore, type Database } from "@bonded/db";
import { ATTACK_LIBRARY_VERSION, AttackSpec, OFFCHAIN_LIBRARY_VERSION } from "@bondedhq/shared";
import { Refused, handle } from "./refused.js";
import { RateLimiter } from "./rate-limit.js";
import type { DataKeys } from "./data-keys.js";

/**
 * Attack data (apps/api/DATA-API.md): the published attack library as a dataset, for testing and
 * training guard models. Library attacks only, from the two folders the repository publishes:
 * the on-chain library (attacks/) and the off-chain one (apps/arena/offchain-seeds/), with each
 * Muse Image forgery's metadata, plus the labelled on-chain episodes of those attacks still on
 * record (the same ones GET /episodes shows). Gated by a data API key and counted.
 *
 * Never in it: held-out attacks (on chain they live in the database; off chain on the drafting
 * machine, outside the repository), staged and generated seeds, fresh variants, and anything
 * under the ignored datasets/ and ratings/ folders. Three guards make that hold: only the two
 * library folders are read, ids that name a variant or a held-out attack are dropped, and every
 * answer is checked against the database's held-out ids and payload hashes before it is sent.
 */

export interface AttackDataOptions {
  keys: DataKeys;
  db: Database;
  now: () => number;
  /** Dataset exports per key per hour (default 60). */
  exportsPerHour: number;
  /** Trace pages per key per hour (default 600). */
  tracePagesPerHour: number;
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const repoPath = (path: string) => relative(REPO_ROOT, path).split("\\").join("/");

/** A library seed's id: no variant hash (`-f…`), re-delivery (`-via-…`) or round (`-r…`). */
export const LIBRARY_SEED_ID = /^O[1-6]-[a-z0-9-]+-\d{3}$/;

/** What the export must never contain: held-out ids and the hashes of held-out payloads. */
export interface HeldOutMarks {
  ids: ReadonlySet<string>;
  /** On-chain payload hashes (`payloadHash`) and off-chain prose hashes (`proseHash`). */
  hashes: ReadonlySet<string>;
}

/** An off-chain library seed as the dataset holds it, with its invoice pictures. */
function offchainItem(seed: OffchainSeed, imagesDir: string) {
  const file = join(OFFCHAIN_SEEDS_DIR, `${seed.id}.yaml`);
  const pictures = [
    ...seed.plant.emails.flatMap((e) => e.attachments),
    ...seed.plant.replace.flatMap((r) => r.attachments ?? []),
  ].flatMap((a) => (a.image ? [a.image] : []));
  return {
    id: seed.id,
    rail: "offchain" as const,
    class: seed.class,
    className: OFFCHAIN_ATTACK_CLASSES[seed.class],
    title: seed.title,
    description: seed.description,
    aimedAt: seed.aimedAt,
    vectors: seedVectors(seed),
    world: seed.world,
    mayHold: seed.mayHold,
    multiVector: seed.multiVector,
    plant: seed.plant,
    counterparty: seed.counterparty ?? null,
    images: [...new Set(pictures)].map((name) => {
      const path = join(imagesDir, name);
      const sidecar = `${path}.json`;
      return {
        file: name,
        path: repoPath(path),
        sha256: existsSync(path) ? sha256(readFileSync(path)) : null,
        // Made by Muse Image: the model, the prompt, the invoice it started from and the check
        // that the planted account reads back.
        forgery: existsSync(sidecar)
          ? (JSON.parse(readFileSync(sidecar, "utf8")) as unknown)
          : null,
      };
    }),
    libraryVersion: OFFCHAIN_LIBRARY_VERSION,
    source: { path: repoPath(file), sha256: sha256(readFileSync(file)) },
    proseHash: proseHash(seed),
  };
}

/** An on-chain library attack as the dataset holds it: the whole published spec. */
function onchainItem(spec: AttackSpec) {
  return {
    id: spec.id,
    rail: "onchain" as const,
    class: spec.class,
    title: spec.title,
    description: spec.description,
    surfaces: spec.surfaces,
    severity: spec.severityHint,
    tags: spec.tags,
    spec,
    libraryVersion: ATTACK_LIBRARY_VERSION,
    payloadHash: payloadHash(spec),
  };
}

/**
 * The public attack set: library seeds and attacks, less anything that is a variant, is marked
 * held out, or matches a held-out id or hash. Pure, so the guard can be tested on its own.
 */
export function publicAttacks(
  library: { offchain: readonly OffchainSeed[]; onchain: readonly AttackSpec[] },
  heldOut: HeldOutMarks,
  imagesDir: string = OFFCHAIN_IMAGES_DIR,
) {
  const offchain = library.offchain
    .filter(
      (s) =>
        LIBRARY_SEED_ID.test(s.id) &&
        !s.variantOf &&
        !heldOut.ids.has(s.id) &&
        !heldOut.hashes.has(proseHash(s)),
    )
    .map((s) => offchainItem(s, imagesDir));
  const onchain = library.onchain
    .filter(
      (a) => !isHeldOutSpec(a) && !heldOut.ids.has(a.id) && !heldOut.hashes.has(payloadHash(a)),
    )
    .map(onchainItem);
  return [...onchain, ...offchain];
}

/** Whether `text` names any held-out id or hash: the last check before an answer is sent. */
export function leaksHeldOut(text: string, heldOut: HeldOutMarks): boolean {
  for (const id of heldOut.ids) if (text.includes(id)) return true;
  for (const hash of heldOut.hashes) if (text.includes(hash)) return true;
  return false;
}

const exportQuery = z.strictObject({
  rail: z.enum(["onchain", "offchain"]).optional(),
  class: z
    .string()
    .regex(/^(A(10|[1-9])|O[1-6])$/)
    .optional(),
});
const tracesQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  // The snapshot from the first page, so later pages show the same rows.
  through: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
  attack: z
    .string()
    .regex(/^A(10|[1-9])-[a-z0-9-]{1,120}$/)
    .optional(),
});

export function attackDataRoutes(
  app: Hono,
  options: Partial<AttackDataOptions> & Pick<AttackDataOptions, "keys" | "db" | "now">,
) {
  const { keys, db, now } = options;
  const store = new DataApiStore(db);
  // The library is the repository's files: it changes only with a deploy, so it is read once, on
  // the first request.
  let loaded: { onchain: AttackSpec[]; offchain: OffchainSeed[]; publishedIds: string[] };
  const library = () => {
    if (!loaded) {
      const onchain = loadAttackLibrary(ATTACKS_DIR);
      loaded = {
        onchain,
        offchain: loadOffchainSeeds(OFFCHAIN_SEEDS_DIR),
        publishedIds: onchain.map((a) => a.id),
      };
    }
    return loaded;
  };
  const exports = new RateLimiter({
    perClient: options.exportsPerHour ?? 60,
    total: 10_000,
    windowMs: 3_600_000,
    now,
  });
  const traces = new RateLimiter({
    perClient: options.tracePagesPerHour ?? 600,
    total: 100_000,
    windowMs: 3_600_000,
    now,
  });
  const caller = async (c: Context, limiter: RateLimiter) => {
    const who = await keys.required(c);
    if (!limiter.allow(who.keyId))
      throw new Refused(429, "Too many attack data requests for this key. Try again in an hour.");
    await keys.count(who, "attacks");
  };

  /** Every held-out id and payload hash the database knows, retired ones too. */
  async function heldOutMarks(): Promise<HeldOutMarks> {
    const rows = await store.heldOutAttacks();
    const ids = new Set(rows.map((r) => r.id));
    const hashes = new Set<string>();
    for (const r of rows) {
      const spec = AttackSpec.safeParse(r.spec);
      if (spec.success) hashes.add(payloadHash(spec.data));
    }
    // Payloads used in single ratings' fresh held-out sets (only their hashes are kept).
    for (const h of await db.heldOutPayloadsUsed(library().onchain.map(payloadHash))) hashes.add(h);
    return { ids, hashes };
  }
  /** Send `body` only if it names nothing held out; otherwise refuse (fail closed). */
  const safeJson = (c: Context, body: unknown, heldOut: HeldOutMarks) => {
    const text = JSON.stringify(body);
    if (leaksHeldOut(text, heldOut)) {
      console.error("attack data export refused: it named a held-out attack");
      throw new Refused(503, "The attack data export is unavailable right now.");
    }
    c.header("Cache-Control", "no-store");
    return c.body(text, 200, { "Content-Type": "application/json; charset=utf-8" });
  };

  /** The library as a dataset: `?rail=onchain|offchain`, `?class=A4|O1`. */
  app.get(
    "/data/attacks",
    handle(async (c) => {
      await caller(c, exports);
      const q = exportQuery.parse(c.req.query());
      const heldOut = await heldOutMarks();
      const attacks = publicAttacks(library(), heldOut).filter(
        (a) => (!q.rail || a.rail === q.rail) && (!q.class || a.class === q.class),
      );
      return safeJson(
        c,
        {
          dataset: "bonded-attack-library",
          generatedAt: new Date(now()).toISOString(),
          libraryVersions: { onchain: ATTACK_LIBRARY_VERSION, offchain: OFFCHAIN_LIBRARY_VERSION },
          note: "Library attacks only. Held-out attacks, staged and generated seeds, fresh variants and private datasets are never included.",
          traces: "/data/attacks/traces",
          count: attacks.length,
          attacks,
        },
        heldOut,
      );
    }),
  );

  /**
   * Labelled traces: the on-chain episodes of library attacks still on record, newest first,
   * each with its label (breach or held) and its detail as GET /episodes/:id shows it. Off-chain
   * traces aren't published, so none are here.
   */
  app.get(
    "/data/attacks/traces",
    handle(async (c) => {
      await caller(c, traces);
      const q = tracesQuery.parse(c.req.query());
      const { publishedIds } = library();
      if (q.attack && !publishedIds.includes(q.attack))
        throw new Refused(404, "No such library attack.");
      const heldOut = await heldOutMarks();
      const through = q.through ?? (await db.latestEventId());
      const scope = {
        source: "library" as const,
        publishedIds,
        ...(q.attack ? { attackId: q.attack } : {}),
      };
      const counts = await db.episodeCounts(scope, through);
      const page = await db.episodes(scope, {
        through,
        counts,
        ...(q.page ? { page: q.page } : {}),
        limit: q.limit ?? 25,
      });
      const items = [];
      for (const s of page.items) {
        if (!s.attackId || !publishedIds.includes(s.attackId) || heldOut.ids.has(s.attackId))
          continue;
        const e = await db.episode(s.eventId);
        if (!e) continue;
        items.push({
          eventId: e.eventId,
          runId: e.runId,
          attackId: e.attackId,
          attackClass: e.attackClass,
          label: e.breached ? "breach" : "held",
          ruling: e.ruling,
          lossUsd: e.lossUsd,
          frozen: e.frozen,
          agent: e.agent,
          durationMs: e.durationMs,
          at: e.at,
          detail: e.detail,
        });
      }
      return safeJson(
        c,
        { items, page: page.page, pages: page.pages, total: page.total, through },
        heldOut,
      );
    }),
  );
}
