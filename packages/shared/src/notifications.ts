/**
 * What Bonded tells an agent's owner about (webhook, optional email and the in-app list,
 * `GET /self/notifications/inbox`). Each type can be turned off in the owner's settings
 * (`muted`). Each event is sent once: its `dedupeKey` names it.
 */
export const NOTIFICATION_TYPES = {
  rating_finished: "A rating or preview finished.",
  rating_failed: "A rating or preview stopped.",
  rating_refused: "A rating or preview was refused (not attested).",
  score_expiring: "The agent's score expires in 7 days.",
  runner_offline:
    "The runner has been offline for over 30 minutes while a rating or renewal is due.",
  breach_recorded: "The vault recorded a breach.",
  claim_filed: "A claim was filed for a breach.",
  claim_paid: "A claim was paid.",
  cover_lapsing: "The cover's premium is past due (in its grace period) or the cover lapsed.",
  low_gas: "The agent key is low on gas.",
  payment_blocked: "The payment gate blocked a payment (Enforce mode).",
  payment_breach: "A payment broke a rule and went through (Monitor mode).",
  gate_frozen: "The payment gate froze an account after a breach.",
  stripe_webhook_failed:
    "Stripe couldn't get the payment gate's answer on a card charge (webhook timeout or error).",
} as const;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export const NOTIFICATION_TYPE_LIST = Object.keys(NOTIFICATION_TYPES) as NotificationType[];

/** How long before a score's expiry the owner is told. */
export const SCORE_EXPIRY_WARNING_SECONDS = 7 * 86_400;
/** How long a runner may be away, while a rating or renewal is due, before the owner is told. */
export const RUNNER_OFFLINE_ALERT_MS = 30 * 60_000;

/**
 * The agent key pays gas for every `execute` through its vault. With no trade of its own to
 * measure from, a trade is assumed to cost this much gas (an assumption, reported as such).
 */
export const ASSUMED_EXECUTE_GAS = 350_000n;
/** Gas is low when it covers fewer trades than this. */
export const LOW_GAS_TRADES = 20;

export interface AgentGas {
  /** The agent key's ETH balance, in wei (decimal string) and in ETH. */
  balanceWei: string;
  balanceEth: number;
  low: boolean;
  /** Trades the balance pays for at the gas price now; null when the price is unknown. */
  estimatedTradesLeft: number | null;
  /** Where the per-trade cost comes from: the agent's own recent trades, or the assumption. */
  basis: "measured" | "assumed";
  gasPerTrade: string;
}

export function agentGasStatus(input: {
  balanceWei: bigint;
  gasPriceWei: bigint | null;
  /** Median gas used by the agent's own recent trades, when there are some. */
  measuredGasPerTrade?: bigint | null;
}): AgentGas {
  const gas =
    input.measuredGasPerTrade && input.measuredGasPerTrade > 0n
      ? input.measuredGasPerTrade
      : ASSUMED_EXECUTE_GAS;
  const perTrade = input.gasPriceWei !== null ? gas * input.gasPriceWei : null;
  const left = perTrade && perTrade > 0n ? Number(input.balanceWei / perTrade) : null;
  return {
    balanceWei: input.balanceWei.toString(),
    balanceEth: Number(input.balanceWei) / 1e18,
    low: input.balanceWei === 0n || (left !== null && left < LOW_GAS_TRADES),
    estimatedTradesLeft: left,
    basis: input.measuredGasPerTrade && input.measuredGasPerTrade > 0n ? "measured" : "assumed",
    gasPerTrade: gas.toString(),
  };
}
