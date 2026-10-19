import {
  type Attestation,
  buildQuote,
  coverManagerAbi,
  coverPoolAbi,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  operatorBondAbi,
  type Quote,
  quoteMessage,
  quoteTypedData,
  bondedDomain,
  signQuote,
  type SignedQuote,
  testTokenAbi,
  toEvmMandateParams,
} from "@bondedhq/shared";
import { hashTypedData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANVIL_KEYS,
  type AgentVault,
  createAgentVault,
  Sandbox,
  SANDBOX_ATTESTER_KEY,
} from "../src/index.js";

/**
 * Quotes signed in TypeScript are accepted by the real CoverManager (deployed by the production
 * deploy script), and the checks that guard the signature reject anything else. The risk caps
 * themselves are covered by the Foundry tests; this proves the TypeScript side matches them.
 */

const usd = (n: number) => BigInt(n) * 1_000_000n;
const BOND = usd(10_000);
const COVER = usd(20_000);

let sandbox: Sandbox;
let vault: AgentVault;
let attestation: Attestation;
let now: number;

beforeAll(async () => {
  sandbox = await Sandbox.start();
  const d = sandbox.deployment;
  vault = await createAgentVault(sandbox);

  // The operator stakes the bond; a depositor funds the pool (the Smoke script's amounts).
  await send("operator", d.usdg, testTokenAbi, "faucet", [BOND]);
  await send("operator", d.usdg, testTokenAbi, "approve", [d.bond, BOND]);
  await send("operator", d.bond, operatorBondAbi, "stake", [vault.agentId, BOND]);
  await send("depositor", d.usdg, testTokenAbi, "faucet", [usd(500_000)]);
  await send("depositor", d.usdg, testTokenAbi, "approve", [d.pool, usd(500_000)]);
  await send("depositor", d.pool, coverPoolAbi, "deposit", [
    usd(500_000),
    sandbox.address("depositor"),
  ]);

  const mandateHash = await sandbox.publicClient.readContract({
    address: vault.address,
    abi: mandateVaultAbi,
    functionName: "mandateHash",
  });
  now = Number((await sandbox.publicClient.getBlock()).timestamp);
  attestation = {
    agentId: vault.agentId.toString(),
    score: 96,
    securityScore: 90,
    expectedLossBps: 30,
    reportHash: `0x${"ab".repeat(32)}`,
    mandateHash,
    codeHash: `0x${"cd".repeat(32)}`,
    teeMeasurement: `0x${"00".repeat(32)}`,
    modelFamily: "deepseek",
    issuedAt: now - 60,
    expiresAt: now + 30 * 24 * 60 * 60,
  };
}, 180_000);

afterAll(async () => {
  await sandbox?.stop();
});

