import { randomBytes } from "node:crypto";
import {
  TeeUnavailableError,
  TeeVerificationError,
  verifyTeeEvidence,
  type QuoteVerifier,
} from "@bonded/arena";
import {
  payoutSealKeyMessage,
  stripHexPrefix,
  TeeEvidence,
  toHex32,
  verifyPayoutResult,
  type PayoutInstruction,
  type PayoutResult,
  type SealedPayoutCredential,
  type SignedPayoutLookup,
} from "@bondedhq/shared";
import { isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";

/**
 * The gate API's side of the payout proxy (services/payout-proxy). Before a credential is sealed
 * to the proxy, and again before every use, the API challenges it and checks its evidence with
 * the Arena's verifier (apps/arena/src/tee.ts): an Intel-signed TDX quote, from an approved
 * production OS image (a dev image is refused), running the expected code, with a compose hash
 * on this service's allowlist and, when one is configured, a measurement on its allowlist. The
 * proxy's seal key must be vouched for by the key the quote commits to, and every answer it gives
 * must be signed by that key.
 *
 * "Bonded staff can't read the credential" is claimed (`production: true`) only when the quote
 * verified and its measurement is on a configured allowlist. Without one, or in local mode (no
 * hardware), the credential is only said to be sealed to the proxy.
 */

export interface PayoutTeeOptions {
  /** The proxy's base URL (Phala: `https://<app-id>-8080.<gateway>`). */
  url: string;
  /** The code hash baked into the proxy's image. */
  codeHash: Hex;
  /** Compose hashes of deployments this service accepts (the pinned image and compose file). */
  composeHashes: readonly string[];
  /** `teeMeasurement` values this service accepts. Empty: none is production yet. */
  measurements?: readonly string[];
  /** Replaces Intel's verification in tests. */
  verifyQuote?: QuoteVerifier;
  /** OS image hashes to accept (default: the Arena's approved production images). */
  approvedOsImages?: readonly string[];
  /**
   * Local development only (GATE_PAYOUT_TEE_LOCAL=true): accept the mock proxy's evidence with no
   * quote check. Never a TEE: nothing is claimed about who can read the credential.
   */
  local?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** What one successful challenge established. */
export interface AttestedPayoutTee {
  measurement: Hex | null;
  composeHash: Hex;
  evmAddress: Address;
  sealPublicKey: Hex;
  /** The quote verified and its measurement is on the allowlist: the credential is out of reach. */
  production: boolean;
}

/**
 * The proxy answered but would not do it. `sent` is false when nothing was paid, "unknown" when
 * the provider's answer was lost (the payout may exist).
 */
export class PayoutRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly sent: false | "unknown",
    readonly details: { code?: string; payoutId?: string; replayed?: boolean } = {},
  ) {
    super(message);
    this.name = "PayoutRefused";
  }
}

export interface SignedPayoutResult {
  result: PayoutResult;
  signer: Address;
  signature: Hex;
}

/** What the API says about where a linked credential is held. */
export const custodyStatement = (t: { production: boolean }) =>
  t.production
    ? "Sealed to the payout proxy, a TEE on an allowed production measurement (production OS image, pinned image and compose file): only that code can open it, and Bonded staff can't read it."
    : "Sealed to the payout proxy's key; the API can't open it. No production TEE measurement is configured on this service yet, so this makes no claim that Bonded staff can't reach it.";

/**
 * The payout proxy from the environment, or undefined when GATE_PAYOUT_TEE_URL isn't set (the
 * payout routes then answer 503):
 *
 * - GATE_PAYOUT_TEE_URL: the proxy's https URL.
 * - GATE_PAYOUT_TEE_CODE_HASH: the CODE_HASH its image was built with.
 * - GATE_PAYOUT_TEE_COMPOSE_HASHES: comma-separated compose hashes of allowed deployments.
 * - GATE_PAYOUT_TEE_MEASUREMENTS: comma-separated `teeMeasurement` values of allowed production
 *   deployments. Until one is set, nothing claims staff can't read the credential.
 * - GATE_PAYOUT_TEE_LOCAL=true: a mock proxy on this machine, no hardware checks (development).
 */
