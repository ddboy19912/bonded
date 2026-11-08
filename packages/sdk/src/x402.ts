import { normalAccount } from "@bondedhq/shared";
import type { BudgetRequest, BudgetSpend, PaymentBudget } from "./budget.js";
import { BondedError } from "./errors.js";
import { isPaymentRefusal } from "./payments.js";

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

/** The `x402Client` hooks the guard registers (`@x402/core`'s client, or anything shaped like it). */
export interface X402ClientHooks {
  onBeforePaymentCreation(
    hook: (context: X402PaymentContext) => Promise<void | X402Abort>,
  ): unknown;
  onAfterPaymentCreation?(
    hook: (context: X402PaymentContext & { paymentPayload: object }) => Promise<void>,
  ): unknown;
  onPaymentCreationFailure?(
    hook: (context: X402PaymentContext & { error: Error }) => Promise<void>,
  ): unknown;
  onPaymentResponse?(
    hook: (context: {
      paymentPayload: object;
      settleResponse?: { success: boolean; transaction?: string };
      paymentRequired?: unknown;
      error?: Error;
    }) => Promise<void>,
  ): unknown;
}

/** A US dollar stablecoin the guard counts at one dollar per token. */
export interface X402Asset {
  /** CAIP-2 network id, or an x402 version 1 network name. */
  network: string;
  /** The token's contract or mint address. EVM addresses compare case-insensitively. */
  asset: string;
  decimals: number;
}

/**
 * USDC on the networks x402 lists it for, by network id (and the version 1 name, where it has one).
 * The guard only counts these (and any `assets` you add) as dollars; a price in anything else is
 * refused.
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

export interface X402GuardOptions {
  /**
   * A `PaymentGuard`, or the hosted `PaymentGate`: anything with `budget()`. Its mandate needs
   * invoice matching off, and each service's `payTo` address on the vendor list, so the agent
   * pays only services you listed.
   */
  guard: { budget(request: BudgetRequest): Promise<PaymentBudget> };
  /**
   * The budget opened for each service: `amountUsd` (default $1, raised to fit a bigger price),
   * `ttlSeconds` (default an hour) and `maxPaymentUsd` (default the mandate's per-payment limit).
   */
  budget?: { amountUsd?: number; ttlSeconds?: number; maxPaymentUsd?: number };
  /** More US dollar stablecoins to accept, beyond `X402_USD_ASSETS`. */
  assets?: readonly X402Asset[];
  /** Reads the payee and the exact price. Default: `payTo`, and the price in micro-dollars. */
  toPayment?: (
    requirements: X402Requirements,
    context: X402PaymentContext,
  ) => { account: string; amountMicros: number };
  /** Errors from closing a used-up budget in the background. Default: ignored. */
  onError?: (error: unknown) => void;
}

/**
 * Checks every x402 payment against a budget for its service before the x402 client signs it.
 *
 * The first payment to a service opens a budget for it (`guard.budget`): one check against the
 * rules, and with the hosted gate a signed receipt. Every payment then checks against that budget
 * in exact micro-dollars with no network call, so a $0.001 call is fast and counts as $0.001.
 * When a budget is used up or ends, the next payment closes it and opens another.
 *
 * - A refused payment is never signed: the hook aborts and the request fails with the reason. In
 *   Monitor mode a payment that breaks the budget is signed and `onBreach` reports it.
 * - A payment the server turns down (it answers 402 again, or settlement fails) is taken back.
 * - Call `close()` when the agent stops, so the unspent part of each budget stops counting toward
 *   the day. Unclosed hosted budgets close themselves soon after they end.
 */
export class X402Guard {
  readonly #options: X402GuardOptions;
  readonly #assets: readonly X402Asset[];
  readonly #budgets = new Map<string, PaymentBudget>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #byRequirements = new WeakMap<object, Counted>();
  readonly #byPayload = new WeakMap<object, Counted>();

  constructor(options: X402GuardOptions) {
    this.#options = options;
    this.#assets = [...(options.assets ?? []), ...X402_USD_ASSETS];
  }

  /** Registers the guard's hooks on an x402 client and returns the client. */
  register<C extends X402ClientHooks>(client: C): C {
    client.onBeforePaymentCreation((context) => this.check(context));
    client.onAfterPaymentCreation?.(async (context) => {
      const counted = this.#byRequirements.get(context.selectedRequirements);
      if (counted) this.#byPayload.set(context.paymentPayload, counted);
    });
    client.onPaymentCreationFailure?.(async (context) => {
      const counted = this.#byRequirements.get(context.selectedRequirements);
      if (counted) counted.budget.release(counted.spend.id);
    });
    client.onPaymentResponse?.(async (context) => {
      const counted = this.#byPayload.get(context.paymentPayload);
      if (!counted) return;
      if (context.settleResponse?.success) {
        if (context.settleResponse.transaction)
          counted.budget.settle(counted.spend.id, context.settleResponse.transaction);
      } else if (context.paymentRequired || context.settleResponse?.success === false) {
        counted.budget.release(counted.spend.id);
      }
    });
    return client;
  }

