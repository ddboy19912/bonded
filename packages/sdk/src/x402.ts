import type { PaymentAttempt } from "@bondedhq/shared";
import { BondedError } from "./errors.js";
import type { GatePayment } from "./gate.js";
import { isPaymentRefusal, type PaymentGuard } from "./payments.js";

/**
 * One way to pay that an x402 server offers, as `@x402/core` gives it to client hooks. In x402
 * version 2 the price is `amount`; version 1 called it `maxAmountRequired`. Both are in the
 * asset's smallest unit (for USDC, millionths of a dollar).
 */
export interface X402Requirements {
  scheme: string;
  /** CAIP-2 in version 2 (`eip155:8453`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`); a name in version 1 (`base`). */
  network: string;
  asset: string;
  payTo: string;
  amount?: string;
  maxAmountRequired?: string;
  resource?: string;
  extra?: Record<string, unknown>;
}

/** What `x402Client.onBeforePaymentCreation` hooks are given. */
export interface X402PaymentContext {
  paymentRequired: { x402Version: number; resource?: { url?: string } };
  selectedRequirements: X402Requirements;
}

/** A hook result that stops the payment: the x402 client signs nothing. */
export type X402Abort = { abort: true; reason: string };

/** A US dollar stablecoin the guard counts at one dollar per token. */
export interface X402Asset {
  /** CAIP-2 network id, or an x402 version 1 network name. */
  network: string;
  /** The token's contract or mint address. EVM addresses compare case-insensitively. */
  asset: string;
  decimals: number;
}

/**
 * USDC on the networks x402 lists it for, by network id (and the version 1 name, where it has one). The guard
 * only counts these (and any `assets` you add) as dollars; a price in anything else is refused.
 */
export const X402_USD_ASSETS: readonly X402Asset[] = [
  ...evm(["eip155:8453", "base"], "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  ...evm(["eip155:84532", "base-sepolia"], "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  ...evm(["eip155:1"], "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  ...evm(["eip155:42161"], "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
  ...evm(["eip155:137", "polygon"], "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
  ...evm(["eip155:43114", "avalanche"], "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
  ...["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "solana"].map((network) => ({
    network,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  })),
  ...["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "solana-devnet"].map((network) => ({
    network,
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6,
  })),
];

function evm(networks: string[], asset: string): X402Asset[] {
  return networks.map((network) => ({ network, asset, decimals: 6 }));
}

export interface GuardX402Options {
  /**
   * A `PaymentGuard`, or the hosted `PaymentGate`. Its mandate needs invoice matching off
   * (`invoiceMatching: false`, or the setting on your gate account): x402 payments have no invoices.
   * Each service's `payTo` address goes on the vendor list, so the agent pays only services you
   * listed.
   */
  guard: Pick<PaymentGuard, "pay">;
  /** More US dollar stablecoins to accept, beyond `X402_USD_ASSETS`. */
  assets?: readonly X402Asset[];
  /**
   * Reads the payment from the x402 requirements. Default: `payTo` as the account, the price in
   * US dollars rounded up to the next cent, and no reference.
   */
  toPayment?: (
    requirements: X402Requirements,
    context: X402PaymentContext,
  ) => PaymentAttempt | GatePayment;
}

/**
 * Checks every x402 payment against the payment mandate before the x402 client signs it. Register
 * it on the `x402Client` your fetch or axios wrapper uses:
 *
 * ```ts
 * import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
 * import { guardX402Client } from "@bondedhq/sdk/x402";
 *
 * const guard = paymentGuard({ mandate: { ...limits, invoiceMatching: false }, vendors, onBreach: alert });
 * const client = guardX402Client(new x402Client().register("eip155:*", new ExactEvmScheme(signer)), { guard });
 * const paidFetch = wrapFetchWithPayment(fetch, client);
 * ```
 *
 * When the guard refuses (Enforce mode blocked it, the guard is frozen, the gate couldn't be
 * reached, or the price isn't in a dollar stablecoin it knows), the client signs nothing and the
 * request fails with the reason. In Monitor mode a breaking payment is signed and `onBreach`
 * reports it.
 *
 * The rules count whole cents, so a price under a cent counts as one cent: limits err on the safe
 * side. A payment the guard allows counts as made from that moment, even if the server then turns
 * the payment down.
 */
export function guardX402Client<C extends { onBeforePaymentCreation(hook: X402Hook): unknown }>(
  client: C,
  options: GuardX402Options,
): C {
  client.onBeforePaymentCreation(x402PaymentCheck(options));
  return client;
}

/** An `onBeforePaymentCreation` hook. */
export type X402Hook = (context: X402PaymentContext) => Promise<void | X402Abort>;

/** The hook `guardX402Client` registers, for clients you set up some other way. */
export function x402PaymentCheck(options: GuardX402Options): X402Hook {
  const assets = [...(options.assets ?? []), ...X402_USD_ASSETS];
  const toPayment = options.toPayment ?? ((r: X402Requirements) => defaultPayment(r, assets));
  return async (context) => {
    try {
      const attempt = toPayment(context.selectedRequirements, context);
      await options.guard.pay(attempt, () => undefined);
      return undefined;
    } catch (error) {
      if (isPaymentRefusal(error)) return { abort: true, reason: error.message };
      throw error;
    }
  };
}

const sameAsset = (a: string, b: string) =>
  a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;

function defaultPayment(r: X402Requirements, assets: readonly X402Asset[]): PaymentAttempt {
  const units = r.amount ?? r.maxAmountRequired;
  if (typeof units !== "string" || !/^\d+$/.test(units))
    throw new BondedError("INVALID_PAYMENT", "the x402 price must be a whole number of units");
  if (typeof r.payTo !== "string" || !r.payTo)
    throw new BondedError("INVALID_PAYMENT", "the x402 payment has no payTo address");
  const known = assets.find((a) => a.network === r.network && sameAsset(a.asset, r.asset));
  if (!known)
    throw new BondedError(
      "INVALID_PAYMENT",
      `the x402 price is in ${r.asset} on ${r.network}, not a US dollar stablecoin the guard knows`,
    );
  // Whole cents, rounded up: the rules count cents, and rounding down could make a price free.
  const scale = 10n ** BigInt(known.decimals);
  const cents = (BigInt(units) * 100n + scale - 1n) / scale;
  if (cents === 0n) throw new BondedError("INVALID_PAYMENT", "the x402 price is zero");
  return { account: r.payTo, amountUsd: Number(cents) / 100 };
}
