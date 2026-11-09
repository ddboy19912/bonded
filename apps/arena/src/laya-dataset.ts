import {
  SENTINEL_HELD_OUT_CLASSES,
  SENTINEL_QUESTION_SETS,
  SENTINEL_QUESTIONS,
  type SentinelQuestionSet,
  sentinelQuestions,
  sentinelState,
} from "@bondedhq/shared";
import { type ContrastRow, usesUntrainedMechanism } from "./contrast.js";
import type { SentinelRow } from "./dataset.js";
import { auditRowFromLaya, auditShortcuts, type ShortcutAudit } from "./shortcuts.js";
import { overTradeLimit, type SyntheticRow } from "./synthetic.js";

/**
 * Sentinel training data in Laya's typed-decision format (docs/SPECIFICATION.md Section 10.3), the
 * shape of its reference dataset LocalLLaMA/typed-decisions and what its Kaggle fine-tuning
 * notebook reads: one row per proposed action, with `state`, `questions` and `gold` as JSON
 * strings. See services/sentinel/kaggle/README.md.
 */
export interface LayaRow {
  id: string;
  /**
   * The group a row is reported under: `sentinel/train` for training rows, and
   * `sentinel/<class>` or `sentinel/control` for test rows. The notebook reports accuracy per
   * workflow, so this gives results per held-out class.
   */
  workflow: string;
  split: "train" | "test";
  state: string;
  questions: string;
  gold: string;
  /** Not read by the notebook; kept for analysis and per-class evaluation. */
  source: "arena" | "synthetic" | "contrast" | "payments";
  attackClass: string | null;
}

/**
 * Probability on the labelled answer. Labels are hard (the vault's breach log, or a synthetic
 * request), but Laya is trained to report calibrated probabilities, so the rest is spread over
 * the other options. Synthetic labels are less certain than the judge's. These are assumptions.
 */
/** Label confidences; contrastive rows are rule-labelled like the stress suite, so as sure as Arena rows. */
export const LABEL_CONFIDENCE = { arena: 0.95, synthetic: 0.9, contrast: 0.95 } as const;

type AnyRow = SentinelRow | SyntheticRow | ContrastRow;
const isSynthetic = (row: AnyRow): row is SyntheticRow =>
  "source" in row && row.source === "synthetic";

function gold(keys: readonly string[], label: string, confidence: number) {
  const rest = (1 - confidence) / (keys.length - 1);
  const probabilities = Object.fromEntries(
    keys.map((k) => [k, Number((k === label ? confidence : rest).toFixed(6))]),
  );
  return { label, probabilities };
}

/** One Arena or synthetic row as one Laya row with the question set's questions (default v1). */
export function toLayaRow(
  row: AnyRow,
  split: LayaRow["split"],
  set: SentinelQuestionSet = "v1",
): LayaRow {
  const source = isSynthetic(row)
    ? "synthetic"
    : "source" in row && row.source === "contrast"
      ? "contrast"
      : "arena";
  const confidence = LABEL_CONFIDENCE[source];
  const { manipulated, action_risk, injection_in_inputs } = row.labels;
  const questions = sentinelQuestions(set);
  const all = {
    manipulated: gold(["false", "true"], String(manipulated), confidence),
    action_risk: gold(
      Object.keys(SENTINEL_QUESTIONS.action_risk.criteria),
      action_risk,
      confidence,
    ),
    injection_in_inputs: gold(["false", "true"], String(injection_in_inputs), confidence),
  };
  const golds = Object.fromEntries(
    SENTINEL_QUESTION_SETS[set].map((key) => [
      key,
      { type: SENTINEL_QUESTIONS[key].type, ...all[key], confidence },
    ]),
  );
  return {
    id: row.id,
    workflow: split === "train" ? "sentinel/train" : `sentinel/${row.attackClass ?? "control"}`,
    split,
    // The three minimal-context fields the serving guard sends (specification Section 10.2).
    state: JSON.stringify(
      sentinelState({
        mandate: row.mandate,
        proposedAction: row.proposedAction,
        untrustedInputs: row.untrustedInputs,
      }),
    ),
    questions: JSON.stringify(questions),
    gold: JSON.stringify(golds),
    source,
    attackClass: row.attackClass,
  };
}

export interface LayaDataset {
  train: LayaRow[];
  test: LayaRow[];
  manifest: {
    questionSet: SentinelQuestionSet;
    heldOutClasses: readonly string[];
    /** Synthetic rows left out of training because their seed is a test-split episode. */
    droppedSeededFromTest: number;
    /** Synthetic rows not labelled a breach whose swap exceeds the per-trade limit. */
    droppedOverTradeLimit: number;
    /** v3: synthetic rows left out because they use an untrained mechanism (contrast.ts). */
    droppedUntrainedMechanism: number;
    /** Training rows whose state doesn't fit Laya's input window (`excludeIds`). */
    droppedOverTokenBudget: number;
    labelConfidence: typeof LABEL_CONFIDENCE;
    counts: Record<"train" | "test" | "contrast", Record<string, number>>;
    labels: Record<"train" | "test", Record<string, Record<string, number>>>;
    /** Whether a surface rule predicts the training labels (shortcuts.ts). Don't train on a fail. */
    shortcuts: ShortcutAudit;
  };
}

/**
 * Split into training and held-out test rows. Test holds only real Arena rows: every row from
 * a held-out class, plus control episodes (no attack), as benign traffic. Training holds the
 * synthetic rows and the remaining real rows. Throws if a held-out class would reach training.
 */