  /** The `onBeforePaymentCreation` hook: counts the payment against its service's budget. */
  async check(context: X402PaymentContext): Promise<void | X402Abort> {
    try {
      const { account, amountMicros } = (
        this.#options.toPayment ?? ((r) => x402Price(r, this.#assets))
      )(context.selectedRequirements, context);
      const counted = await this.#exclusive(normalAccount(account), async (key) => {
        const budget = await this.#budgetFor(key, account, amountMicros);
        const spend = await budget.spend(amountMicros, {
          reference: context.paymentRequired.resource?.url?.slice(0, 200) ?? "",
        });
        return { budget, spend };
      });
      this.#byRequirements.set(context.selectedRequirements, counted);
      return undefined;
    } catch (error) {
      if (isPaymentRefusal(error)) return { abort: true, reason: error.message };
      throw error;
    }
  }

  /** The open budgets, one per service. */
  budgets(): PaymentBudget[] {
    return [...this.#budgets.values()];
  }

  /** Closes every budget: sends what's left and stops the unspent part counting. */
  async close(): Promise<void> {
    const open = [...this.#budgets.values()];
    this.#budgets.clear();
    await Promise.all(open.map((b) => b.close()));
  }

  /** The service's budget, or a new one when there's none, it ended, or the payment won't fit. */
  async #budgetFor(key: string, account: string, amountMicros: number): Promise<PaymentBudget> {
    const current = this.#budgets.get(key);
    if (current && !current.closed) {
      // It fits; or it's over the per-payment limit, which a new budget would have too, so the
      // current one says no.
      if (!current.problem(amountMicros) || amountMicros > current.terms.maxPaymentMicros)
        return current;
    }
    if (current) {
      this.#budgets.delete(key);
      current.close().catch(this.#options.onError ?? (() => undefined));
    }
    const asked = this.#options.budget?.amountUsd ?? 1;
    const budget = await this.#options.guard.budget({
      account,
      amountUsd: Math.max(asked, Math.ceil(amountMicros / 10_000) / 100),
      ...(this.#options.budget?.ttlSeconds === undefined
        ? {}
        : { ttlSeconds: this.#options.budget.ttlSeconds }),
      ...(this.#options.budget?.maxPaymentUsd === undefined
        ? {}
        : { maxPaymentUsd: this.#options.budget.maxPaymentUsd }),
    });
    this.#budgets.set(key, budget);
    return budget;
  }

  /** One payment per service at a time, so two can't both open a budget or both take the last of one. */
  #exclusive<T>(key: string, run: (key: string) => Promise<T>): Promise<T> {
    const next = (this.#locks.get(key) ?? Promise.resolve()).then(
      () => run(key),
      () => run(key),
    );
    this.#locks.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}

interface Counted {
  budget: PaymentBudget;
  spend: BudgetSpend;
}

/** An x402 guard: see `X402Guard`. */
export function x402Guard(options: X402GuardOptions): X402Guard {
  return new X402Guard(options);
}

/**
 * Registers a new `X402Guard` on an x402 client and returns the client, for when you never need
 * to close its budgets yourself (hosted budgets close themselves after they end; local ones close
 * when the next budget opens).
 */
export function guardX402Client<C extends X402ClientHooks>(
  client: C,
  options: X402GuardOptions,
): C {
  return new X402Guard(options).register(client);
}

const sameAsset = (a: string, b: string) =>
  a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * The payee and the exact price in micro-dollars, for a price in a dollar stablecoin the guard
 * knows. Past six decimals it rounds up.
 */
export function x402Price(
  r: X402Requirements,
  assets: readonly X402Asset[] = X402_USD_ASSETS,
): { account: string; amountMicros: number } {
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
  const value = BigInt(units);
  const micros =
    known.decimals <= 6
      ? value * 10n ** BigInt(6 - known.decimals)
      : (value + 10n ** BigInt(known.decimals - 6) - 1n) / 10n ** BigInt(known.decimals - 6);
  if (micros === 0n) throw new BondedError("INVALID_PAYMENT", "the x402 price is zero");
  if (micros > BigInt(Number.MAX_SAFE_INTEGER))
    throw new BondedError("INVALID_PAYMENT", "the x402 price is too large");
  return { account: r.payTo, amountMicros: Number(micros) };
}