async function send(
  role: "operator" | "depositor",
  address: `0x${string}`,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
) {
  const wallet = sandbox.wallet(role);
  const { request } = await sandbox.publicClient.simulateContract({
    address,
    abi: abi as never,
    functionName: functionName as never,
    args: args as never,
    account: wallet.account,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await sandbox.publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
}

function sign(quote: Quote, attesterKey: `0x${string}` = SANDBOX_ATTESTER_KEY) {
  return signQuote(quote, {
    chainId: sandbox.chain.id,
    coverManager: sandbox.deployment.coverManager,
    attesterKey,
  });
}

function quote(overrides: { now?: number; nonce?: bigint } = {}) {
  return buildQuote({
    attestation,
    vault: vault.address,
    coverAmount: COVER,
    bond: BOND,
    now: overrides.now ?? now,
    nonce: overrides.nonce,
  }).quote;
}

function buyCover(signed: SignedQuote) {
  return send("operator", sandbox.deployment.coverManager, coverManagerAbi, "buyCover", [
    quoteMessage(signed.quote),
    signed.signature,
  ]);
}

describe("quotes against the deployed CoverManager", () => {
  it("hash to the same EIP-712 digest as the contract", async () => {
    const q = quote({ nonce: 1n });
    const onChain = await sandbox.publicClient.readContract({
      address: sandbox.deployment.coverManager,
      abi: coverManagerAbi,
      functionName: "quoteDigest",
      args: [quoteMessage(q)],
    });
    const offChain = hashTypedData(
      quoteTypedData(bondedDomain(sandbox.chain.id, sandbox.deployment.coverManager), q),
    );
    expect(offChain).toBe(onChain);
  });

  it("rejects a quote signed by a key that isn't an attester", async () => {
    await expect(buyCover(await sign(quote(), ANVIL_KEYS.agent))).rejects.toThrow(/NotAttester/);
  });

  it("rejects a quote changed after signing", async () => {
    const signed = await sign(quote());
    const cheaper = { ...signed, quote: { ...signed.quote, premiumRateBps: 1 } };
    // The signature now recovers to some other address, which isn't an attester.
    await expect(buyCover(cheaper)).rejects.toThrow(/NotAttester/);
  });

  it("rejects an expired quote", async () => {
    const stale = await sign(quote({ now: now - 2 * 60 * 60 }));
    await expect(buyCover(stale)).rejects.toThrow(/QuoteExpired/);
  });

  it("enforces the quote's minBond, which covers the agent's other policies", async () => {
    // As if the agent already had 90,000 of cover elsewhere: 10% of 110,000 is above the bond.
    const q = buildQuote({
      attestation,
      vault: vault.address,
      coverAmount: COVER,
      bond: usd(11_000),
      existingCover: usd(90_000),
      now,
    }).quote;
    expect(BigInt(q.minBond)).toBeGreaterThan(BOND);
    await expect(buyCover(await sign(q))).rejects.toThrow(/InsufficientBond/);
  });

  it("binds cover at the quoted terms, once", async () => {
    const signed = await sign(quote());
    await buyCover(signed);

    const policyId = await sandbox.publicClient.readContract({
      address: sandbox.deployment.coverManager,
      abi: coverManagerAbi,
      functionName: "activePolicyOf",
      args: [vault.address],
    });
    const policy = await sandbox.publicClient.readContract({
      address: sandbox.deployment.coverManager,
      abi: coverManagerAbi,
      functionName: "getPolicy",
      args: [policyId],
    });
    expect(policy.coverAmount).toBe(COVER);
    // 0.30% EL → 1.19% base; a 50% bond earns the full 30% discount → 84 bps.
    expect(policy.premiumRateBps).toBe(84);
    expect(policy.score).toBe(96);

    await expect(buyCover(signed)).rejects.toThrow(/QuoteAlreadyUsed/);
  });

  // Runs after the test above, which bound 20,000 of cover on the first vault.
  it("prices a second vault for the same agent against the agent's real active cover", async () => {
    const d = sandbox.deployment;
    // A second vault under the same agent id and mandate, so the attestation still matches it.
    const created = await sandbox.publicClient.simulateContract({
      address: d.factory,
      abi: mandateVaultFactoryAbi,
      functionName: "createVault",
      args: [
        toEvmMandateParams(vault.mandate),
        sandbox.address("agent"),
        sandbox.address("operator"),
        vault.agentId,
        "Arena Agent Vault 2",
        "aVAULT2",
      ],
      account: sandbox.wallet("operator").account,
    });
    await send("operator", d.factory, mandateVaultFactoryAbi, "createVault", created.request.args);
    const secondVault = created.result;
    expect(secondVault).not.toBe(vault.address);

    const existingCover = await sandbox.publicClient.readContract({
      address: d.coverManager,
      abi: coverManagerAbi,
      functionName: "activeCoverOfAgent",
      args: [vault.agentId],
    });
    expect(existingCover).toBe(COVER);

    const { quote: second, pricing } = buildQuote({
      attestation,
      vault: secondVault,
      coverAmount: COVER,
      bond: BOND,
      existingCover,
      now,
    });
    // The 10,000 bond is now measured against 40,000 of total cover: a 25% ratio, so a 15%
    // discount (0.0119 × 0.85 = 0.010115 → 102 bps) instead of the first vault's 30% (84 bps).
    expect(pricing.bondRatio).toBe(0.25);
    expect(second.premiumRateBps).toBe(102);
    // 10% of the agent's total cover, not just this vault's.
    expect(second.minBond).toBe(usd(4_000).toString());

    await buyCover(await sign(second));

    const policyId = await sandbox.publicClient.readContract({
      address: d.coverManager,
      abi: coverManagerAbi,
      functionName: "activePolicyOf",
      args: [secondVault],
    });
    const policy = await sandbox.publicClient.readContract({
      address: d.coverManager,
      abi: coverManagerAbi,
      functionName: "getPolicy",
      args: [policyId],
    });
    expect(policy.vault).toBe(secondVault);
    expect(policy.coverAmount).toBe(COVER);
    expect(policy.premiumRateBps).toBe(102);
    expect(
      await sandbox.publicClient.readContract({
        address: d.coverManager,
        abi: coverManagerAbi,
        functionName: "activeCoverOfAgent",
        args: [vault.agentId],
      }),
    ).toBe(2n * COVER);
  });
});
