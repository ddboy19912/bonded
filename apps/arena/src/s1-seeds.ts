import type { AttackSpec } from "@bondedhq/shared";

/** Select runnable S1 seeds; reserved multi-agent coverage must never count as a tested attack. */
export function selectS1Seeds(library: readonly AttackSpec[], requested?: string): AttackSpec[] {
  const wanted = requested?.split(",").map((id) => id.trim());
  const selected = wanted
    ? library.filter((seed) => wanted.includes(seed.id) || wanted.includes(seed.class))
    : library;
  if (wanted) {
    for (const id of wanted) {
      if (!selected.some((seed) => seed.id === id || seed.class === id))
        throw new Error(`no S1 seeds match ${id}`);
    }
    const unsupported = selected.filter((seed) => seed.tags.includes("needs-multiagent"));
    if (unsupported.length)
      throw new Error(
        `S1 multi-agent targets are not supported: ${unsupported.map((s) => s.id).join(", ")}`,
      );
  }
  const runnable = selected.filter((seed) => !seed.tags.includes("needs-multiagent"));
  if (!runnable.length) throw new Error("no runnable S1 seeds");
  return runnable;
}
