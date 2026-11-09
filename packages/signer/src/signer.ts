import { isPaymentRefusal } from "@bondedhq/sdk";
import {
  type X402Asset,
  X402Guard,
  type X402GuardOptions,
  type X402TypedData,
  X402_USD_ASSETS,
} from "@bondedhq/sdk/x402";
import { type Address, getAddress, type Hex, isAddress } from "viem";

/** The only struct the signer signs: USDC's signed transfer (EIP-3009), as x402's `exact` uses it. */
const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

const UINT256_MAX = 2n ** 256n - 1n;

/** Anything that signs EIP-712 data for one address: a viem account, a KMS account, a wallet SDK's. */
export interface TypedDataAccount {
  readonly address: Address;
  signTypedData(typedData: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: Address;
    };
    types: { TransferWithAuthorization: typeof TRANSFER_WITH_AUTHORIZATION };
    primaryType: "TransferWithAuthorization";
    message: {
      from: Address;
      to: Address;
      value: bigint;
      validAfter: bigint;
      validBefore: bigint;
      nonce: Hex;
    };
  }): Promise<Hex>;
}

export interface X402SignerOptions {
  /** The wallet key. It never leaves this process (or the KMS that holds it). */
  account: TypedDataAccount;
  /**
   * The hosted `PaymentGate` (recommended: budgets get signed receipts and count toward the day's
   * limit on Bonded), or a local `PaymentGuard`. Its mandate needs invoice matching off and each
   * service's `payTo` address on the vendor list.
   */
  guard: X402GuardOptions["guard"];
  /** Each payee's budget: `amountUsd` (default $1), `ttlSeconds`, `maxPaymentUsd`. See `X402Guard`. */
  budget?: X402GuardOptions["budget"];
  /**
   * The networks it pays on, as CAIP-2 ids (`eip155:8453`). Default: every EVM network in
   * `X402_USD_ASSETS`.
   */
  networks?: readonly string[];
  /** More US dollar stablecoins to accept (EIP-3009 tokens), beyond `X402_USD_ASSETS`. */
  assets?: readonly X402Asset[];
  /**
   * The longest a signed payment may stay valid, in seconds (default 900). x402 servers ask for
   * `maxTimeoutSeconds`; a payment that would stay usable longer than this is refused.
   */
  maxValiditySeconds?: number;
  /** Called after each signature, and each refusal. For logs; errors here are ignored. */
  onSigned?: (event: X402SignedEvent) => void;
  onRefused?: (event: X402RefusedEvent) => void;
  /** Errors from closing used-up budgets in the background. */
  onError?: (error: unknown) => void;
  /** Unix milliseconds. For tests. */
  now?: () => number;
}

export interface X402Payment {
  network: string;
  asset: Address;
  payTo: Address;
  /** In the token's smallest unit (for USDC, micro-dollars). */
  value: string;
  nonce: Hex;
  validBefore: number;
}

export interface X402SignedEvent {
  payment: X402Payment;
  /** True when the same request was signed before: the stored signature was sent again. */
  repeat: boolean;
}

export interface X402RefusedEvent {
  payment: X402Payment | undefined;
  kind: "refused" | "invalid";
  reason: string;
}

/** Why the signer won't sign: the payment breaks the budget (`refused`) or isn't one it signs (`invalid`). */
export class X402SignerRefusal extends Error {
  override readonly name = "X402SignerRefusal";
  constructor(
    readonly kind: "refused" | "invalid",
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * Signs x402 payments for an agent that never holds the key. Each request must be a USDC
 * `TransferWithAuthorization` (EIP-3009) from this signer's address, on a network and token it
 * knows, valid for a short time; then it must fit the payee's budget (see `X402Guard`: the first
 * payment to a payee opens a budget with the gate, the rest count against it in exact
 * micro-dollars). Anything else is refused: other typed data, raw hashes, messages, transactions,
 * permits.
 *
 * It fails closed. If a budget has to be opened and the gate can't be reached, or its answer
 * doesn't check out, nothing is signed.
 */
export class X402Signer {
  readonly address: Address;
  readonly networks: readonly string[];
  readonly #options: X402SignerOptions;
  readonly #guard: X402Guard;
  readonly #assets: readonly X402Asset[];
  readonly #chains: Map<number, string>;
  readonly #maxValidityMs: number;
  readonly #now: () => number;
  /** Signed payments by token and nonce, kept until they expire, so a retry isn't counted twice. */
  readonly #signed = new Map<string, { digest: string; signature: Hex; validBeforeMs: number }>();
  /** Payments being checked or signed now, so an identical request waits for the same answer. */
  readonly #pending = new Map<string, { digest: string; signature: Promise<Hex> }>();
  #onFailure:
    ((context: Parameters<X402Guard["check"]>[0] & { error: Error }) => Promise<void>) | undefined;

