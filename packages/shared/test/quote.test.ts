import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  type Attestation,
  type BuildQuoteInput,
  bindingOf,
  buildQuote,
  priceCover,
  QUOTE_TTL_SECONDS,
  QuoteError,
  signQuote,
  UNDERWRITING_COVER_CAP_USD,
  underwritingCapRefusal,
  verifyQuote,
} from "../src/index.js";

// Well-known Anvil test keys #0 and #1. Never hold real funds.
const ATTESTER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const attester = privateKeyToAccount(ATTESTER_KEY).address;

const usd = (n: number) => BigInt(n) * 1_000_000n;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const NOW = 1_790_000_000;
const coverManager = "0x7777777777777777777777777777777777777777";
const vault = "0x6666666666666666666666666666666666666666";

// The plan's hardened agent (Section 9.2): EL 0.30%, score 96.
const hardened: Attestation = {
  agentId: "42",
  score: 96,
  securityScore: 96,
  expectedLossBps: 30,
  reportHash: hash(1),
  mandateHash: hash(2),
  codeHash: hash(3),
  teeMeasurement: hash(0),
  modelFamily: "deepseek",
  issuedAt: NOW - 60,
  expiresAt: NOW + 30 * 24 * 60 * 60,
};

describe("priceCover", () => {
  it("prices the plan's hardened agent at 1.19% with the minimum 10% bond", () => {
    // 0.0030 × 1.3 + 0.008 = 0.0119; a 10% bond earns no discount.
    const p = priceCover({
      expectedLossBps: 30,
      score: 96,
      coverAmount: usd(20_000),
      bond: usd(2_000),
    });
    expect(p).toMatchObject({ tier: "AAA", premiumRateBps: 119, basePremiumRateBps: 119 });
    expect(p.minBond).toBe(usd(2_000));
  });

  it("prices the plan's tier-B agent and applies the bond discount", () => {
    // 0.0634 × 1.3 + 0.008 = 0.09042 → 905 bps (rounded up). A 30% bond (the B minimum)
    // discounts by 30% − 10% = 20%: 0.072336 → 724 bps.
    const p = priceCover({
      expectedLossBps: 634,
      score: 41,
      coverAmount: usd(10_000),
      bond: usd(3_000),
    });
    expect(p).toMatchObject({ tier: "B", basePremiumRateBps: 905, premiumRateBps: 724 });
    expect(p.minBond).toBe(usd(3_000));
  });

  it("caps the bond discount at 30%", () => {
    const at40 = priceCover({
      expectedLossBps: 30,
      score: 96,
      coverAmount: usd(100),
      bond: usd(40),
    });
    const at90 = priceCover({
      expectedLossBps: 30,
      score: 96,
      coverAmount: usd(100),
      bond: usd(90),
    });
    // 0.0119 × 0.7 = 0.00833 → 84 bps.
    expect(at40.premiumRateBps).toBe(84);
    expect(at90.premiumRateBps).toBe(84);
  });

  it("refuses uninsurable scores and bonds below the tier minimum", () => {
    expect(() =>
      priceCover({ expectedLossBps: 9000, score: 1, coverAmount: usd(100), bond: usd(100) }),
    ).toThrow(QuoteError);
    // BB needs a 20% bond.
    expect(() =>
      priceCover({ expectedLossBps: 300, score: 50, coverAmount: usd(100), bond: usd(19) }),
    ).toThrow(/below the BB minimum/);
    expect(() =>
      priceCover({ expectedLossBps: 30, score: 96, coverAmount: 0n, bond: usd(1) }),
    ).toThrow(RangeError);
  });

  it("measures the bond against the agent's total cover, not just this quote", () => {
    // A 10,000 bond on 20,000 of new cover alone would be 50% (full discount, 84 bps).
    // With 30,000 already covered on another vault it's 20% of 50,000: a 10% discount.
    const p = priceCover({
      expectedLossBps: 30,
      score: 96,
      coverAmount: usd(20_000),
      bond: usd(10_000),
      existingCover: usd(30_000),
    });
    expect(p.bondRatio).toBe(0.2);
    expect(p.premiumRateBps).toBe(108); // 0.0119 × 0.9 = 0.01071 → 108
    // The quote's minBond covers both policies, so buyCover enforces it for the total.
    expect(p.minBond).toBe(usd(5_000));
    expect(() =>
      priceCover({
        expectedLossBps: 30,
        score: 96,
        coverAmount: usd(20_000),
        bond: usd(4_999),
        existingCover: usd(30_000),
      }),
    ).toThrow(/total cover/);
  });

  it("rounds the minimum bond up, like the contract", () => {
    // 10% of 15 units is 1.5 → 2.
    const p = priceCover({ expectedLossBps: 30, score: 96, coverAmount: 15n, bond: 2n });
    expect(p.minBond).toBe(2n);
    expect(() =>
      priceCover({ expectedLossBps: 30, score: 96, coverAmount: 15n, bond: 1n }),
    ).toThrow(QuoteError);
  });

  it("doesn't round float noise up a whole basis point", () => {
    // 0.003 × 1.3 + 0.008 is exactly 119 bps, but floats compute 119.00000000000001.
    const p = priceCover({ expectedLossBps: 30, score: 96, coverAmount: usd(100), bond: usd(10) });
    expect(p.premiumRateBps).toBe(119);
  });
});

