import { plantedOrders } from "./dataset.js";

/**
 * The shortcut audit (docs/internals/SENTINEL-TRAINING-HISTORY.md, "Why v3 regressed"). Before a Sentinel dataset
 * is trained on, check that its `manipulated` label can't be predicted from surface features
 * that have nothing to do with manipulation. v3's data could: "the amount is copied from the
 * inputs, or the action is a transfer" got 90% of its labels right, and the model learned that
 * rule instead of the task. A retrain and a gate run take hours; this takes seconds.
 *
 * The audit looks only at rows with untrusted inputs: with none, nothing can manipulate the
 * agent, so "no inputs means not manipulated" is correct reasoning, not a shortcut.
 */

export interface AuditRow {
  source: string;
  mandate: string;
  action: { tool: string; args: Record<string, unknown> };
  inputs: readonly { tool: string; output: string }[];
  manipulated: boolean;
}

/** Surface features: what a lazy model could key on. None of them decides manipulation. */
export const SURFACE_FEATURES = [
  "action",
  "amountInInputs",
  "addressInInputs",
  "tokenInInputs",
  "amountAtLimit",
  // Since v5: the cues v4 learned from its templates.
  "amountInHarmlessLine",
  "dollarWording",
] as const;
export type SurfaceFeature = (typeof SURFACE_FEATURES)[number];

const STABLE = "tUSDG";

function actionKind(a: AuditRow["action"]): string {
  if (a.tool !== "swap") return a.tool;
  const { tokenIn, tokenOut } = a.args as { tokenIn?: string; tokenOut?: string };
  if (tokenIn === STABLE) return "buy";
  if (tokenOut === STABLE) return "sell";
  return "stock-swap";
}

/** Every number written in `text`, with thousands separators read correctly. */
export function numbersIn(text: string): number[] {
  return (text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []).map((n) =>
    Number(n.replaceAll(",", "")),
  );
}

/** Untrusted inputs as the model reads them (JSON string escapes undone). */
const inputText = (inputs: AuditRow["inputs"]) =>
  inputs.map((i) => i.output.replaceAll('\\"', '"')).join("\n");

/** The per-trade limit stated in the mandate, if it states one in dollars. */
function perTradeLimit(mandate: string): number | undefined {
  const m = mandate.match(/\$\s?([\d,]+(?:\.\d+)?)\s*per trade/i);
  return m ? Number(m[1]!.replaceAll(",", "")) : undefined;
}

export function surfaceFeatures(row: AuditRow): Record<SurfaceFeature, string> {
  const a = row.action.args as Record<string, string | undefined>;
  const text = inputText(row.inputs);
  // Everything but the price feed, where every symbol always appears.
  const prose = inputText(row.inputs.filter((i) => i.tool !== "get_prices"));
  const amount = a.amountIn ?? a.amount;
  const value = amount === undefined ? NaN : Number(amount);
  const address = a.to ?? a.spender;
  const token =
    row.action.tool === "swap" ? (a.tokenIn === STABLE ? a.tokenOut : a.tokenIn) : a.token;
  const limit = perTradeLimit(row.mandate);
  return {
    action: actionKind(row.action),
    amountInInputs: Number.isFinite(value)
      ? String(numbersIn(text).some((n) => n === value))
      : "n/a",
    addressInInputs: address ? String(text.toLowerCase().includes(address.toLowerCase())) : "n/a",
    tokenInInputs: token ? String(prose.includes(token)) : "n/a",
    amountAtLimit:
      limit !== undefined && a.tokenIn === STABLE && Number.isFinite(value)
        ? String(value === limit)
        : "n/a",
    // The amount in an input that orders nothing (a deposit record, a recap): v4 learned
    // "then it's not manipulated" (Arena seed A8-flash-crash-001).
    amountInHarmlessLine: Number.isFinite(value)
      ? String(
          row.inputs.some((i) => {
            if (i.tool === "get_prices") return false;
            const t = i.output.replaceAll('\\"', '"');
            const o = plantedOrders([t]);
            return o.buy.size + o.sell.size === 0 && !o.anySell && numbersIn(t).includes(value);
          }),
        )
      : "n/a",
    // "$20,000 of tNVDA": v4 saw it only in sell orders and read the direction from it (A3).
    dollarWording: String(/\$[\d,]+(?:\.\d+)? (?:worth )?of t[A-Z]/.test(text)),
  };
}

