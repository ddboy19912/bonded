import {
  type AgentRunSummary,
  isBasetenModel,
  isMetaModel,
  OPENROUTER_BASE_URL,
} from "@bondedhq/shared";

/** A model's price, USD per million tokens. */
export interface TokenPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * The price a cap estimates at when it knows nothing about the model. Deliberately high: for the
 * cheap models ratings use it reads 3 to 30 times the real spend, so callers that know the model
 * should pass its listed price (`listedModelPrice`) instead.
 */
export const DEFAULT_FALLBACK_PRICE: TokenPrice = { inputPerMillion: 1, outputPerMillion: 4 };

/**
 * A per-run spending cap for model usage. A rating stops starting new episodes once the cap is
 * reached, and the report says so. Costs come from the endpoint when it reports them
 * (OpenRouter does); otherwise they're estimated from token counts at a fallback price,
 * and the report marks the total as estimated.
 */
export interface SpendingCapOptions {
  /** Stop once this much has been spent, in USD. */
  maxUsd: number;
  /**
   * Price used when the endpoint reports tokens but no cost (default DEFAULT_FALLBACK_PRICE).
   * Listed prices are estimates; provider routing, tiers and caching can change actual charges.
   */
  fallbackPrice?: TokenPrice;
}

export class SpendingCap {
  private spent = 0;
  private estimated = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly fallback: TokenPrice;

  constructor(private readonly options: SpendingCapOptions) {
    if (!(options.maxUsd >= 0)) throw new RangeError("maxUsd must be zero or more");
    this.fallback = { ...(options.fallbackPrice ?? DEFAULT_FALLBACK_PRICE) };
    if (!validPrice(this.fallback))
      throw new RangeError("fallback prices must be finite and nonnegative");
  }

  /** Adds one run's usage. */
  add(usage: AgentRunSummary["usage"]): void {
    if (!usage) return;
    if (![usage.inputTokens, usage.outputTokens].every(nonnegativeFinite))
      throw new RangeError("usage token counts must be finite and nonnegative");
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    if (usage.costUsd !== undefined && nonnegativeFinite(usage.costUsd)) {
      this.spent += usage.costUsd;
    } else if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      this.estimated = true;
      this.spent +=
        (usage.inputTokens * this.fallback.inputPerMillion +
          usage.outputTokens * this.fallback.outputPerMillion) /
        1e6;
    }
  }

  get exceeded(): boolean {
    return this.spent >= this.options.maxUsd;
  }

  summary() {
    return {
      spentUsd: this.spent,
      maxUsd: this.options.maxUsd,
      estimated: this.estimated,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }
}

/**
 * Meta Model API's published prices (dev.meta.ai/docs/pricing-rate-limits, read 2026-10-26).
 * Its responses carry no cost and its model list no prices, so the cap estimates from these.
 * Cached input is cheaper; the full input price keeps the estimate on the high side.
 */
export const META_MODEL_PRICES: Record<string, TokenPrice> = {
  "muse-spark-1.3": { inputPerMillion: 1.25, outputPerMillion: 4.25 },
  "muse-spark-1.2": { inputPerMillion: 1.25, outputPerMillion: 4.25 },
  "muse-spark-1.1": { inputPerMillion: 1.25, outputPerMillion: 4.25 },
  "muse-spark-1.3-contributor": { inputPerMillion: 0.1, outputPerMillion: 0.2 },
  "muse-spark-1.2-contributor": { inputPerMillion: 0.1, outputPerMillion: 0.2 },
  "muse-wonder-1.0": { inputPerMillion: 4, outputPerMillion: 20 },
  /** Meta's open-weight Muse Spark, on Baseten (baseten.co/library/muse-spark-open, 2026-10-30). */
  "muse-spark-open": { inputPerMillion: 1.25, outputPerMillion: 4.25 },
};

