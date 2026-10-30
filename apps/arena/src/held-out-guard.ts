import { isMetaModel } from "@bondedhq/shared";

/**
 * Held-out attacks never go to Meta Model API (issue #231, Section 4). Bonded runs Meta's hosted
 * models (`muse-*`, `isMetaModel`) on Meta's free credits, and a held-out set is only worth
 * something while no model provider has seen it. So any run that would put held-out text in front
 * of a Meta-hosted model refuses before it calls a model: as the rated agent, a Sentinel guard,
 * the attacker or variant drafter, or O6's counterparty.
 *
 * Muse Spark Open on Baseten (`meta-models/...`, `isBasetenModel`) is allowed: the request goes to
 * Baseten, which serves fixed open weights, not to Meta, so Meta's credit terms don't reach it.
 */

/** One model a run would call, and the part it plays. */
export interface RunModel {
  /** What the model does in the run: "the agent", "the attacker", "O6's counterparty", ... */
  role: string;
  /** The model id; undefined when that part isn't played by a model in this run. */
  model: string | undefined;
}

/** A run that would send held-out attacks to Meta Model API. */
export class HeldOutToMetaError extends Error {
  constructor(
    readonly offending: readonly { role: string; model: string }[],
    what: string,
  ) {
    const list = offending.map((m) => `${m.role} (${m.model})`).join(", ");
    super(
      `refused: ${what} never go to Meta Model API while Bonded is on Meta's free credits, ` +
        `and this run would send them to ${list}. Run without the held-out set, or pick a ` +
        "model not served by Meta Model API (meta-models/muse-spark-open on Baseten is allowed)",
    );
    this.name = "HeldOutToMetaError";
  }
}

/** The models in `models` that Meta Model API serves. */
export function metaApiModels(models: readonly RunModel[]): { role: string; model: string }[] {
  return models.filter((m): m is { role: string; model: string } =>
    Boolean(m.model && isMetaModel(m.model)),
  );
}

/**
 * Throws HeldOutToMetaError when any model a held-out run would call is served by Meta Model API.
 * Call it before the first model call (and before a sandbox starts, where that is cheap).
 */
export function assertHeldOutOffMetaApi(
  models: readonly RunModel[],
  what = "held-out attacks",
): void {
  const offending = metaApiModels(models);
  if (offending.length) throw new HeldOutToMetaError(offending, what);
}