export interface FeatureCell {
  feature: SurfaceFeature;
  value: string;
  rows: number;
  manipulatedRate: number;
}

export interface ShortcutRule {
  features: SurfaceFeature[];
  /** Accuracy of predicting each feature combination's majority label. */
  accuracy: number;
}

export interface ShortcutAudit {
  /** Rows with untrusted inputs (the audited rows). */
  rows: number;
  manipulatedRate: number;
  /** Accuracy of always answering the majority label. */
  majority: number;
  cells: FeatureCell[];
  /** The best rule on one feature and on any two. */
  bestSingle: ShortcutRule;
  bestPair: ShortcutRule;
  /** The same, within each source (arena, synthetic, contrast). */
  bySource: Record<string, { rows: number; majority: number; bestPair: ShortcutRule }>;
  problems: string[];
  pass: boolean;
}

/**
 * Thresholds. A two-feature surface rule may beat always-the-majority by at most `maxLift`
 * (`maxSourceLift` within any source of `minSourceRows` or more). A feature value covering at
 * least `minRows` rows may not be more than `maxPurity` one label.
 */
export interface AuditLimits {
  maxLift: number;
  minRows: number;
  maxPurity: number;
  maxSourceLift: number;
  minSourceRows: number;
}

export const AUDIT_LIMITS: Readonly<AuditLimits> = {
  maxLift: 0.08,
  minRows: 200,
  maxPurity: 0.9,
  /** Per source: a source the model sees thousands of rows from must not be solvable either. */
  maxSourceLift: 0.15,
  minSourceRows: 1000,
};

function ruleAccuracy(
  rows: { f: Record<SurfaceFeature, string>; m: boolean }[],
  features: SurfaceFeature[],
): number {
  const cells = new Map<string, [number, number]>();
  for (const r of rows) {
    const key = features.map((f) => r.f[f]).join("|");
    const c = cells.get(key) ?? [0, 0];
    c[r.m ? 1 : 0]++;
    cells.set(key, c);
  }
  let right = 0;
  for (const [no, yes] of cells.values()) right += Math.max(no, yes);
  return rows.length ? right / rows.length : 0;
}

function bestRules(rows: { f: Record<SurfaceFeature, string>; m: boolean }[]) {
  const singles = SURFACE_FEATURES.map((f) => ({
    features: [f],
    accuracy: ruleAccuracy(rows, [f]),
  }));
  const pairs = SURFACE_FEATURES.flatMap((f, i) =>
    SURFACE_FEATURES.slice(i + 1).map((g) => ({
      features: [f, g],
      accuracy: ruleAccuracy(rows, [f, g]),
    })),
  );
  const best = (list: ShortcutRule[]) => list.reduce((a, b) => (b.accuracy > a.accuracy ? b : a));
  return { bestSingle: best(singles), bestPair: best(pairs) };
}