export function payoutTeeFromEnv(env: NodeJS.ProcessEnv = process.env): PayoutTee | undefined {
  const url = env.GATE_PAYOUT_TEE_URL?.trim();
  if (!url) return undefined;
  const list = (v: string | undefined) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const hex32 = (v: string, name: string) => {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} must be 32 bytes of hex`);
    return toHex32(v);
  };
  const codeHash = hex32(env.GATE_PAYOUT_TEE_CODE_HASH?.trim() ?? "", "GATE_PAYOUT_TEE_CODE_HASH");
  return new PayoutTee({
    url,
    codeHash,
    composeHashes: list(env.GATE_PAYOUT_TEE_COMPOSE_HASHES).map((h) =>
      hex32(h, "GATE_PAYOUT_TEE_COMPOSE_HASHES"),
    ),
    measurements: list(env.GATE_PAYOUT_TEE_MEASUREMENTS).map((h) =>
      hex32(h, "GATE_PAYOUT_TEE_MEASUREMENTS"),
    ),
    ...(env.GATE_PAYOUT_TEE_LOCAL === "true" ? { local: true } : {}),
  });
}

const sameHex = (a: string, b: string) =>
  stripHexPrefix(a).toLowerCase() === stripHexPrefix(b).toLowerCase();

export class PayoutTee {
  constructor(private readonly options: PayoutTeeOptions) {
    const url = new URL(options.url);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback)
      throw new Error("the payout proxy's URL must use https");
    if (options.local && !loopback)
      throw new Error("local mode (no hardware checks) is only for a proxy on this machine");
    if (!options.local && !options.composeHashes.length)
      throw new Error("give the payout proxy's allowed compose hashes");
  }

  /** Whether a production measurement is configured (and so can ever be claimed). */
  get productionConfigured(): boolean {
    return !this.options.local && (this.options.measurements?.length ?? 0) > 0;
  }

  /** Whether a measurement is one this service allows as production. */
  isProductionMeasurement(measurement: string): boolean {
    return (
      this.productionConfigured &&
      (this.options.measurements ?? []).some((m) => sameHex(m, measurement))
    );
  }

  /**
   * One call to the proxy. With `moves`, the call may have moved money before its answer was
   * lost, so a lost or unreadable answer is "unknown" rather than "unavailable".
   */
  private async request(path: string, init: RequestInit = {}, moves = false): Promise<unknown> {
    const doFetch = this.options.fetch ?? fetch;
    const lost = (what: string) =>
      moves
        ? new PayoutRefused(504, `${what}; the payout may have been made`, "unknown")
        : new TeeUnavailableError(what);
    let response: Response;
    try {
      response = await doFetch(new URL(path, this.options.url), {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
        redirect: "error",
      });
    } catch {
      throw lost("the payout proxy did not answer");
    }
    const body = (await response.json().catch(() => undefined)) as
      Record<string, unknown> | undefined;
    if (response.ok && body) return body;
    if (!body) throw lost(`the payout proxy answered ${response.status}`);
    if (response.status >= 500 && body.sent !== false && body.sent !== "unknown")
      throw lost(`the payout proxy answered ${response.status}`);
    throw new PayoutRefused(
      response.status,
      typeof body.error === "string" ? body.error : `the payout proxy answered ${response.status}`,
      body.sent === "unknown" ? "unknown" : false,
      {
        ...(typeof body.code === "string" ? { code: body.code } : {}),
        ...(typeof body.payoutId === "string" ? { payoutId: body.payoutId } : {}),
        ...(body.replayed === true ? { replayed: true } : {}),
      },
    );
  }

  /**
   * Challenge the proxy and check everything it shows. Throws `TeeVerificationError` when it
   * isn't a proxy this service trusts, `TeeUnavailableError` when it can't be reached.
   */
  async attest(): Promise<AttestedPayoutTee> {
    const nonce = `0x${randomBytes(32).toString("hex")}`;
    const raw = await this.request(`/attestation?nonce=${nonce}`);
    const parsed = TeeEvidence.safeParse(raw);
    if (!parsed.success) throw new TeeVerificationError("the evidence is malformed");
    const evidence = parsed.data;
    let measurement: Hex | null = null;
    let composeHash: Hex;
    if (this.options.local) {
      if (!sameHex(evidence.nonce, nonce)) throw new TeeVerificationError("a different challenge");
      if (!sameHex(evidence.codeHash, this.options.codeHash))
        throw new TeeVerificationError("the proxy reports different code than expected");
      composeHash = toHex32(evidence.composeHash);
    } else {
      const allowed = this.options.composeHashes.find((h) => sameHex(h, evidence.composeHash));
      if (!allowed)
        throw new TeeVerificationError(
          "the proxy runs a deployment (compose hash) that is not on this service's allowlist",
        );
      const verified = await verifyTeeEvidence(raw, {
        nonce,
        codeHash: this.options.codeHash,
        composeHash: allowed,
        ...(this.options.verifyQuote ? { verifyQuote: this.options.verifyQuote } : {}),
        ...(this.options.approvedOsImages
          ? { approvedOsImages: this.options.approvedOsImages }
          : {}),
      });
      const allowedMeasurements = this.options.measurements ?? [];
      if (
        allowedMeasurements.length &&
        !allowedMeasurements.some((m) => sameHex(m, verified.measurement))
      )
        throw new TeeVerificationError(
          "the proxy's measurement is not on this service's allowlist",
        );
      measurement = verified.measurement;
      composeHash = verified.composeHash;
    }
    const seal = (await this.request("/seal-key")) as Record<string, unknown>;
    const sealKey = seal.sealPublicKey;
    const signature = seal.signature;
    if (
      typeof sealKey !== "string" ||
      !/^0x04[0-9a-fA-F]{128}$/.test(sealKey) ||
      typeof signature !== "string" ||
      !/^0x[0-9a-fA-F]+$/.test(signature)
    )
      throw new TeeVerificationError("the proxy's seal key is malformed");
    let signer: Address;
    try {
      signer = await recoverMessageAddress({
        message: payoutSealKeyMessage(this.options.codeHash, sealKey as Hex),
        signature: signature as Hex,
      });
    } catch {
      throw new TeeVerificationError("the proxy's seal key is not vouched for");
    }
    if (!isAddressEqual(signer, evidence.evmAddress as Address))
      throw new TeeVerificationError("the proxy's seal key is not vouched for by its attested key");
    return {
      measurement,
      composeHash,
      evmAddress: evidence.evmAddress as Address,
      sealPublicKey: sealKey.toLowerCase() as Hex,
      production: this.productionConfigured && measurement !== null,
    };
  }

  private async signedResult(tee: AttestedPayoutTee, raw: unknown): Promise<PayoutResult> {
    const answer = raw as Partial<SignedPayoutResult>;
    if (
      !answer.result ||
      typeof answer.signature !== "string" ||
      !(await verifyPayoutResult(answer.result, answer.signature, tee.evmAddress))
    )
      throw new TeeVerificationError("the proxy's answer is not signed by its attested key");
    return answer.result;
  }

  private post = (path: string, body: unknown, moves = false) =>
    this.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      moves,
    );

  /**
   * Forward one payout instruction to the attested proxy. A badly signed answer to it is
   * "unknown" too: the proxy may still have paid.
   */
  async execute(tee: AttestedPayoutTee, instruction: PayoutInstruction): Promise<PayoutResult> {
    const raw = await this.post("/payouts", instruction, true);
    try {
      return await this.signedResult(tee, raw);
    } catch {
      throw new PayoutRefused(
        502,
        "the payout proxy's answer is not signed by its attested key; the payout may have been made",
        "unknown",
      );
    }
  }

  /** The provider's record of one payout, for a lookup the gate signed. */
  async lookup(
    tee: AttestedPayoutTee,
    lookup: SignedPayoutLookup,
    credential: SealedPayoutCredential,
  ): Promise<PayoutResult> {
    return this.signedResult(tee, await this.post("/payouts/lookup", { lookup, credential }));
  }

  /** Whether a sealed credential opens in the proxy and is one it accepts; its hint. */
  async checkCredential(
    gateAccountId: string,
    credential: SealedPayoutCredential,
  ): Promise<{ provider: string; livemode: boolean; keyHint: string; financialAccount: string }> {
    const r = (await this.post("/credentials/check", { gateAccountId, credential })) as Record<
      string,
      unknown
    >;
    return {
      provider: String(r.provider ?? ""),
      livemode: r.livemode === true,
      keyHint: String(r.keyHint ?? ""),
      financialAccount: String(r.financialAccount ?? ""),
    };
  }
}
