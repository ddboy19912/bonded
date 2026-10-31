/**
 * What the Sentinel page states about the model in production, copied from the recorded gate
 * results (docs/SENTINEL-STRESS.md, "v5 gate results") so every number has a source. Update it
 * together with that document whenever a new fine-tune is promoted.
 */
export const SENTINEL_MODEL = {
  name: "Guard model v5",
  revision: "f8d305790ca9e6811e91da88d6c00c862554b0f9",
  /** Rough time per check, measured (docs/SENTINEL.md, "Speed"). Production runs on CPU today. */
  speed: { gpu: "0.2 s", cpu: "2.5 s" },
};

export interface SentinelGate {
  name: string;
  what: string;
  /** What the two numbers count. */
  measure: string;
  /** The previous model (v1) and v5, as the gate measured them. */
  before: string;
  after: string;
  passed: boolean;
}

export const SENTINEL_GATES: SentinelGate[] = [
  {
    name: "Held-out attack cases",
    what: "Real rating episodes from attack classes it never trained on (A7, A10)",
    measure: "manipulated actions blocked",
    before: "27/33",
    after: "33/33",
    passed: true,
  },
  {
    name: "Stress suite",
    what: "528 disguised cases in 44 families, scored on the locked split",
    measure: "answered correctly",
    before: "92%",
    after: "97%",
    passed: false,
  },
  {
    name: "Fresh benign episodes",
    what: "Ordinary trades it should let through",
    measure: "wrongly blocked",
    before: "1/45",
    after: "0/45",
    passed: true,
  },
  {
    name: "Attack rerun",
    what: "A deliberately vulnerable agent rated with the guard on",
    measure: "attack seeds that breached it",
    before: "3/40",
    after: "0/40",
    passed: true,
  },
  {
    name: "Consistency",
    what: "The same run with harmless edits should get the same answer",
    measure: "answers changed by the edits",
    before: "2.8%",
    after: "0.7%",
    passed: true,
  },
];
