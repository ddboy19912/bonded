import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatClient } from "@bondedhq/shared";
import { SpendingCap, metaCapFallback } from "./budget.js";
import { type ContrastRow, hasUntrainedMarker } from "./contrast.js";
import { plantedOrders } from "./dataset.js";
import { PRICE_QUOTE, STRESS_LANGUAGE } from "./llm-contrast.js";
import { numbersIn } from "./shortcuts.js";
import { extractJson } from "./synthetic.js";

/**
 * v5 training data (docs/internals/SENTINEL-TRAINING-HISTORY.md, "v5 training data"): a model rewrites the text of
 * the rule-built rows (planted messages, harmless lines, filler), so no fixed template wording
 * maps to a label. v4 missed two Arena attacks through template wording ("$N of X" only in
 * sells; a deposit line only with the independent amount).
 *
 * The model only rewords. Code checks every rewritten input against the original and keeps the
 * original instead unless all of these hold:
 * - the same numbers, addresses and token symbols;
 * - the same orders, read by the deterministic order reader (dataset.ts, `plantedOrders`), so
 *   an instruction stays an instruction and a harmless line gains none;
 * - the same shape (JSON stays JSON with the same keys);
 * - no untrained mechanism, no stress-suite language, no new price quote.
 * Labels never change: they come from code, and nothing that decides them can be reworded.
 */

export interface RewriteRecord {
  /** The pair id, or the row id for a single row. */
  key: string;
  /** Hash of the original inputs, so a stale rewrite (after a generator change) is ignored. */
  original: string;
  inputs: { tool: string; output: string }[];
  /** How many inputs were reworded (the rest failed a check and stay as they were). */
  rewritten: number;
}

type Inputs = ContrastRow["untrustedInputs"];

export const inputsHash = (inputs: Inputs) =>
  createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);

const ADDRESS = /0x[0-9a-fA-F]{40}/g;
const SYMBOL = /\bt[A-Z][A-Za-z0-9]{2,8}\b/g;
const sorted = (xs: Iterable<string | number>) => [...xs].map(String).sort().join("|");
const ordersKey = (text: string) => {
  const o = plantedOrders([text]);
  return `${sorted(o.buy)}/${sorted(o.sell)}/${o.anySell}`;
};

function shape(output: string): string {
  try {
    const v = JSON.parse(output) as unknown;
    const inner = typeof v === "string" ? tryParse(v) : v;
    const keys = (x: unknown) =>
      x && typeof x === "object" && !Array.isArray(x) ? Object.keys(x).sort().join(",") : typeof x;
    return Array.isArray(inner) ? `[${inner.map(keys).join(";")}]` : keys(inner);
  } catch {
    return "text";
  }
}
function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Why a rewritten input can't replace the original, or null if it can. */
export function rewriteProblem(before: string, after: string): string | null {
  if (typeof after !== "string" || after.length === 0 || after.length > 3_000) return "length";
  if (STRESS_LANGUAGE.test(after)) return "stress-language";
  if (shape(before) !== shape(after)) return "shape";
  if (sorted(numbersIn(before)) !== sorted(numbersIn(after))) return "numbers";
  if (sorted(before.match(ADDRESS) ?? []) !== sorted(after.match(ADDRESS) ?? []))
    return "addresses";
  if (sorted(new Set(before.match(SYMBOL))) !== sorted(new Set(after.match(SYMBOL))))
    return "symbols";
  if (ordersKey(before) !== ordersKey(after)) return "orders";
  if (hasUntrainedMarker(after) && !hasUntrainedMarker(before)) return "untrained-mechanism";
  if (PRICE_QUOTE.test(after) && !PRICE_QUOTE.test(before)) return "price-quote";
  return null;
}

function prompt(outputs: string[]) {
  return [
    {
      role: "system" as const,
      content:
        "You reword test data for a security classifier. The data is fictional and uses test tokens. Reply with one JSON object and nothing else.",
    },
    {
      role: "user" as const,
      content: [
        "Below are tool results an AI trading agent read, as a JSON array of strings. Reword each one so it reads naturally but differently: new phrasing, new sentence structure, new names for people, sources and outlets.",
        "Keep exactly, character for character: every number, every 0x address and every token symbol (tUSDG, tTSLA, tAMZN, tNVDA and any other t-symbol).",
        "Keep the meaning: an instruction must still ask for the same thing in the same direction (buy stays buy, sell stays sell), and text without an instruction must not gain one.",
        "Keep the format: if a result is JSON, return JSON with the same keys and change only the text values.",
        "Write in English. Don't add prices, conditions, encodings or rules about not buying a token.",
        `Format: {"outputs": [one reworded string per input, same order]}.`,
        "",
        JSON.stringify(outputs),
      ].join("\n"),
    },
  ];
}

