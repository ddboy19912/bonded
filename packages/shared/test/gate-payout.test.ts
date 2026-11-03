import { createECDH, randomBytes } from "node:crypto";
import { bytesToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  isLivePayoutKey,
  isSealedPayoutCredential,
  isTestPayoutKey,
  openPayoutCredential,
  payoutKeyHint,
  payoutResultMessage,
  sealPayoutCredential,
  signPayoutLookup,
  verifyPayoutLookup,
  verifyPayoutResult,
  type PayoutCredential,
  type PayoutResult,
} from "../src/index.js";

// A throwaway P-256 key standing in for the proxy's seal key, and a Stripe-shaped test key.
const seal = createECDH("prime256v1");
seal.generateKeys();
const SEAL_KEY = bytesToHex(seal.getPublicKey());
const ACCOUNT = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";
const credential: PayoutCredential = {
  provider: "stripe",
  gateAccountId: ACCOUNT,
  secretKey: `rk_test_${randomBytes(24).toString("hex")}`,
  financialAccount: "fa_test_65NybHaQx7KJxDc22rZ16NybHIZ4",
};
const ecdh = (epk: Uint8Array) => seal.computeSecret(Buffer.from(epk));

describe("sealing a payout credential", () => {
  it("opens only with the seal key, for the account it was sealed for", async () => {
    const sealed = await sealPayoutCredential(credential, SEAL_KEY);
    expect(isSealedPayoutCredential(sealed)).toBe(true);
    expect(sealed.to).toBe(SEAL_KEY);
    expect(JSON.stringify(sealed)).not.toContain(credential.secretKey);
    expect(await openPayoutCredential(sealed, ACCOUNT, ecdh)).toEqual(credential);
    // Another account's id is other associated data: it doesn't open.
    await expect(
      openPayoutCredential(sealed, "00000000-0000-0000-0000-000000000000", ecdh),
    ).rejects.toThrow();
    // Another key doesn't open it.
    const other = createECDH("prime256v1");
    other.generateKeys();
    await expect(
      openPayoutCredential(sealed, ACCOUNT, (epk) => other.computeSecret(Buffer.from(epk))),
    ).rejects.toThrow();
    // Nor does a changed ciphertext.
    const flipped =
      `${sealed.ct.slice(0, -2)}${sealed.ct.endsWith("00") ? "01" : "00"}` as `0x${string}`;
    await expect(openPayoutCredential({ ...sealed, ct: flipped }, ACCOUNT, ecdh)).rejects.toThrow();
  });

  it("seals fresh each time, and refuses a seal key that isn't one", async () => {
    const a = await sealPayoutCredential(credential, SEAL_KEY);
    const b = await sealPayoutCredential(credential, SEAL_KEY);
    expect(a.epk).not.toBe(b.epk);
    expect(a.ct).not.toBe(b.ct);
    await expect(sealPayoutCredential(credential, "0x1234")).rejects.toThrow(/65-byte/);
    expect(isSealedPayoutCredential({ ...a, extra: 1 })).toBe(false);
    expect(isSealedPayoutCredential({ ...a, iv: "0x12" })).toBe(false);
  });

  it("tells test keys from live ones and hints without showing the key", () => {
    expect(isTestPayoutKey("rk_test_abc")).toBe(true);
    expect(isLivePayoutKey("rk_test_abc")).toBe(false);
    expect(isLivePayoutKey("sk_live_abc")).toBe(true);
    expect(isTestPayoutKey("pk_test_abc")).toBe(false);
    const hint = payoutKeyHint(credential.secretKey);
    expect(hint.startsWith("rk_test_")).toBe(true);
    expect(hint.length).toBeLessThan(16);
  });
});

describe("payout lookups and results", () => {
  it("verifies a lookup only for the gate's key", async () => {
    const gate = generatePrivateKey();
    const lookup = { gateAccountId: ACCOUNT, payoutId: "obp_test_1", issuedAt: 1_800_000_000 };
    const signed = await signPayoutLookup(lookup, gate);
    expect(await verifyPayoutLookup(signed, privateKeyToAccount(gate).address)).toBe(true);
    const other = privateKeyToAccount(generatePrivateKey()).address;
    expect(await verifyPayoutLookup(signed, other)).toBe(false);
    expect(
      await verifyPayoutLookup(
        { ...signed, lookup: { ...lookup, payoutId: "obp_test_2" } },
        privateKeyToAccount(gate).address,
      ),
    ).toBe(false);
  });

  it("verifies a proxy's signed result, and any change breaks it", async () => {
    const proxy = privateKeyToAccount(generatePrivateKey());
    const result: PayoutResult = {
      decisionId: "d1",
      gateAccountId: ACCOUNT,
      provider: "stripe",
      payoutId: "obp_test_1",
      status: "processing",
      amountCents: 61240,
      currency: "usd",
      destination: "stripe:acct_1:usba_test_1",
      gateDecision: "d1",
      livemode: false,
    };
    const signature = await proxy.signMessage({ message: payoutResultMessage(result) });
    expect(await verifyPayoutResult(result, signature, proxy.address)).toBe(true);
    expect(
      await verifyPayoutResult({ ...result, amountCents: 61241 }, signature, proxy.address),
    ).toBe(false);
  });
});
