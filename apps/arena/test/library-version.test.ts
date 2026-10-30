import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ATTACK_LIBRARY_VERSION,
  canonicalHash,
  OFFCHAIN_LIBRARY_VERSION,
  TASK_SCORE_VERSION,
} from "@bondedhq/shared";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { ATTACKS_DIR } from "../src/attacks.js";
import { BENIGN_SEEDS_DIR, WORLD_TWINS_DIR } from "../src/benign.js";
import { MEMORY_SEEDS_DIR } from "../src/memory-observations.js";
import { S1_SEEDS_DIR } from "../src/s1-observations.js";
import { INDEX_VARIANTS_DIR } from "../src/offchain/index-sweep.js";
import { OFFCHAIN_SEEDS_DIR } from "../src/offchain/seeds.js";
import { WORLD_SEEDS_DIR } from "../src/world-observations.js";

/**
 * The seeds each attack library version was published with, as a fingerprint of their parsed
 * content (formatting and comments don't count). Add a line when you bump ATTACK_LIBRARY_VERSION.
 */
const FINGERPRINTS: Record<number, string> = {
  1: "0xed140dd3185c4b57ef18b2b90c62f08836342f41abe8a584da26ac818210195e",
  2: "0xb72e00fce49b5c3e97689695f39c6c83f958294a12b70bc0f18277de4c752304",
};

/** The benign twins each Task score version was published with (TASK_SCORE_VERSION). */
const TASK_FINGERPRINTS: Record<number, string> = {
  1: "0x7669c441c2e3e2756da8ad07a0f5311bd7cf2167ddb6b7096f4dfbeda083e32d",
  2: "0x258cc54e65d1bfaf1d6c2378910794ca53acb3bd9cbb8619762251a9c9030025",
  3: "0x21a65e2e2b3d13014a42f62faf46395b35d6e403d28233bcf63b6ab30ed81788",
};

/**
 * The off-chain seeds and Index variants each off-chain library version was published with
 * (OFFCHAIN_LIBRARY_VERSION). Version 1 is the library as the Index first used it, on Oct 26.
 */
const OFFCHAIN_FINGERPRINTS: Record<number, string> = {
  1: "0xef3542dfa735c12325a4c2645b3491c42bec29ccee8ccdb0c03b7036667039cc",
  2: "0x009e5b959bb10fcfe7b30ebb7c93c97f629095b602bea56fab5f589013134993",
};

/** Every seed file under the given folders, by path, parsed. */
function fingerprint(roots: Record<string, string>): string {
  const files: { path: string; seed: unknown }[] = [];
  for (const [name, dir] of Object.entries(roots))
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      files.push({
        path: `${name}/${relative(dir, path)}`,
        seed: parse(readFileSync(path, "utf8")),
      });
    }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return canonicalHash(files);
}

/**
 * The attack library's seed folders. Version 1 had three; the world-state seeds joined in
 * version 2.
 */
function seedFingerprint(): string {
  return fingerprint({
    attacks: ATTACKS_DIR,
    s1: S1_SEEDS_DIR,
    memory: MEMORY_SEEDS_DIR,
    world: WORLD_SEEDS_DIR,
  });
}

it("bumps the attack library version whenever a seed changes", () => {
  const actual = seedFingerprint();
  const recorded = FINGERPRINTS[ATTACK_LIBRARY_VERSION];
  expect(
    actual,
    recorded === undefined
      ? `ATTACK_LIBRARY_VERSION is ${ATTACK_LIBRARY_VERSION} but has no fingerprint: add ${ATTACK_LIBRARY_VERSION}: "${actual}" to FINGERPRINTS in this file.`
      : `The attack, S1 or memory seeds changed since attack library version ${ATTACK_LIBRARY_VERSION}. ` +
          "Bump ATTACK_LIBRARY_VERSION in packages/shared/src/library-version.ts (note what changed in its history), " +
          `then add ${ATTACK_LIBRARY_VERSION + 1}: "${actual}" to FINGERPRINTS here. Ratings on the old version then show ` +
          "as older on the leaderboard until `pnpm --filter @bonded/arena leaderboard refresh` re-rates them (docs/SCORING.md).",
  ).toBe(recorded);
});