  constructor(options: X402SignerOptions) {
    this.#options = options;
    this.address = getAddress(options.account.address);
    this.#assets = [...(options.assets ?? []), ...X402_USD_ASSETS];
    const known = [
      ...new Set(this.#assets.filter((a) => a.network.startsWith("eip155:")).map((a) => a.network)),
    ];
    this.networks = options.networks ? [...options.networks] : known;
    this.#chains = new Map();
    for (const network of this.networks) {
      const chainId = /^eip155:(\d+)$/.exec(network)?.[1];
      if (!chainId) throw new Error(`the x402 signer pays on EVM networks only, not ${network}`);
      if (!known.includes(network))
        throw new Error(`no US dollar stablecoin is listed for ${network}; add it to assets`);
      this.#chains.set(Number(chainId), network);
    }
    const maxValidity = options.maxValiditySeconds ?? 900;
    if (!Number.isInteger(maxValidity) || maxValidity < 10 || maxValidity > 86_400)
      throw new Error("maxValiditySeconds must be a whole number from 10 to 86,400");
    this.#maxValidityMs = maxValidity * 1000;
    this.#now = options.now ?? Date.now;
    this.#guard = new X402Guard({
      guard: options.guard,
      ...(options.budget ? { budget: options.budget } : {}),
      assets: this.#assets,
      ...(options.onError ? { onError: options.onError } : {}),
    });
    // The guard takes a payment back through its x402-client hook; keep that hook for failed signatures.
    this.#guard.register({
      onBeforePaymentCreation: () => undefined,
      onPaymentCreationFailure: (hook) => {
        this.#onFailure = hook;
      },
    });
  }

  /**
   * Checks one x402 payment and signs it, or throws `X402SignerRefusal`. Any other error means
   * the signer itself failed (nothing was signed).
   */
  async sign(typedData: X402TypedData): Promise<Hex> {
    let payment: X402Payment | undefined;
    try {
      const parsed = this.#parse(typedData);
      const p = (payment = parsed.payment);
      const key = `${p.network}:${p.asset.toLowerCase()}:${p.nonce.toLowerCase()}`;
      this.#forgetExpired();
      const seen = this.#signed.get(key) ?? this.#pending.get(key);
      if (seen) {
        if (seen.digest !== parsed.digest)
          throw new X402SignerRefusal(
            "invalid",
            "this nonce was already signed for another payment",
          );
        const signature = await seen.signature;
        this.#note(() => this.#options.onSigned?.({ payment: p, repeat: true }));
        return signature;
      }
      const signing = this.#checkAndSign(parsed.typedData, p);
      this.#pending.set(key, { digest: parsed.digest, signature: signing });
      try {
        const signature = await signing;
        this.#signed.set(key, {
          digest: parsed.digest,
          signature,
          validBeforeMs: p.validBefore * 1000,
        });
        this.#note(() => this.#options.onSigned?.({ payment: p, repeat: false }));
        return signature;
      } finally {
        this.#pending.delete(key);
      }
    } catch (error) {
      const refusal =
        error instanceof X402SignerRefusal
          ? error
          : isPaymentRefusal(error)
            ? new X402SignerRefusal("refused", error.message)
            : undefined;
      if (!refusal) throw error;
      this.#note(() =>
        this.#options.onRefused?.({ payment, kind: refusal.kind, reason: refusal.message }),
      );
      throw refusal;
    }
  }

  /** Counts the payment against its payee's budget, then signs; a failed signature is taken back. */
  async #checkAndSign(
    typedData: Parameters<TypedDataAccount["signTypedData"]>[0],
    payment: X402Payment,
  ): Promise<Hex> {
    const context = {
      paymentRequired: { x402Version: 2 },
      selectedRequirements: {
        scheme: "exact",
        network: payment.network,
        asset: payment.asset,
        payTo: payment.payTo,
        amount: payment.value,
      },
    };
    const verdict = await this.#guard.check(context);
    if (verdict) throw new X402SignerRefusal("refused", verdict.reason);
    try {
      return await this.#options.account.signTypedData(typedData);
    } catch (error) {
      await this.#onFailure?.({ ...context, error: error as Error });
      throw error;
    }
  }

  /** The payees' budgets that are open now. */
  budgets(): ReturnType<X402Guard["budgets"]> {
    return this.#guard.budgets();
  }

  /** Closes every budget, so their unspent part stops counting toward the day. Call on shutdown. */
  async close(): Promise<void> {
    await this.#guard.close();
  }

  #parse(input: X402TypedData) {
    const invalid = (reason: string) => new X402SignerRefusal("invalid", reason);
    if (!input || typeof input !== "object") throw invalid("no typed data");
    const { domain, types, primaryType, message } = input;
    if (primaryType !== "TransferWithAuthorization")
      throw invalid(
        `only x402 USDC transfers (TransferWithAuthorization) are signed, not ${String(primaryType)}`,
      );
    if (!types || typeof types !== "object") throw invalid("no types");
    for (const name of Object.keys(types))
      if (name !== "TransferWithAuthorization" && name !== "EIP712Domain")
        throw invalid(`unexpected type ${name}`);
    const fields = (types as Record<string, unknown>).TransferWithAuthorization;
    if (
      !Array.isArray(fields) ||
      fields.length !== TRANSFER_WITH_AUTHORIZATION.length ||
      fields.some((f, i) => {
        const want = TRANSFER_WITH_AUTHORIZATION[i]!;
        return (
          !f ||
          typeof f !== "object" ||
          Object.keys(f).length !== 2 ||
          (f as { name?: unknown }).name !== want.name ||
          (f as { type?: unknown }).type !== want.type
        );
      })
    )
      throw invalid("TransferWithAuthorization doesn't have EIP-3009's fields");

    if (!domain || typeof domain !== "object") throw invalid("no domain");
    for (const name of Object.keys(domain))
      if (!["name", "version", "chainId", "verifyingContract"].includes(name))
        throw invalid(`unexpected domain field ${name}`);
    const { name, version, chainId, verifyingContract } = domain as Record<string, unknown>;
    if (typeof name !== "string" || !name || typeof version !== "string" || !version)
      throw invalid("the domain needs the token's name and version");
    const chain = whole(chainId, "chainId");
    const network =
      chain <= BigInt(Number.MAX_SAFE_INTEGER) ? this.#chains.get(Number(chain)) : undefined;
    if (!network) throw invalid(`chain ${chain} isn't one this signer pays on`);
    if (typeof verifyingContract !== "string" || !isAddress(verifyingContract, { strict: false }))
      throw invalid("the domain's verifyingContract isn't an address");
    const asset = getAddress(verifyingContract);
    if (
      !this.#assets.some(
        (a) => a.network === network && a.asset.toLowerCase() === asset.toLowerCase(),
      )
    )
      throw invalid(`${asset} isn't a US dollar stablecoin this signer pays in on ${network}`);

    if (!message || typeof message !== "object") throw invalid("no message");
    const m = message as Record<string, unknown>;
    for (const key of Object.keys(m))
      if (!TRANSFER_WITH_AUTHORIZATION.some((f) => f.name === key))
        throw invalid(`unexpected message field ${key}`);
    const from = address(m.from, "from");
    if (from !== this.address) throw invalid(`the payment is from ${from}, not this signer`);
    const to = address(m.to, "to");
    const value = whole(m.value, "value");
    if (value === 0n) throw invalid("the payment is zero");
    const validAfter = whole(m.validAfter, "validAfter");
    const validBefore = whole(m.validBefore, "validBefore");
    if (typeof m.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(m.nonce))
      throw invalid("the nonce must be 32 bytes of hex");
    const nonce = m.nonce as Hex;
    const nowMs = this.#now();
    const nowS = BigInt(Math.floor(nowMs / 1000));
    if (validBefore <= nowS) throw invalid("the payment's time window has already ended");
    if (validBefore > nowS + BigInt(this.#maxValidityMs / 1000))
      throw invalid(
        `the payment would stay valid for ${validBefore - nowS}s, more than this signer's ${this.#maxValidityMs / 1000}s`,
      );
    if (validAfter >= validBefore) throw invalid("the payment's time window is empty");

    const typedData = {
      domain: { name, version, chainId: Number(chain), verifyingContract: asset },
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: "TransferWithAuthorization" as const,
      message: { from, to, value, validAfter, validBefore, nonce },
    };
    return {
      typedData,
      digest: JSON.stringify(typedData, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      payment: {
        network,
        asset,
        payTo: to,
        value: value.toString(),
        nonce,
        validBefore: Number(validBefore),
      } satisfies X402Payment,
    };
  }

  #forgetExpired() {
    const nowMs = this.#now();
    for (const [key, entry] of this.#signed)
      if (entry.validBeforeMs <= nowMs) this.#signed.delete(key);
  }

  #note(call: () => void) {
    try {
      call();
    } catch {
      // Logging hooks never change the answer.
    }
  }
}

function whole(value: unknown, field: string): bigint {
  const text =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number"
        ? String(value)
        : value;
  if (typeof text !== "string" || !/^\d{1,78}$/.test(text))
    throw new X402SignerRefusal("invalid", `${field} must be a whole number`);
  const n = BigInt(text);
  if (n > UINT256_MAX) throw new X402SignerRefusal("invalid", `${field} is too large`);
  return n;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false }))
    throw new X402SignerRefusal("invalid", `${field} isn't an address`);
  return getAddress(value);
}

/** An x402 signer: see `X402Signer`. */
export function x402Signer(options: X402SignerOptions): X402Signer {
  return new X402Signer(options);
}