describe("buildQuote", () => {
  it("copies the attestation's fields and prices the cover", () => {
    const { quote, pricing } = buildQuote({
      attestation: hardened,
      vault,
      coverAmount: usd(20_000),
      bond: usd(10_000),
      now: NOW,
      nonce: 7n,
    });
    expect(quote).toEqual({
      agentId: "42",
      vault,
      coverAmount: "20000000000",
      premiumRateBps: pricing.premiumRateBps,
      score: 96,
      modelFamily: "deepseek",
      mandateHash: hash(2),
      reportHash: hash(1),
      minBond: "2000000000",
      expiresAt: NOW + QUOTE_TTL_SECONDS,
      nonce: "7",
    });
    // A 50% bond earns the full 30% discount: 0.0119 × 0.7 → 84 bps.
    expect(quote.premiumRateBps).toBe(84);
  });

  it("never outlives the attestation", () => {
    const soon = { ...hardened, expiresAt: NOW + 120 };
    const { quote } = buildQuote({
      attestation: soon,
      vault,
      coverAmount: usd(1),
      bond: usd(1),
      now: NOW,
    });
    expect(quote.expiresAt).toBe(NOW + 120);
    expect(() =>
      buildQuote({ attestation: soon, vault, coverAmount: usd(1), bond: usd(1), now: NOW + 120 }),
    ).toThrow(/expired/);
  });

  it("uses a fresh random nonce by default", () => {
    const input: BuildQuoteInput = {
      attestation: hardened,
      vault,
      coverAmount: usd(1),
      bond: usd(1),
      now: NOW,
    };
    expect(buildQuote(input).quote.nonce).not.toBe(buildQuote(input).quote.nonce);
  });
});

describe("signQuote and verifyQuote", () => {
  const { quote } = buildQuote({
    attestation: hardened,
    vault,
    coverAmount: usd(20_000),
    bond: usd(2_000),
    now: NOW,
    nonce: 1n,
  });
  const domain = { chainId: 46630, coverManager } as const;

  it("round-trips for a trusted attester", async () => {
    const signed = await signQuote(quote, { ...domain, attesterKey: ATTESTER_KEY });
    expect(signed.signer).toBe(attester);
    expect(await verifyQuote(signed, [attester])).toBe(true);
  });

  it("rejects an untrusted signer, a changed quote, and another chain or CoverManager", async () => {
    const self = await signQuote(quote, { ...domain, attesterKey: OTHER_KEY });
    expect(await verifyQuote(self, [attester])).toBe(false);

    const signed = await signQuote(quote, { ...domain, attesterKey: ATTESTER_KEY });
    const cheaper = { ...signed, quote: { ...signed.quote, premiumRateBps: 1 } };
    expect(await verifyQuote(cheaper, [attester])).toBe(false);
    expect(await verifyQuote({ ...signed, chainId: 421614 }, [attester])).toBe(false);
    expect(await verifyQuote({ ...signed, coverManager: vault }, [attester])).toBe(false);
  });
});

describe("underwriting cap by binding", () => {
  const input = (over: Partial<BuildQuoteInput> = {}): BuildQuoteInput => ({
    attestation: hardened,
    vault,
    coverAmount: usd(5_000),
    bond: usd(2_000),
    now: NOW,
    ...over,
  });

  it("reads the binding from the attestation's TEE measurement", () => {
    expect(bindingOf(hash(0))).toBe("declared");
    expect(bindingOf(hash(5))).toBe("tee");
  });

  it("caps a declared agent at 5,000 tUSDG in total and a TEE-bound one at 20,000", () => {
    expect(UNDERWRITING_COVER_CAP_USD).toEqual({ declared: 5_000, tee: 20_000 });
    expect(() => buildQuote(input({ binding: "declared" }))).not.toThrow();
    expect(() => buildQuote(input({ binding: "declared", coverAmount: usd(5_001) }))).toThrow(
      /underwriting policy: .*declared binding is capped at 5,000 tUSDG/,
    );
    // The cap is on the agent's total cover, so existing cover counts.
    expect(() =>
      buildQuote(
        input({ binding: "declared", coverAmount: usd(1_000), existingCover: usd(4_500) }),
      ),
    ).toThrow(QuoteError);
    expect(() =>
      buildQuote(input({ binding: "tee", coverAmount: usd(20_000), bond: usd(6_000) })),
    ).not.toThrow();
    expect(() => buildQuote(input({ binding: "tee", coverAmount: usd(20_001) }))).toThrow(
      /TEE-bound agent is capped at 20,000/,
    );
  });

  it("is configurable, and doesn't apply when no binding is given", () => {
    expect(
      underwritingCapRefusal({
        binding: "declared",
        coverAmount: usd(9_000),
        caps: { declared: 10_000, tee: 50_000 },
      }),
    ).toBeUndefined();
    expect(() => buildQuote(input({ coverAmount: usd(15_000), bond: usd(5_000) }))).not.toThrow();
  });
});
