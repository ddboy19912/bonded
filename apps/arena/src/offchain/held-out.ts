import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatClient } from "@bondedhq/shared";
import { extractJson } from "../synthetic.js";
import { looksLikeRefusal } from "./counterparty.js";
import { saveVariants, seedProse, variantFromDraft, variantPrompt } from "./fresh.js";
import { INDEX_VARIANTS_DIR } from "./index-sweep.js";
import { OFFCHAIN_SEEDS_DIR, OFFCHAIN_STAGED_SEEDS_DIR, type OffchainSeed } from "./seeds.js";

/**
 * A private held-out set (docs/OFFCHAIN.md, issue #244 section 6). The published seeds and the
 * Index's committed variants are the same for everyone, so a model can be trained against them.
 * A held-out set is drafted for one rating and kept out of the repo: the texts an agent met are
 * not the texts the next rating uses. Two hash files make that hold: `ledger.txt` stops a draft
 * repeating prose already in the set, and `spent.txt` records every variant an agent has been
 * run against, so a later run skips it (unspentHeldOut, markSpent).
 *
 * Variants are still the fresh-variant rules (the same accounts, references and amounts, and far
 * enough from the seed's wording). The model writes; it does not judge. How many to draft is a
 * budget question: the cap stops the run, and one seed takes at most MAX_PER_SEED.
 */

/** Variants drafted per seed, at most. Across the library this is the "thousands" the issue asks for. */
export const MAX_PER_SEED = 200;

/**
 * Runs per mandate row when a result should rank models, rather than the Index's 3. Fifteen runs
 * in each briefing is 30 episodes a seed, which narrows the interval the Index's 6 cannot.
 * The Index default stays 3 so published rows stay comparable (CLAUDE.md, batch the bumps).
 */
export const RANKING_RUNS = 15;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Where a local run keeps a held-out set when no directory is given. Not in the repo. */
export function defaultHeldOutDir(): string {
  return join(homedir(), ".config", "bonded", "offchain-held-out");
}

const inside = (parent: string, child: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
};

/**
 * Refuses a directory the published attacks live in, or anywhere in the repo outside `ratings/`.
 * Text that can be committed is no longer private: a held-out set, a generated variant or a
 * finding's payload all stay out of the repository.
 */
export function assertPrivateDir(dir: string, what: string): void {
  const published = [OFFCHAIN_SEEDS_DIR, OFFCHAIN_STAGED_SEEDS_DIR, INDEX_VARIANTS_DIR];
  for (const place of published) {
    if (inside(place, dir)) {
      throw new Error(`${dir} is a published attack directory; ${what} stays private`);
    }
  }
  if (inside(REPO_ROOT, dir) && !relative(REPO_ROOT, resolve(dir)).split(sep).includes("ratings")) {
    throw new Error(`${dir} is inside the repo and not under ratings/; ${what} is not committed`);
  }
}

/** Refuses a directory the published attacks live in, or anywhere in the repo outside `ratings/`. */
export function assertHeldOutDir(dir: string): void {
  assertPrivateDir(dir, "a held-out set");
}

/** The prose a variant carries. Two variants with the same hash are the same attack text. */
export function proseHash(seed: OffchainSeed): string {
  return createHash("sha256")
    .update(JSON.stringify(seedProse(seed)))
    .digest("hex");
}

/** Prose hashes already used, one per line. The file is readable only by its owner. */
export class FileProseLedger {
  constructor(private readonly path: string) {}

  private read(): Set<string> {
    if (!existsSync(this.path)) return new Set();
    return new Set(readFileSync(this.path, "utf8").split("\n").filter(Boolean));
  }

  async used(hashes: readonly string[]): Promise<Set<string>> {
    const known = this.read();
    return new Set(hashes.filter((h) => known.has(h)));
  }

