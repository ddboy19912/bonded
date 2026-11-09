import { paymentGate } from "@bondedhq/sdk";
import { type Hex, verifyTypedData } from "viem";
import { describe, expect, it, vi } from "vitest";
import { X402Signer, X402SignerRefusal } from "../src/signer.js";
import {
  account,
  localGuard,
  NOW_MS,
  NOW_S,
  nonce,
  payment,
  SERVICE,
  STRANGER,
} from "./helpers.js";

function setup(mode: "enforce" | "monitor" = "enforce", extra = {}, budget = {}) {
  const key = account();
  const { guard, breaches } = localGuard(mode, extra);
  const refused: string[] = [];
  const signer = new X402Signer({
    account: key,
    guard,
    budget,
    now: () => NOW_MS,
    onRefused: (e) => void refused.push(`${e.kind}: ${e.reason}`),
  });
  return { key, signer, breaches, refused };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(X402SignerRefusal);
  return error as X402SignerRefusal;
}

describe("X402Signer", () => {
  it("signs a payment that fits the payee's budget, with the account's key", async () => {
    const { key, signer } = setup();
    const request = payment(key.address);
    const signature = await signer.sign(request);
    const valid = await verifyTypedData({
      address: key.address,
      domain: { ...request.domain, chainId: 8453 },
      types: request.types,
      primaryType: "TransferWithAuthorization",
      message: {
        ...request.message,
        value: 1000n,
        validAfter: 0n,
        validBefore: BigInt(request.message.validBefore as string),
      },
      signature,
    });
    expect(valid).toBe(true);
    expect(signer.budgets()).toHaveLength(1);
    expect(signer.budgets()[0]!.spentMicros).toBe(1000);
  });

  it("refuses a payee that isn't on the vendor list", async () => {
    const { key, signer, refused } = setup();
    const error = await refusal(signer.sign(payment(key.address, { to: STRANGER })));
    expect(error.kind).toBe("refused");
    expect(refused).toHaveLength(1);
  });

  it("refuses a payment over the per-payment limit", async () => {
    const { key, signer } = setup();
    const error = await refusal(signer.sign(payment(key.address, { value: "20000" })));
    expect(error.kind).toBe("refused");
  });

  it("refuses once the day's limit is used up", async () => {
    const { key, signer } = setup("enforce", { maxDailyUsd: 0.02 }, { amountUsd: 0.02 });
    await signer.sign(payment(key.address, { value: "10000" }));
    await signer.sign(payment(key.address, { value: "10000" }));
    const error = await refusal(signer.sign(payment(key.address, { value: "10000" })));
    expect(error.kind).toBe("refused");
  });

  it("signs in Monitor mode and reports the breach", async () => {
    const { key, signer, breaches } = setup("monitor");
    await signer.sign(payment(key.address, { to: STRANGER }));
    expect(breaches.length).toBeGreaterThan(0);
  });

  it("signs a repeated request again without counting it twice", async () => {
    const { key, signer } = setup();
    const request = payment(key.address);
    const first = await signer.sign(request);
    const second = await signer.sign(structuredClone(request));
    expect(second).toBe(first);
    expect(signer.budgets()[0]!.payments).toBe(1);
  });

  it("counts identical requests that arrive together once", async () => {
    const { key, signer } = setup();
    const request = payment(key.address);
    const [a, b] = await Promise.all([signer.sign(request), signer.sign(structuredClone(request))]);
    expect(a).toBe(b);
    expect(signer.budgets()[0]!.payments).toBe(1);
  });

  it("refuses a nonce already signed for a different payment", async () => {
    const { key, signer } = setup();
    const n = nonce();
    await signer.sign(payment(key.address, { nonce: n }));
    const error = await refusal(signer.sign(payment(key.address, { nonce: n, value: "2000" })));
    expect(error.kind).toBe("invalid");
  });

  it("takes the payment back when the key fails to sign", async () => {
    const key = account();
    const { guard } = localGuard();
    const failing = {
      address: key.address,
      signTypedData: vi.fn().mockRejectedValueOnce(new Error("KMS is down")),
    };
    const signer = new X402Signer({ account: failing, guard, now: () => NOW_MS });
    await expect(signer.sign(payment(key.address))).rejects.toThrow("KMS is down");
    expect(signer.budgets()[0]!.spentMicros).toBe(0);
  });

  it("fails closed when the hosted gate can't be reached", async () => {
    const key = account();
    const gate = paymentGate({
      apiKey: "bonded_gk_test",
      apiUrl: "https://gate.invalid",
      receiptKey: "0x3333333333333333333333333333333333333333",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    const signer = new X402Signer({ account: key, guard: gate, now: () => NOW_MS });
    const error = await refusal(signer.sign(payment(key.address)));
    expect(error.kind).toBe("refused");
  });

  describe("signs nothing but x402 USDC transfers from its own address", () => {
    const cases: [string, (from: Hex) => unknown][] = [
      ["another struct", (from) => ({ ...payment(from), primaryType: "Permit" })],
      [
        "an extra type",
        (from) => {
          const p = payment(from);
          return { ...p, types: { ...p.types, Mail: [{ name: "x", type: "string" }] } };
        },
      ],
      [
        "changed fields",
        (from) => {
          const p = payment(from);
          return {
            ...p,
            types: {
              TransferWithAuthorization: p.types.TransferWithAuthorization.map((f) =>
                f.name === "value" ? { ...f, type: "uint128" } : f,
              ),
            },
          };
        },
      ],
      ["another sender", () => payment(account().address)],
      [
        "an unknown chain",
        (from) => ({ ...payment(from), domain: { ...payment(from).domain, chainId: 999 } }),
      ],
      [
        "an unknown token",
        (from) => ({
          ...payment(from),
          domain: { ...payment(from).domain, verifyingContract: SERVICE },
        }),
      ],
      [
        "a domain salt",
        (from) => ({ ...payment(from), domain: { ...payment(from).domain, salt: nonce() } }),
      ],
      ["an extra message field", (from) => payment(from, { memo: "x" })],
      ["a zero amount", (from) => payment(from, { value: "0" })],
      ["a fractional amount", (from) => payment(from, { value: "1.5" })],
      ["an expired window", (from) => payment(from, { validBefore: String(NOW_S - 1) })],
      ["a window over 900 seconds", (from) => payment(from, { validBefore: String(NOW_S + 901) })],
      ["an empty window", (from) => payment(from, { validAfter: String(NOW_S + 60) })],
      ["a short nonce", (from) => payment(from, { nonce: "0x1234" })],
      ["no typed data", () => undefined],
    ];
    for (const [name, build] of cases)
      it(`refuses ${name}`, async () => {
        const { key, signer } = setup();
        const error = await refusal(signer.sign(build(key.address) as never));
        expect(error.kind).toBe("invalid");
        expect(signer.budgets()).toHaveLength(0);
      });
  });

  it("accepts a longer window when told to", async () => {
    const key = account();
    const signer = new X402Signer({
      account: key,
      guard: localGuard().guard,
      maxValiditySeconds: 3600,
      now: () => NOW_MS,
    });
    await signer.sign(payment(key.address, { validBefore: String(NOW_S + 3000) }));
  });

  it("pays only on the networks it's given", async () => {
    const key = account();
    const signer = new X402Signer({
      account: key,
      guard: localGuard().guard,
      networks: ["eip155:84532"],
      now: () => NOW_MS,
    });
    expect(signer.networks).toEqual(["eip155:84532"]);
    const error = await refusal(signer.sign(payment(key.address)));
    expect(error.kind).toBe("invalid");
    expect(
      () => new X402Signer({ account: key, guard: localGuard().guard, networks: ["solana"] }),
    ).toThrow();
  });
});
