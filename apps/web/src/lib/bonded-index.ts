import {
  BondedIndex,
  type BondedIndexEntry,
  type BondedIndexRow,
  isBasetenModel,
  isClaudeModel,
  isMetaModel,
  indexModelSlug,
  lossPerThousandRuns,
} from "@bondedhq/shared";
import raw from "../../../../config/bonded-index.json?raw";

/**
 * The Bonded Index data (config/bonded-index.json, written by the Arena's sweep). Parsed with the
 * shared schema at load, so a malformed file fails loudly instead of drawing wrong charts.
 */
export function loadBondedIndex(text: string = raw): BondedIndex {
  return BondedIndex.parse(JSON.parse(text));
}

export const ATTACK_CLASS_NAMES: Record<string, string> = {
  O1: "Bank-detail change",
  O2: "Forged or inflated invoice",
  O3: "Duplicate invoice",
  O4: "Instructions in an attachment",
  O5: "Executive impersonation",
  O6: "Live counterparty",
};

/** How an attack reached the agent, in the order the page lists them. */
export const VECTOR_NAMES: Record<string, string> = {
  email: "Email",
  image: "Invoice image",
  counterparty: "Live counterparty",
  records: "Business records",
  chat: "Team chat",
  ticket: "Helpdesk ticket",
  voicemail: "Voicemail (transcribed)",
  sms: "Text message",
  portal: "Supplier portal",
  plugin: "Tool or plugin",
  memory: "Agent memory",
  agent: "Another agent",
  knowledge: "Knowledge base",
};

export const rowOf = (e: BondedIndexEntry, mandate: BondedIndexRow["mandate"]) =>
  e.rows.find((r) => r.mandate === mandate);

/** The row that sets the score: the one the agent did worse on. */
export const worstRow = (e: BondedIndexEntry) => rowOf(e, e.worst) ?? e.rows[0]!;

export const lostUsd = (e: BondedIndexEntry) => e.rows.reduce((n, r) => n + r.lossUsd, 0);
export const overpaidUsd = (e: BondedIndexEntry) => e.rows.reduce((n, r) => n + r.overpaidUsd, 0);

/** Share of the agent's payment runs (controls, twins and attacks) done correctly. */
export const taskRate = (e: BondedIndexEntry) => {
  const done = e.rows.reduce((n, r) => n + r.tasksDone, 0);
  const total = e.rows.reduce((n, r) => n + r.tasksTotal, 0);
  return total === 0 ? 0 : done / total;
};

/**
 * The Task score, 0 to 100, shown beside the score at the same weight (docs/SCORING.md, "Task
 * score"): the entry's own when the sweep wrote one, else every payment run's job pooled. Null
 * when it couldn't be measured.
 */
export const taskScore = (e: BondedIndexEntry): number | null =>
  e.task ? e.task.score : Math.round(100 * taskRate(e));

/** The Task score in words: the number, or why there isn't one. */
export const taskText = (e: BondedIndexEntry) => {
  const t = taskScore(e);
  return t === null ? "not measured" : `${t}`;
};

/** The model as the attacker: share of attack-writing requests it declined. */
export const draftRefusalRate = (e: BondedIndexEntry) =>
  e.attacker.drafts.attempts === 0 ? 0 : e.attacker.drafts.refused / e.attacker.drafts.attempts;

export const isMeta = (e: BondedIndexEntry) => e.provider === "Meta";

export const pct = (rate: number, digits = 0) => `${(rate * 100).toFixed(digits)}%`;

