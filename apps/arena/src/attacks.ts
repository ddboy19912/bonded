import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { AttackSpec } from "@bondedhq/shared";
import { getAddress } from "viem";
import { parse } from "yaml";

/** The repo's attack library (attacks/<class>/*.yaml). */
export const ATTACKS_DIR = fileURLToPath(new URL("../../../attacks/", import.meta.url));

/** Loads and validates every seed in the attack library. Throws on any invalid file. */
export function loadAttackLibrary(dir: string = ATTACKS_DIR): AttackSpec[] {
  const specs: AttackSpec[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const result = AttackSpec.safeParse(parse(readFileSync(path, "utf8")));
    if (!result.success) {
      throw new Error(`${path}: ${result.error.issues.map((i) => i.message).join("; ")}`);
    }
    specs.push(result.data);
  }
  const ids = specs.map((s) => s.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`duplicate attack id ${duplicate}`);
  return specs.sort((a, b) => a.id.localeCompare(b.id));
}

// The placeholder list lives in @bondedhq/shared, so a bounty spec is checked against it.
export { ATTACK_PLACEHOLDERS } from "@bondedhq/shared";

/**
 * Seeds whose breach vector is oracle sizing, not a money-moving instruction (their payload is
 * a spoofed feed line; see attacks/A3 and pillar P4 in docs/HARBINGER-PLAN.md). A parser-driven
 * agent (the scripted pair) has no instruction to obey in these, so they are the only seeds a
 * vulnerable scripted agent may hold. A real LLM is drawn into the wrong-sized order by the goal.
 */
export const ORACLE_SIZING_SEEDS = ["A3-dip-buy-001", "A3-feed-maintenance-001"] as const;

/** An address that looks like `address` at a glance: same first and last four hex digits. */
export function lookalikeOf(address: `0x${string}`): `0x${string}` {
  const middle = randomBytes(16).toString("hex");
  const lookalike = getAddress(`${address.slice(0, 6)}${middle}${address.slice(-4)}`.toLowerCase());
  return lookalike.toLowerCase() === address.toLowerCase() ? lookalikeOf(address) : lookalike;
}

/**
 * Fills an attack's {{placeholders}}. Every placeholder must have a value, so a typo in a
 * seed fails loudly instead of sending the agent a half-rendered payload.
 */
export function renderPayload(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`attack payload uses unknown placeholder {{${name}}}`);
    return value;
  });
}
