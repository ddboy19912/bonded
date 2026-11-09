import { paymentGuard, type PaymentBreach, type PaymentMandate } from "@bondedhq/sdk";
import { type Address, type Hex, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const SERVICE: Address = "0x1111111111111111111111111111111111111111";
export const STRANGER: Address = "0x2222222222222222222222222222222222222222";
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const NOW_MS = Date.parse("2026-11-08T10:00:00Z");
export const NOW_S = NOW_MS / 1000;

export const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export function account() {
  return privateKeyToAccount(generatePrivateKey());
}

export function nonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** An x402 `exact` payment request as the x402 client builds it: $0.001 to SERVICE on Base. */
export function payment(from: Address, over: Record<string, unknown> = {}) {
  return {
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC },
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: SERVICE,
      value: "1000",
      validAfter: "0",
      validBefore: String(NOW_S + 60),
      nonce: nonce(),
      ...over,
    },
  };
}

/** A local guard: SERVICE is the only vendor, $0.01 a payment, $5 a day. */
export function localGuard(
  mode: PaymentMandate["mode"] = "enforce",
  extra: Partial<PaymentMandate> = {},
) {
  const breaches: PaymentBreach[] = [];
  const guard = paymentGuard({
    mandate: {
      mode,
      maxPaymentUsd: 0.01,
      maxDailyUsd: 5,
      freezeOnBreach: false,
      invoiceMatching: false,
      ...extra,
    },
    vendors: [{ id: "forecast-api", account: SERVICE }],
    onBreach: (b) => void breaches.push(b),
    now: () => new Date(NOW_MS),
  });
  return { guard, breaches };
}