export function buildLayaDataset(input: {
  arena: SentinelRow[];
  synthetic: SyntheticRow[];
  /** Rule-labelled contrastive pairs (contrast.ts); training only. */
  contrast?: ContrastRow[];
  /**
   * Arena rows used only to trace synthetic rows' seeds, never as training or test rows. For
   * synthetic rows seeded from an older rating whose rows aren't in this build (v2's synthetic
   * set was seeded from the pre-v3 wording). A synthetic row seeded from a test-class seed is
   * still left out.
   */
  seeds?: SentinelRow[];
  heldOutClasses?: readonly string[];
  /** Which questions the checkpoint learns (default v1). */
  questions?: SentinelQuestionSet;
  /**
   * Row ids to leave out because their state doesn't fit Laya's input window
   * (services/sentinel/kaggle/check_tokens.py). A test row can't be excluded.
   */
  excludeIds?: ReadonlySet<string>;
}): LayaDataset {
  const set = input.questions ?? "v1";
  const contrast = input.contrast ?? [];
  const heldOut = new Set<string>(input.heldOutClasses ?? SENTINEL_HELD_OUT_CLASSES);
  const leaked = input.synthetic.filter((r) => r.attackClass && heldOut.has(r.attackClass));
  if (leaked.length > 0)
    throw new Error(
      `${leaked.length} synthetic row(s) are from held-out classes (e.g. ${leaked[0]!.id}); regenerate them with the held-out classes excluded`,
    );
  const ids = new Set<string>();
  for (const row of [...input.arena, ...input.synthetic, ...contrast]) {
    if (ids.has(row.id)) throw new Error(`duplicate row id ${row.id}`);
    ids.add(row.id);
  }
  const isTest = (r: SentinelRow) => r.attackClass === null || heldOut.has(r.attackClass);
  // A synthetic row is derived from its seed (the seed's mandate, inputs and action are in the
  // prompt), so one seeded from a test episode would leak that episode into training. Its
  // seed must be one of the given Arena rows, or provenance can't be checked.
  const arenaById = new Map([...(input.seeds ?? []), ...input.arena].map((r) => [r.id, r]));
  const unknown = input.synthetic.filter((r) => !arenaById.has(r.generator?.seedId));
  if (unknown.length > 0)
    throw new Error(
      `${unknown.length} synthetic row(s) have a seed that isn't among the Arena rows given (e.g. ${unknown[0]!.id}); pass the ratings they were seeded from with --arena`,
    );
  const seededFromTest = (r: SyntheticRow) => isTest(arenaById.get(r.generator.seedId)!);
  const notFromTest = input.synthetic.filter((r) => !seededFromTest(r));
  // A swap above the per-trade limit is a breach whatever the scene says, so a row labelled
  // otherwise is mislabelled (overTradeLimit). Rows generated before that check get it here.
  const inLimit = notFromTest.filter(
    (r) => r.labels.action_risk === "breach_likely" || !overTradeLimit(r),
  );
  // Five stress families test mechanisms no training row may use (contrast.ts); older synthetic
  // rows are checked here, for the v3 set.
  const synthetic = set === "v3" ? inLimit.filter((r) => !usesUntrainedMechanism(r)) : inLimit;
  const leakedContrast = contrast.filter((r) => usesUntrainedMechanism(r));
  if (leakedContrast.length > 0)
    throw new Error(
      `${leakedContrast.length} contrastive row(s) use an untrained mechanism (e.g. ${leakedContrast[0]!.id})`,
    );
  const exclude = input.excludeIds ?? new Set<string>();
  const testExcluded = input.arena.filter((r) => isTest(r) && exclude.has(r.id));
  if (testExcluded.length > 0)
    throw new Error(
      `test row ${testExcluded[0]!.id} doesn't fit the input window; the test split must be complete`,
    );
  const allTrain = [
    ...input.arena.filter((r) => !isTest(r)).map((r) => toLayaRow(r, "train", set)),
    ...synthetic.map((r) => toLayaRow(r, "train", set)),
    ...contrast.map((r) => toLayaRow(r, "train", set)),
  ];
  const train = allTrain.filter((r) => !exclude.has(r.id));
  const test = input.arena.filter(isTest).map((r) => toLayaRow(r, "test", set));

  const tally = (rows: LayaRow[], key: (r: LayaRow) => string) =>
    rows.reduce<Record<string, number>>((acc, r) => {
      const k = key(r);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const labelTally = (rows: LayaRow[]) =>
    Object.fromEntries(
      SENTINEL_QUESTION_SETS[set].map((q) => [
        q,
        tally(rows, (r) => (JSON.parse(r.gold) as Record<string, { label: string }>)[q]!.label),
      ]),
    );
  return {
    train,
    test,
    manifest: {
      questionSet: set,
      heldOutClasses: [...heldOut],
      droppedSeededFromTest: input.synthetic.length - notFromTest.length,
      droppedOverTradeLimit: notFromTest.length - inLimit.length,
      droppedUntrainedMechanism: inLimit.length - synthetic.length,
      droppedOverTokenBudget: allTrain.length - train.length,
      labelConfidence: LABEL_CONFIDENCE,
      counts: {
        train: tally(train, (r) => `${r.source}:${r.attackClass ?? "none"}`),
        contrast: contrast.reduce<Record<string, number>>((acc, r) => {
          const k = `${r.mechanism}:${r.role}`;
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
        test: tally(test, (r) => `${r.source}:${r.attackClass ?? "none"}`),
      },
      labels: { train: labelTally(train), test: labelTally(test) },
      shortcuts: auditShortcuts(train.map(auditRowFromLaya)),
    },
  };
}
