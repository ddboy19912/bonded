import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInstructions } from "@bonded/demo-agents";
import { ATTACK_CLASSES, AttackSpec } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import {
  FileHeldOutLedger,
  freshHeldOut,
  isHeldOutId,
  loadAttackLibrary,
  MemoryHeldOutLedger,
  payloadHash,
  renderPayload,
  rewriteVariant,
  SeededRandom,
} from "../src/index.js";

const library = loadAttackLibrary();
const seed = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const byId = (id: string) => library.find((s) => s.id === id)!;
const stand = "0x000000000000000000000000000000000000dEaD";
const render = (spec: AttackSpec) =>
  renderPayload(spec.payloadTemplate, {
    attacker: stand,
    vault: stand,
    depositor: stand,
    lookalike: stand,
    amount: "5000",
    token: "tUSDG",
  });

describe("single-use held-out sets", () => {
  it("gives every class a variant, the same set for the same seed", async () => {
    const a = await freshHeldOut({ library, seed: seed(1) });
    const b = await freshHeldOut({ library, seed: seed(1) });
    expect(a.missing).toEqual([]);
    expect(a.attacks.map((s) => s.class).sort()).toEqual(Object.keys(ATTACK_CLASSES).sort());
    expect(b.attacks).toEqual(a.attacks);
    expect(a.heldOut).toEqual({ seed: seed(1), attacks: 10, source: "rewrite" });
    for (const spec of a.attacks) {
      expect(isHeldOutId(spec.id)).toBe(true);
      expect(AttackSpec.safeParse(spec).success).toBe(true);
      expect(spec.tags).toContain("held-out");
    }
  });

  it("never gives two ratings the same payload, even from the same seed", async () => {
    const ledger = new MemoryHeldOutLedger();
    const seen = new Set<string>();
    for (const n of [7, 7, 8, 9, 10]) {
      const { attacks } = await freshHeldOut({ library, seed: seed(n), ledger });
      for (const spec of attacks) {
        expect(seen.has(payloadHash(spec)), spec.id).toBe(false);
        seen.add(payloadHash(spec));
      }
    }
    expect(ledger.hashes.size).toBe(seen.size);
    // No variant is a published seed.
    for (const spec of library) expect(seen.has(payloadHash(spec))).toBe(false);
  });

  it("keeps the orders the reference agent reads, for every seed in the library", async () => {
    const { attacks, missing } = await freshHeldOut({ library, seed: seed(42), perClass: 4 });
    expect(missing).toEqual([]);
    // Every class contributes up to perClass picked seeds, whatever the library's size.
    const picked = Math.min(library.length, 4 * Object.keys(ATTACK_CLASSES).length);
    expect(attacks).toHaveLength(picked);
    for (const variant of attacks) {
      const kinds = findInstructions(render(variant)).map((i) => i.kind);
      // A price-feed seed carries prices instead of a readable order; either way it must
      // still carry the vector the reference agent acts on.
      const prices = Object.keys(variant.delivery.prices ?? {}).length > 0;
      expect(kinds.length > 0 || prices, variant.id).toBe(true);
    }
  });

  it("rewrites wording, tokens and amounts, consistently and within the mandate's cap", () => {
    const changed = new Set<string>();
    for (let n = 0; n < 12; n++) {
      const random = () => new SeededRandom(`test:${n}`);
      // The token-metadata attack sits on the token the goal buys: both move together.
      const a1 = rewriteVariant(byId("A1-token-metadata-001"), random());
      expect(a1.goal).toContain(a1.delivery.token);
      changed.add(a1.delivery.token!);
      // A retry loop under the per-trade cap stays under it; an oversize order stays over it.
      const loop = rewriteVariant(byId("A9-loop-003"), random());
      const amount = Number(
        /(?:swap|convert|exchange) ([0-9,]+) tUSDG/i
          .exec(loop.payloadTemplate)?.[1]
          ?.replaceAll(",", ""),
      );
      expect(amount).toBeLessThan(5_000);
      expect(amount).toBeGreaterThanOrEqual(4_300);
      const big = rewriteVariant(byId("A7-oversize-trade-004"), random());
      const size = Number(
        /buy ([0-9,]+) tUSDG/i.exec(big.payloadTemplate)?.[1]?.replaceAll(",", ""),
      );
      expect(size).toBeGreaterThan(5_000);
      // A spoofed price moves with its token, rescaled to that token's price level.
      const crash = rewriteVariant(byId("A3-price-crash-001"), random());
      const [symbol] = Object.keys(crash.delivery.prices!);
      expect(crash.payloadTemplate).toContain(symbol);
      // The default ask becomes a literal amount just under it.
      const otc = rewriteVariant(byId("A6-operator-impersonation-001"), random());
      expect(otc.payloadTemplate).not.toContain("{{amount}}");
      expect(otc.payloadTemplate).not.toBe(byId("A6-operator-impersonation-001").payloadTemplate);
      // The operator's real domain is never changed (an insider impersonation relies on it).
      expect(rewriteVariant(byId("A6-ceo-urgent-004"), random()).delivery.sender).toBe(
        "ceo@fund.example",
      );
    }
    expect(changed.size).toBeGreaterThan(1);
  });

  it("keeps a ledger in a file across runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bonded-ledger-"));
    try {
      const path = join(dir, "nested", "held-out-used.txt");
      const first = await freshHeldOut({
        library,
        seed: seed(3),
        ledger: new FileHeldOutLedger(path),
      });
      const reopened = new FileHeldOutLedger(path);
      const used = await reopened.used(first.attacks.map(payloadHash));
      expect(used.size).toBe(first.attacks.length);
      const second = await freshHeldOut({ library, seed: seed(3), ledger: reopened });
      const firstHashes = new Set(first.attacks.map(payloadHash));
      expect(second.attacks.some((s) => firstHashes.has(payloadHash(s)))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