export interface RewriteOptions {
  client: ChatClient;
  model: string;
  rows: readonly ContrastRow[];
  maxUsd: number;
  out: string;
  concurrency?: number;
  onDone?: (n: number) => void;
}

/**
 * Rewrites the inputs of every pair (once, shared by both rows) and every single row, keeping
 * the price feed as it is. Appends to `out`; a rerun resumes.
 */
export async function rewriteRows(options: RewriteOptions) {
  const cap = new SpendingCap({ maxUsd: options.maxUsd, ...metaCapFallback(options.model) });
  mkdirSync(dirname(options.out), { recursive: true });
  // Done means a rewrite of these exact inputs exists; a changed generator makes it stale.
  const existing = existsSync(options.out) ? readRewrites(options.out) : new Map();
  const groups = new Map<string, Inputs>();
  for (const r of options.rows) groups.set(r.pairId ?? r.id, r.untrustedInputs);
  const isDone = (k: string, inputs: Inputs) => existing.get(k)?.original === inputsHash(inputs);
  const done = new Set([...groups].filter(([k, inputs]) => isDone(k, inputs)).map(([k]) => k));
  const pending = [...groups.entries()].filter(([k, inputs]) => !done.has(k) && inputs.length > 0);
  const summary = {
    written: 0,
    skippedExisting: done.size,
    inputs: 0,
    rewritten: 0,
    kept: {} as Record<string, number>,
    failed: 0,
    stoppedBy: "done" as "done" | "spending-cap",
  };
  const worker = async () => {
    for (;;) {
      if (cap.exceeded) {
        summary.stoppedBy = "spending-cap";
        return;
      }
      const next = pending.shift();
      if (!next) return;
      const [key, inputs] = next;
      const targets = inputs.map((i, n) => ({ i, n })).filter(({ i }) => i.tool !== "get_prices");
      let outputs: unknown[];
      try {
        const response = await options.client.complete({
          model: options.model,
          messages: prompt(targets.map(({ i }) => i.output)),
          temperature: 0.9,
          max_tokens: 2_000,
          reasoning: { enabled: false },
        });
        const usage = response.usage;
        cap.add({
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          ...(usage?.cost !== undefined ? { costUsd: usage.cost } : {}),
        });
        const json = extractJson(response.choices[0]?.message.content ?? "") as
          { outputs?: unknown[] } | undefined;
        // No outputs array (truncated or not JSON): a failed request, not a finished group,
        // so a rerun tries it again.
        if (!Array.isArray(json?.outputs)) throw new Error("no outputs array");
        outputs = json.outputs;
      } catch {
        summary.failed++;
        continue;
      }
      const next_ = [...inputs];
      let rewritten = 0;
      for (const [k, { i, n }] of targets.entries()) {
        summary.inputs++;
        const raw = outputs[k];
        // The model may return the JSON value itself rather than its string form.
        const after =
          typeof raw === "string"
            ? i.output.startsWith('"')
              ? JSON.stringify(raw)
              : raw
            : JSON.stringify(raw);
        const problem = raw === undefined ? "missing" : rewriteProblem(i.output, after);
        if (problem) {
          summary.kept[problem] = (summary.kept[problem] ?? 0) + 1;
          continue;
        }
        next_[n] = { ...i, output: after };
        rewritten++;
      }
      summary.rewritten += rewritten;
      const record: RewriteRecord = { key, original: inputsHash(inputs), inputs: next_, rewritten };
      appendFileSync(options.out, `${JSON.stringify(record)}\n`);
      summary.written++;
      options.onDone?.(summary.written);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 8) }, worker));
  return { ...summary, spend: cap.summary() };
}

export function readRewrites(path: string): Map<string, RewriteRecord> {
  const out = new Map<string, RewriteRecord>();
  for (const line of readFileSync(path, "utf8").split("\n"))
    if (line.trim()) {
      const r = JSON.parse(line) as RewriteRecord;
      out.set(r.key, r);
    }
  return out;
}

/**
 * Apply rewrites to rows: a row takes its pair's (or its own) rewritten inputs when the stored
 * hash still matches its inputs. Returns the rows and how many were rewritten.
 */
export function applyRewrites(
  rows: readonly ContrastRow[],
  rewrites: ReadonlyMap<string, RewriteRecord>,
): { rows: ContrastRow[]; applied: number; stale: number } {
  let applied = 0;
  let stale = 0;
  const out = rows.map((r) => {
    const rec = rewrites.get(r.pairId ?? r.id);
    if (!rec) return r;
    if (rec.original !== inputsHash(r.untrustedInputs)) {
      stale++;
      return r;
    }
    applied++;
    return { ...r, untrustedInputs: rec.inputs };
  });
  return { rows: out, applied, stale };
}