it("never reuses a version for different seeds", () => {
  const values = Object.values(FINGERPRINTS);
  expect(new Set(values).size).toBe(values.length);
  expect(Math.max(...Object.keys(FINGERPRINTS).map(Number))).toBe(ATTACK_LIBRARY_VERSION);
});

it("bumps the Task score version whenever a benign twin changes", () => {
  // Version 3 added the world twins' folder.
  const actual = fingerprint({ benign: BENIGN_SEEDS_DIR, world: WORLD_TWINS_DIR });
  expect(
    actual,
    `The benign twins changed since Task score version ${TASK_SCORE_VERSION}. Bump TASK_SCORE_VERSION ` +
      "in packages/shared/src/library-version.ts (note what changed in its history), then add " +
      `${TASK_SCORE_VERSION + 1}: "${actual}" to TASK_FINGERPRINTS here.`,
  ).toBe(TASK_FINGERPRINTS[TASK_SCORE_VERSION]);
  const values = Object.values(TASK_FINGERPRINTS);
  expect(new Set(values).size).toBe(values.length);
  expect(Math.max(...Object.keys(TASK_FINGERPRINTS).map(Number))).toBe(TASK_SCORE_VERSION);
});

/** JSON with every object's keys sorted, so the hash ignores key order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
    );
  return value;
}

/**
 * The off-chain seeds and the Index variants, parsed, as one SHA-256. Not canonicalHash: that
 * takes whole numbers only, for the chain, and off-chain amounts carry cents.
 */
function offchainFingerprint(): string {
  const files: { path: string; seed: unknown }[] = [];
  for (const [name, dir] of Object.entries({
    offchain: OFFCHAIN_SEEDS_DIR,
    variants: INDEX_VARIANTS_DIR,
  }))
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      files.push({
        path: `${name}/${relative(dir, path)}`,
        seed: parse(readFileSync(path, "utf8")),
      });
    }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return `0x${createHash("sha256")
    .update(JSON.stringify(sorted(files)))
    .digest("hex")}`;
}

it("bumps the off-chain library version whenever an off-chain seed or Index variant changes", () => {
  const actual = offchainFingerprint();
  const recorded = OFFCHAIN_FINGERPRINTS[OFFCHAIN_LIBRARY_VERSION];
  expect(
    actual,
    recorded === undefined
      ? `OFFCHAIN_LIBRARY_VERSION is ${OFFCHAIN_LIBRARY_VERSION} but has no fingerprint: add ${OFFCHAIN_LIBRARY_VERSION}: "${actual}" to OFFCHAIN_FINGERPRINTS in this file.`
      : `The off-chain seeds or the Index variants changed since off-chain library version ${OFFCHAIN_LIBRARY_VERSION}. ` +
          "Bump OFFCHAIN_LIBRARY_VERSION in packages/shared/src/library-version.ts (note what changed in its history), " +
          `then add ${OFFCHAIN_LIBRARY_VERSION + 1}: "${actual}" to OFFCHAIN_FINGERPRINTS here. Index entries on the old version then show ` +
          'as such until they are re-rated (docs/OFFCHAIN.md, "The Bonded Index").',
  ).toBe(recorded);
});

it("never reuses an off-chain version for different seeds", () => {
  const values = Object.values(OFFCHAIN_FINGERPRINTS);
  expect(new Set(values).size).toBe(values.length);
  expect(Math.max(...Object.keys(OFFCHAIN_FINGERPRINTS).map(Number))).toBe(
    OFFCHAIN_LIBRARY_VERSION,
  );
});