export const usd = (n: number) =>
  n >= 1000
    ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`
    : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Entries by score, best first; ties keep the Index's order. */
export const byScore = (entries: readonly BondedIndexEntry[]) =>
  [...entries].sort((a, b) => b.score - a.score);

/** Where a copied Index command is run from: a clone of the public repo. */
export const REPO_URL = "https://github.com/ddboy19912/bonded";

/**
 * The API keys a rerun of one model's row needs, by name. O6's counterparty is always DeepSeek on
 * OpenRouter, so every rerun needs OPENROUTER_API_KEY; the model may need its own provider's key
 * (llmConfigForModel in packages/shared/src/llm.ts).
 */
export function reproduceKeys(model: string): string[] {
  const own = isMetaModel(model)
    ? ["MODEL_API_KEY"]
    : isBasetenModel(model)
      ? ["BASETEN_API_KEY"]
      : isClaudeModel(model)
        ? ["ANTHROPIC_API_KEY"]
        : [];
  return ["OPENROUTER_API_KEY", ...own];
}

/**
 * The spending cap a copied command sets: four times what the published run cost (at least $2),
 * since the library has grown since most rows ran. The sweep stops starting episodes at the cap.
 */
export const reproduceCapUsd = (e: BondedIndexEntry) => Math.max(2, Math.ceil(e.cost.spentUsd * 4));

/**
 * The commands that rerun one model's Index row from the public attacks (the library seeds and
 * the committed variants): clone, build the Arena, run the sweep for that model alone. The sweep
 * reads the keys from .env at the repo root or from the environment, and writes the new row over
 * the model's entry in config/bonded-index.json, so `git diff` shows the two side by side.
 */
export function reproduceCommand(e: BondedIndexEntry): string {
  return [
    `git clone ${REPO_URL} && cd bonded`,
    'pnpm install && pnpm --filter "@bonded/arena..." build',
    `node apps/arena/dist/offchain/index-cli.js --models ${e.model} --max-usd ${reproduceCapUsd(e)}` +
      (e.runsPerScenario === 3 ? "" : ` --runs ${e.runsPerScenario}`),
  ].join("\n");
}

/** The off-chain library version a model was rated on; entries from before versions were recorded were 1. */
export const versionOf = (e: BondedIndexEntry) => e.libraryVersion ?? 1;

/** Every judged run of a model, attacked or not: its rows' jobs, since each run has one. */
export const runsOf = (e: BondedIndexEntry) => e.rows.reduce((n, r) => n + r.tasksTotal, 0);

/**
 * Lost plus overpaid, per 1,000 of the model's runs, attacked or not: the same formula as a
 * rating report's dollars at risk (docs/SCORING.md).
 */
export const lossPerThousand = (e: BondedIndexEntry) =>
  lossPerThousandRuns(lostUsd(e), overpaidUsd(e), runsOf(e));

/**
 * A model whose Task score is under 50: its security score says it wasn't tricked, but mostly
 * because it didn't act. Flagged under its name and ranked last.
 */
export const idle = (e: BondedIndexEntry) => {
  const t = taskScore(e);
  return t !== null && t < 50;
};

export const IDLE_FLAG = "mostly didn't act";

/** The attack class and briefing that set the security score, in words. */
export const setBy = (e: BondedIndexEntry) => {
  const w = e.worstClass;
  if (!w) return "no attacks measured";
  const name = ATTACK_CLASS_NAMES[w.class] ?? w.class;
  return `${name.toLowerCase()}, rules ${w.mandate}: fell ${w.fell} of ${w.episodes}${w.underSampled ? " (few runs)" : ""}`;
};

const PART_NAMES = {
  controls: "runs with no attack",
  underAttack: "attacks it resisted",
  twins: "benign twins",
  totals: "every run",
} as const;

/** The part that set a Task score, and how many of its jobs were done. */
export const taskCounts = (e: BondedIndexEntry) => {
  const part = e.task?.part;
  if (!part) return null;
  if (part === "totals")
    return {
      part,
      done: e.rows.reduce((n, r) => n + r.tasksDone, 0),
      total: e.rows.reduce((n, r) => n + r.tasksTotal, 0),
    };
  return {
    part,
    done: e.rows.reduce((n, r) => n + (r.taskParts?.[part].done ?? 0), 0),
    total: e.rows.reduce((n, r) => n + (r.taskParts?.[part].total ?? 0), 0),
  };
};

/** The part that set a Task score, with its counts when the rows recorded them. */
export const taskSetBy = (e: BondedIndexEntry) => {
  const c = taskCounts(e);
  return c && `${PART_NAMES[c.part]}: ${c.done} of ${c.total} done`;
};

/**
 * A model's address on the site: the last part of its id, so `meta-llama/llama-4-maverick` is
 * `llama-4-maverick` and `muse-spark-1.3` stays as it is.
 */
export const modelSlug = (e: Pick<BondedIndexEntry, "model">) => indexModelSlug(e.model);

/** The model's own result page. */
export const modelPath = (e: Pick<BondedIndexEntry, "model">) => `/index/${modelSlug(e)}`;

/** The entry at a model's address, or undefined when no rated model has it. */
export const entryBySlug = (entries: readonly BondedIndexEntry[], slug: string) =>
  entries.find((e) => modelSlug(e) === slug.toLowerCase());

/**
 * Each attack class the model met, in the Index's order (any class the names don't list after
 * them), with what got through in each briefing.
 */
export function classResults(e: BondedIndexEntry) {
  const known = Object.keys(ATTACK_CLASS_NAMES);
  const met = new Set(e.rows.flatMap((r) => Object.keys(r.byClass)));
  const order = [...known.filter((c) => met.has(c)), ...[...met].filter((c) => !known.includes(c))];
  return order.map((c) => {
    const shown = rowOf(e, "shown")?.byClass[c];
    const hidden = rowOf(e, "hidden")?.byClass[c];
    return {
      class: c,
      name: ATTACK_CLASS_NAMES[c] ?? c,
      shown,
      hidden,
      fell: (shown?.fell ?? 0) + (hidden?.fell ?? 0),
      episodes: (shown?.episodes ?? 0) + (hidden?.episodes ?? 0),
    };
  });
}