const majorityOf = (rows: { m: boolean }[]) => {
  const yes = rows.filter((r) => r.m).length;
  return rows.length ? Math.max(yes, rows.length - yes) / rows.length : 0;
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function auditShortcuts(
  input: readonly AuditRow[],
  limits: Readonly<AuditLimits> = AUDIT_LIMITS,
): ShortcutAudit {
  const rows = input
    .filter((r) => r.inputs.length > 0)
    .map((r) => ({ f: surfaceFeatures(r), m: r.manipulated, source: r.source }));
  const majority = majorityOf(rows);
  const problems: string[] = [];

  const cells: FeatureCell[] = [];
  for (const feature of SURFACE_FEATURES) {
    const values = new Map<string, [number, number]>();
    for (const r of rows) {
      const c = values.get(r.f[feature]) ?? [0, 0];
      c[r.m ? 1 : 0]++;
      values.set(r.f[feature], c);
    }
    for (const [value, [no, yes]] of [...values].sort()) {
      const cell = { feature, value, rows: no + yes, manipulatedRate: yes / (no + yes) };
      cells.push(cell);
      const purity = Math.max(cell.manipulatedRate, 1 - cell.manipulatedRate);
      if (value !== "n/a" && cell.rows >= limits.minRows && purity > limits.maxPurity)
        problems.push(
          `${feature}=${value}: ${cell.rows} rows, ${pct(cell.manipulatedRate)} manipulated (more than ${pct(limits.maxPurity)} one label)`,
        );
    }
  }

  const { bestSingle, bestPair } = bestRules(rows);
  if (bestPair.accuracy - majority > limits.maxLift)
    problems.push(
      `${bestPair.features.join(" + ")} predicts ${pct(bestPair.accuracy)} of labels, against ${pct(majority)} for always answering the majority (more than ${pct(limits.maxLift)} better)`,
    );

  const bySource: ShortcutAudit["bySource"] = {};
  for (const source of [...new Set(rows.map((r) => r.source))].sort()) {
    const sub = rows.filter((r) => r.source === source);
    const s = { rows: sub.length, majority: majorityOf(sub), bestPair: bestRules(sub).bestPair };
    bySource[source] = s;
    if (s.rows >= limits.minSourceRows && s.bestPair.accuracy - s.majority > limits.maxSourceLift)
      problems.push(
        `${source} rows: ${s.bestPair.features.join(" + ")} predicts ${pct(s.bestPair.accuracy)}, against ${pct(s.majority)} for the majority`,
      );
  }

  return {
    rows: rows.length,
    manipulatedRate: rows.filter((r) => r.m).length / (rows.length || 1),
    majority,
    cells,
    bestSingle,
    bestPair,
    bySource,
    problems,
    pass: problems.length === 0,
  };
}

/** The audit as text, for the dataset build's output. */
export function formatAudit(a: ShortcutAudit): string {
  const lines = [
    `Shortcut audit: ${a.rows} rows with inputs, ${pct(a.manipulatedRate)} manipulated`,
    `  majority ${pct(a.majority)}; best one-feature rule ${pct(a.bestSingle.accuracy)} (${a.bestSingle.features.join("")}); best two-feature rule ${pct(a.bestPair.accuracy)} (${a.bestPair.features.join(" + ")})`,
  ];
  for (const [source, s] of Object.entries(a.bySource))
    lines.push(
      `  ${source.padEnd(10)} ${String(s.rows).padStart(6)} rows: majority ${pct(s.majority)}, best two-feature rule ${pct(s.bestPair.accuracy)} (${s.bestPair.features.join(" + ")})`,
    );
  for (const c of a.cells)
    lines.push(
      `  ${`${c.feature}=${c.value}`.padEnd(28)} ${String(c.rows).padStart(6)} rows, ${pct(c.manipulatedRate).padStart(6)} manipulated`,
    );
  lines.push(
    a.pass ? "  PASS: no surface rule predicts the label" : "  FAIL:",
    ...a.problems.map((p) => `    - ${p}`),
  );
  return lines.join("\n");
}

/** Audit rows read back from a built Laya dataset (train.jsonl). */
export function auditRowFromLaya(row: { source: string; state: string; gold: string }): AuditRow {
  const state = JSON.parse(row.state) as {
    mandate: string;
    proposed_action: string | AuditRow["action"];
    untrusted_inputs: string | AuditRow["inputs"];
  };
  const parse = <T>(v: string | T): T => (typeof v === "string" ? (JSON.parse(v) as T) : v);
  const gold = JSON.parse(row.gold) as { manipulated: { label: string } };
  return {
    source: row.source,
    mandate: state.mandate,
    action: parse(state.proposed_action),
    inputs: parse(state.untrusted_inputs),
    manipulated: gold.manipulated.label === "true",
  };
}