  async record(hashes: readonly string[]): Promise<void> {
    if (hashes.length === 0) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${hashes.join("\n")}\n`, { mode: 0o600 });
  }
}

/** Variants an agent has already been run against, by prose hash. */
const spentLedger = (dir: string) => new FileProseLedger(join(dir, "spent.txt"));

/**
 * The held-out variants in `dir` no agent has met yet, and how many were skipped because one
 * has. Refuses a directory that doesn't exist, rather than running nothing quietly.
 */
export async function unspentHeldOut(
  dir: string,
  variants: readonly OffchainSeed[],
): Promise<{ fresh: OffchainSeed[]; spent: number }> {
  if (!existsSync(dir))
    throw new Error(`no held-out set at ${dir}; draft one with --draft-held-out`);
  const used = await spentLedger(dir).used(variants.map(proseHash));
  const fresh = variants.filter((v) => !used.has(proseHash(v)));
  return { fresh, spent: variants.length - fresh.length };
}

/** Records variants as met by an agent, so the next run doesn't reuse them. */
export async function markSpent(dir: string, variants: readonly OffchainSeed[]): Promise<void> {
  await spentLedger(dir).record([...new Set(variants.map(proseHash))]);
}

export interface HeldOutNote {
  seed: string;
  reason: string;
}

/**
 * Drafts up to `perSeed` fresh variants of each seed into `dir`, skipping prose the ledger has
 * already recorded. `shouldStop` is the spending cap. Image-only seeds are skipped: there is no
 * prose to rewrite.
 */
export async function draftHeldOut(options: {
  seeds: readonly OffchainSeed[];
  perSeed: number;
  /** Attempts for each variant that is kept (default 2). */
  tries?: number;
  client: ChatClient;
  model: string;
  dir: string;
  ledger?: FileProseLedger;
  onUsage?: (usage: { inputTokens: number; outputTokens: number; costUsd?: number }) => void;
  shouldStop?: () => boolean;
}): Promise<{ kept: OffchainSeed[]; notes: HeldOutNote[] }> {
  if (!Number.isInteger(options.perSeed) || options.perSeed < 1 || options.perSeed > MAX_PER_SEED) {
    throw new Error(`perSeed must be an integer from 1 to ${MAX_PER_SEED}`);
  }
  assertHeldOutDir(options.dir);
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const ledger = options.ledger ?? new FileProseLedger(join(options.dir, "ledger.txt"));
  const tries = options.tries ?? 2;
  const kept: OffchainSeed[] = [];
  const notes: HeldOutNote[] = [];

  for (const seed of options.seeds) {
    if (Object.keys(seedProse(seed)).length === 0) {
      notes.push({
        seed: seed.id,
        reason: "nothing to rewrite: the attack is in the invoice or its image",
      });
      continue;
    }
    let made = 0;
    for (let slot = 0; slot < options.perSeed; slot++) {
      let reason = "no attempt";
      let saved = false;
      for (let attempt = 0; attempt < tries && !saved; attempt++) {
        if (options.shouldStop?.()) {
          notes.push({
            seed: seed.id,
            reason: `stopped at the spending cap with ${made} of ${options.perSeed}`,
          });
          return { kept, notes };
        }
        try {
          const response = await options.client.complete({
            model: options.model,
            messages: variantPrompt(seed),
            max_tokens: 4000,
            reasoning: { enabled: false },
          });
          options.onUsage?.({
            inputTokens: response.usage?.prompt_tokens ?? 0,
            outputTokens: response.usage?.completion_tokens ?? 0,
            ...(response.usage?.cost !== undefined ? { costUsd: response.usage.cost } : {}),
          });
          const text = response.choices[0]?.message.content ?? "";
          if (looksLikeRefusal(text)) {
            reason = `refused: ${text.trim().slice(0, 120)}`;
            continue;
          }
          const variant = variantFromDraft(seed, extractJson(text));
          const hash = proseHash(variant);
          if ((await ledger.used([hash])).has(hash)) {
            reason = "already in the held-out set";
            continue;
          }
          const file = join(options.dir, `${variant.id}.yaml`);
          if (existsSync(file)) {
            reason = `id ${variant.id} is already a file`;
            continue;
          }
          saveVariants(options.dir, [variant]);
          await ledger.record([hash]);
          kept.push(variant);
          made++;
          saved = true;
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      if (!saved) notes.push({ seed: seed.id, reason });
    }
  }
  return { kept, notes };
}