/** The dearest Meta price, for a Meta id the table doesn't list (so a new id never loosens a cap). */
const HIGHEST_META_PRICE: TokenPrice = {
  inputPerMillion: Math.max(...Object.values(META_MODEL_PRICES).map((p) => p.inputPerMillion)),
  outputPerMillion: Math.max(...Object.values(META_MODEL_PRICES).map((p) => p.outputPerMillion)),
};

const metaPrice = (model: string): TokenPrice => ({
  ...(META_MODEL_PRICES[model] ?? HIGHEST_META_PRICE),
});

/**
 * Fallback-price options for a cap whose runs may call Meta's models, which report no cost: the
 * dearest Meta price among the models named (an agent's name carries its model, as in
 * `vulnerable-agent/muse-spark-1.3`), and never below DEFAULT_FALLBACK_PRICE. Empty when no Meta
 * model is named, so the cap keeps its default.
 */
export function metaCapFallback(...names: (string | undefined)[]): { fallbackPrice?: TokenPrice } {
  const prices = names.flatMap((n) => n?.match(/\bmuse-[a-z0-9.-]+/g) ?? []).map(metaPrice);
  if (prices.length === 0) return {};
  return {
    fallbackPrice: {
      inputPerMillion: Math.max(
        DEFAULT_FALLBACK_PRICE.inputPerMillion,
        ...prices.map((p) => p.inputPerMillion),
      ),
      outputPerMillion: Math.max(
        DEFAULT_FALLBACK_PRICE.outputPerMillion,
        ...prices.map((p) => p.outputPerMillion),
      ),
    },
  };
}

/**
 * A model's listed price from the endpoint's model list (OpenRouter's `/models`, which needs no
 * key), for a spending cap's fallback. Meta's models use META_MODEL_PRICES (the dearest one for an
 * id it doesn't list). Undefined when the
 * endpoint lists no price for it or can't be reached: the cap then keeps its default, so a failed
 * lookup never loosens it.
 */
export async function listedModelPrice(
  model: string,
  options: { baseUrl?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<TokenPrice | undefined> {
  if (isMetaModel(model)) return metaPrice(model);
  // Baseten's ids carry Meta's name after the namespace (`meta-models/muse-spark-open`).
  if (isBasetenModel(model)) return metaPrice(model.slice(model.indexOf("/") + 1));
  const baseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? OPENROUTER_BASE_URL).replace(
    /\/+$/,
    "",
  );
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      data?: { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[];
    };
    const pricing = body.data?.find((m) => m.id === model)?.pricing;
    const input = perToken(pricing?.prompt);
    const output = perToken(pricing?.completion);
    const price = { inputPerMillion: input * 1e6, outputPerMillion: output * 1e6 };
    return validPrice(price) ? price : undefined;
  } catch {
    return undefined;
  }
}

/** A listed per-token price (OpenRouter sends strings); NaN when missing or malformed. */
function perToken(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

function nonnegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
function validPrice(price: TokenPrice): boolean {
  return nonnegativeFinite(price.inputPerMillion) && nonnegativeFinite(price.outputPerMillion);
}

/** Combined token usage lacks model attribution: use the highest rate across its sources.
 * Unknown sources retain the default estimate. This is not a provider spending guarantee.
 */
export async function fallbackForModels(
  models: readonly (string | undefined)[],
  lookup: (model: string) => Promise<TokenPrice | undefined> = listedModelPrice,
): Promise<TokenPrice | undefined> {
  if (!models.length) return undefined;
  const prices = await Promise.all(
    [...new Set(models)].map(async (model) =>
      model ? ((await lookup(model)) ?? DEFAULT_FALLBACK_PRICE) : DEFAULT_FALLBACK_PRICE,
    ),
  );
  return {
    inputPerMillion: Math.max(...prices.map((p) => p.inputPerMillion)),
    outputPerMillion: Math.max(...prices.map((p) => p.outputPerMillion)),
  };
}
