import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Replay protection: every gate decision the proxy has paid out, so the same receipt never pays
 * twice. A receipt is only accepted while it is fresh (`maxAgeSeconds`), so a decision only has
 * to be remembered that long; with a `path` (on the CVM's encrypted volume) the list survives a
 * restart within that window. The provider also dedupes on the decision id, a second line behind
 * this one.
 */
export class PayoutLedger {
  private readonly paid = new Map<string, { payoutId: string; at: number }>();
  private readonly executing = new Set<string>();

  constructor(
    private readonly options: { path?: string; maxAgeSeconds: number; now: () => number },
  ) {
    if (!options.path || !existsSync(options.path)) return;
    const keep: string[] = [];
    for (const line of readFileSync(options.path, "utf8").split("\n")) {
      try {
        const e = JSON.parse(line) as { decisionId?: unknown; payoutId?: unknown; at?: unknown };
        if (
          typeof e.decisionId === "string" &&
          typeof e.payoutId === "string" &&
          typeof e.at === "number" &&
          this.fresh(e.at)
        ) {
          this.paid.set(e.decisionId, { payoutId: e.payoutId, at: e.at });
          keep.push(line);
        }
      } catch {
        // A torn last line from a crash: the provider's dedupe covers that one decision.
      }
    }
    writeFileSync(options.path, keep.length ? `${keep.join("\n")}\n` : "");
  }

  private fresh(at: number) {
    // Twice the receipt window, so nothing still acceptable is forgotten.
    return this.options.now() / 1000 - at <= 2 * this.options.maxAgeSeconds;
  }

  /** Claim a decision for payment: false when it was paid, or is being paid, already. */
  claim(decisionId: string): { ok: true } | { ok: false; payoutId?: string } {
    const done = this.paid.get(decisionId);
    if (done) return { ok: false, payoutId: done.payoutId };
    if (this.executing.has(decisionId)) return { ok: false };
    this.executing.add(decisionId);
    return { ok: true };
  }

  /**
   * The payout was made: remember it. In memory always; on disk too when there is a path (a
   * failed write is not fatal: the provider still dedupes the decision).
   */
  done(decisionId: string, payoutId: string): void {
    const at = Math.floor(this.options.now() / 1000);
    this.paid.set(decisionId, { payoutId, at });
    if (this.options.path)
      try {
        appendFileSync(this.options.path, `${JSON.stringify({ decisionId, payoutId, at })}\n`);
      } catch {
        // Kept in memory; after a restart the provider's dedupe is the remaining line.
      }
    this.executing.delete(decisionId);
    for (const [id, e] of this.paid) if (!this.fresh(e.at)) this.paid.delete(id);
  }

  /** Nothing was made, or it is unknown whether it was: the same receipt may be tried again. */
  release(decisionId: string): void {
    this.executing.delete(decisionId);
  }
}
