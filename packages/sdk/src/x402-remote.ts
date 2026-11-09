import type { Address, Hex } from "viem";
import { BondedError } from "./errors.js";

/**
 * The wire format between an agent and `@bondedhq/signer`, the x402 signer a business runs on its
 * own server. The agent never holds the wallet key: it sends each x402 payment's EIP-712 request
 * to the signer, which checks it against a budget and signs only if it fits.
 */
export const X402_SIGNER_PATHS = {
  /** `GET`: the signer's address and the networks it pays on (`X402SignerInfo`). */
  info: "/v1/x402/signer",
  /** `POST` an `X402SignRequest`; answers an `X402SignResponse`, or an `X402SignerProblem`. */
  sign: "/v1/x402/sign",
} as const;

/** One EIP-712 request, as the x402 client builds it. Big numbers travel as decimal strings. */
export interface X402TypedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface X402SignRequest {
  typedData: X402TypedData;
}

export interface X402SignResponse {
  signature: Hex;
}

export interface X402SignerInfo {
  address: Address;
  /** CAIP-2 ids, such as `eip155:8453`. */
  networks: string[];
}

/**
 * Why the signer didn't sign. `refused`: the payment breaks the budget or the gate couldn't be
 * reached (it fails closed). `invalid`: not an x402 USDC payment from this signer, or malformed.
 * `unauthorized`: a missing or wrong token. `error`: something broke in the signer.
 */
export interface X402SignerProblem {
  error: "refused" | "invalid" | "unauthorized" | "not_found" | "error";
  reason: string;
}

/** The error codes `remoteX402Signer` throws; all of them mean nothing was signed. */
export const X402_SIGNER_ERROR_CODES = [
  "SIGNER_REFUSED",
  "SIGNER_UNAUTHORIZED",
  "SIGNER_UNAVAILABLE",
] as const;

export interface RemoteX402SignerOptions {
  /** Where the signer runs, such as `http://bonded-signer:8402`. */
  url: string;
  /** One of the signer's tokens. It can only ask for x402 payments, never move money itself. */
  token: string;
  /**
   * How long to wait for each request, in milliseconds (default 35,000). The signer may need to
   * open a budget with the gate (up to two tries of 10 seconds) and then wait for its KMS (up to
   * 10 seconds); giving up sooner would make the agent retry a payment the signer still counts.
   */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** What an x402 client needs from a signer (`ClientEvmSigner` in `@x402/evm`). */
export interface RemoteX402Signer {
  readonly address: Address;
  readonly networks: readonly string[];
  signTypedData(typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

/**
 * An x402 signer whose key stays on a server the agent can't reach: `@bondedhq/signer`. Pass it to
 * `ExactEvmScheme` in place of a local account. Each payment goes to the signer, which checks it
 * against the gate's budget for its payee and signs only if it fits, so code in the agent's process
 * can't pay without the check.
 *
 * Nothing is signed when the signer refuses, can't be reached or doesn't accept the token: the
 * x402 client's request fails with a `BondedError` (`SIGNER_REFUSED`, `SIGNER_UNAVAILABLE`,
 * `SIGNER_UNAUTHORIZED`, or `INVALID_PAYMENT`), which `isPaymentRefusal` recognizes.
 */
export async function remoteX402Signer(
  options: RemoteX402SignerOptions,
): Promise<RemoteX402Signer> {
  const base = options.url.replace(/\/+$/, "");
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 35_000;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${options.token}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BondedError("SIGNER_UNAVAILABLE", `the x402 signer can't be reached at ${base}`, {
        cause: error,
      });
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (response.ok && body && typeof body === "object") return body as T;
    const problem = body as Partial<X402SignerProblem> | undefined;
    const reason = typeof problem?.reason === "string" ? problem.reason : `HTTP ${response.status}`;
    if (response.status === 401 || problem?.error === "unauthorized")
      throw new BondedError("SIGNER_UNAUTHORIZED", `the x402 signer refused the token: ${reason}`);
    if (problem?.error === "refused")
      throw new BondedError("SIGNER_REFUSED", `the x402 signer refused the payment: ${reason}`);
    if (problem?.error === "invalid")
      throw new BondedError("INVALID_PAYMENT", `the x402 signer won't sign this: ${reason}`);
    throw new BondedError("SIGNER_UNAVAILABLE", `the x402 signer failed: ${reason}`);
  }

  const info = await call<X402SignerInfo>(X402_SIGNER_PATHS.info);
  if (typeof info.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(info.address))
    throw new BondedError("SIGNER_UNAVAILABLE", "the x402 signer sent no valid address");

  return {
    address: info.address,
    networks: Array.isArray(info.networks) ? [...info.networks] : [],
    async signTypedData(typedData) {
      const request: X402SignRequest = { typedData };
      const { signature } = await call<X402SignResponse>(X402_SIGNER_PATHS.sign, {
        method: "POST",
        body: JSON.stringify(request, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      });
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature))
        throw new BondedError("SIGNER_UNAVAILABLE", "the x402 signer sent no valid signature");
      return signature as Hex;
    },
  };
}
