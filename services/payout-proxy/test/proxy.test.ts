import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalAccount,
  payoutSealKeyMessage,
  sealPayoutCredential,
  signGateReceipt,
  signPayoutLookup,
  TeeEvidence,
  teeReportData,
  verifyPayoutResult,
  type GateReceipt,
  type PayoutCredential,
  type SignedGateReceipt,
} from "@bondedhq/shared";
import { recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPayoutServer,
  FakePayoutProvider,
  MockBackend,
  PayoutLedger,
  ProxyIdentity,
} from "../src/index.js";

/**
 * The payout proxy run locally (TEE_BACKEND=mock, as the tee-agent tests run), with a fake Stripe
 * that moves no money, and receipts signed with a throwaway gate key made for this run.
 */

const CODE = `0x${"07".repeat(32)}` as const;
const NONCE = `0x${"09".repeat(32)}`;
const GATE_KEY = generatePrivateKey();
const GATE = privateKeyToAccount(GATE_KEY).address;
const ACCOUNT = randomUUID();
const TEST_KEY = `rk_test_${randomBytes(24).toString("hex")}`;
const LIVE_KEY = `rk_live_${randomBytes(24).toString("hex")}`;
// Shaped like Stripe's ids, from Stripe's Global Payouts docs; not real objects.
const DEST = "stripe:acct_1Nv0FGQ9RKHgCVdK:usba_test_61Nyd9YFBVUzLyxXZ16Nyc6oZ4SQv89Z";
const OTHER_DEST = "stripe:acct_1Nv0FGQ9RKHgCVdK:usba_test_61NydOTHERzLyxXZ16Nyc6oZ4SQv89Z";
const clock = Date.parse("2026-11-03T10:00:00Z");

const servers: { close: () => void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

const logs: string[] = [];
const texts: string[] = [];

async function serve(
  o: { allowLive?: boolean; ledgerPath?: string; provider?: FakePayoutProvider } = {},
) {
  const identity = await ProxyIdentity.create(new MockBackend(), CODE);
  const provider = o.provider ?? new FakePayoutProvider();
  const server = createPayoutServer({
    identity,
    backendName: "mock",
    provider,
    gateSigner: GATE,
    allowLiveCredentials: o.allowLive ?? false,
    ledger: new PayoutLedger({
      ...(o.ledgerPath ? { path: o.ledgerPath } : {}),
      maxAgeSeconds: 600,
      now: () => clock,
    }),
    now: () => clock,
    log: (line) => logs.push(line),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    texts.push(text);
    return { status: res.status, body: JSON.parse(text) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { identity, provider, base, post };
}

const credential = (o: Partial<PayoutCredential> = {}): PayoutCredential => ({
  provider: "stripe",
  gateAccountId: ACCOUNT,
  secretKey: TEST_KEY,
  financialAccount: "fa_test_65NybHaQx7KJxDc22rZ16NybHIZ4",
  ...o,
});

function receipt(o: Partial<GateReceipt> = {}): GateReceipt {
  return {
    decisionId: randomUUID(),
    gateAccountId: ACCOUNT,
    kind: "invoice",
    decision: "pass",
    result: "allowed",
    mode: "enforce",
    rules: [],
    amountCents: 61_240,
    payee: normalAccount(DEST),
    reference: "NIM-1",
    inputHash: `0x${"11".repeat(32)}`,
    mandateHash: `0x${"22".repeat(32)}`,
    mandateVersion: 3,
    checkedAt: Math.floor(clock / 1000) - 5,
    ...o,
  };
}

async function instruction(
  sealKey: `0x${string}`,
  o: {
    receipt?: Partial<GateReceipt>;
    signed?: SignedGateReceipt;
    destination?: string;
    credential?: Partial<PayoutCredential>;
    key?: `0x${string}`;
  } = {},
) {
  return {
    receipt: o.signed ?? (await signGateReceipt(receipt(o.receipt), o.key ?? GATE_KEY)),
    destination: o.destination ?? DEST,
    currency: "usd",
    credential: await sealPayoutCredential(credential(o.credential), sealKey),
  };
}

describe("the proxy's identity", () => {
  it("serves health, its seal key vouched for by its EVM key, and evidence", async () => {
    const { base, identity } = await serve();
    const health = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({
      ok: true,
      backend: "mock",
      codeHash: CODE,
      gateSigner: GATE,
      provider: "stripe",
      allowLiveCredentials: false,
    });
    const seal = (await (await fetch(`${base}/seal-key`)).json()) as Record<string, string>;
    expect(
      await recoverMessageAddress({
        message: payoutSealKeyMessage(CODE, seal.sealPublicKey as `0x${string}`),
        signature: seal.signature as `0x${string}`,
      }),
    ).toBe(identity.evmAddress);
    const evidence = TeeEvidence.parse(
      await (await fetch(`${base}/attestation?nonce=${NONCE}`)).json(),
    );
    // The mock's "quote" is the report data: a commitment to the code, the EVM key and the nonce.
    expect(evidence.quote).toBe(
      teeReportData({ codeHash: CODE, evmAddress: identity.evmAddress, nonce: NONCE }),
    );
    expect(evidence).not.toHaveProperty("solanaPublicKey");
    expect((await fetch(`${base}/attestation?nonce=12`)).status).toBe(400);
  });
});

describe("paying out", () => {
  it("pays a signed, allowed instruction once, exactly as the receipt says", async () => {
    const { identity, provider, post } = await serve();
    const body = await instruction(identity.sealPublicKey);
    const paid = await post("/payouts", body);
    expect(paid.status).toBe(200);
    expect(paid.body.result).toMatchObject({
      decisionId: body.receipt.receipt.decisionId,
      gateAccountId: ACCOUNT,
      status: "processing",
      amountCents: 61_240,
      destination: DEST,
      gateDecision: body.receipt.receipt.decisionId,
    });
    expect(
      await verifyPayoutResult(paid.body.result, paid.body.signature, identity.evmAddress),
    ).toBe(true);
    // The provider was asked for that amount to that recipient and payout method, case kept.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.secretKey).toBe(TEST_KEY);
    expect(provider.calls[0]!.request).toMatchObject({
      amountCents: 61_240,
      reference: "NIM-1",
      destination: {
        recipient: "acct_1Nv0FGQ9RKHgCVdK",
        payoutMethod: "usba_test_61Nyd9YFBVUzLyxXZ16Nyc6oZ4SQv89Z",
      },
    });

    // The same instruction again: refused, and nothing more is paid.
    const again = await post("/payouts", body);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ replayed: true, payoutId: paid.body.result.payoutId });
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses a tampered amount, payee or destination", async () => {
    const { identity, provider, post } = await serve();
    const signed = await signGateReceipt(receipt(), GATE_KEY);
    const tampered = (r: Partial<GateReceipt>) => ({
      ...signed,
      receipt: { ...signed.receipt, ...r },
    });
    for (const signedBody of [
      tampered({ amountCents: 9_999_999 }),
      tampered({ payee: normalAccount(OTHER_DEST) }),
      tampered({ reference: "NIM-2" }),
    ]) {
      const r = await post(
        "/payouts",
        await instruction(identity.sealPublicKey, { signed: signedBody }),
      );
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ sent: false, error: expect.stringMatching(/not signed/) });
    }
    // A good receipt, sent to another destination: refused.
    const elsewhere = await post(
      "/payouts",
      await instruction(identity.sealPublicKey, { signed, destination: OTHER_DEST }),
    );
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.body.error).toMatch(/not the payee/);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses what the gate didn't allow, didn't sign or signed long ago", async () => {
    const { identity, provider, post } = await serve();
    const cases: [Parameters<typeof instruction>[1], RegExp][] = [
      [{ receipt: { result: "blocked", decision: "breach" } }, /did not allow/],
      [{ receipt: { result: "refused", decision: "frozen" } }, /did not allow/],
      [{ receipt: { kind: "bank_change" } }, /only invoice payments/],
      [{ key: generatePrivateKey() }, /not signed/],
      [{ receipt: { checkedAt: Math.floor(clock / 1000) - 601 } }, /too old/],
      [{ receipt: { checkedAt: Math.floor(clock / 1000) + 600 } }, /too old/],
    ];
    for (const [o, error] of cases) {
      const r = await post("/payouts", await instruction(identity.sealPublicKey, o));
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(error);
    }
    // Not a Stripe destination, even if it is the receipt's payee.
    const bank = "GB29 NWBK 6016 1331 9268 19";
    const r = await post(
      "/payouts",
      await instruction(identity.sealPublicKey, {
        receipt: { payee: normalAccount(bank) },
        destination: bank,
      }),
    );
    expect(r.status).toBe(403);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses live credentials unless its own setting allows them", async () => {
    const off = await serve();
    const r = await off.post(
      "/payouts",
      await instruction(off.identity.sealPublicKey, { credential: { secretKey: LIVE_KEY } }),
    );
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/live credentials are refused/);
    expect(off.provider.calls).toHaveLength(0);
    const checked = await off.post("/credentials/check", {
      gateAccountId: ACCOUNT,
      credential: await sealPayoutCredential(
        credential({ secretKey: LIVE_KEY }),
        off.identity.sealPublicKey,
      ),
    });
    expect(checked.status).toBe(403);

    const on = await serve({ allowLive: true });
    const live = await on.post(
      "/payouts",
      await instruction(on.identity.sealPublicKey, { credential: { secretKey: LIVE_KEY } }),
    );
    expect(live.status).toBe(200);
    expect(live.body.result.livemode).toBe(true);
  });

  it("opens a credential only for its own account and seal key", async () => {
    const { identity, post, provider } = await serve();
    const other = await post(
      "/payouts",
      await instruction(identity.sealPublicKey, { credential: { gateAccountId: randomUUID() } }),
    );
    expect(other.status).toBe(403);
    expect(other.body.error).toMatch(/not sealed to this proxy for this gate account/);
    const elsewhere = await ProxyIdentity.create(new MockBackend("another-proxy"), CODE);
    const wrongKey = await post("/payouts", await instruction(elsewhere.sealPublicKey));
    expect(wrongKey.status).toBe(403);
    const notStripe = await post(
      "/payouts",
      await instruction(identity.sealPublicKey, { credential: { financialAccount: "nope" } }),
    );
    expect(notStripe.status).toBe(400);
    expect(provider.calls).toHaveLength(0);
  });

  it("says when the provider refused, and when its answer was lost", async () => {
    const { identity, provider, post } = await serve();
    const body = await instruction(identity.sealPublicKey);
    provider.next = "refuse";
    const refused = await post("/payouts", body);
    expect(refused.status).toBe(502);
    expect(refused.body).toMatchObject({ sent: false, code: "insufficient_funds" });
    // Nothing was made, so the same receipt may be tried again.
    provider.next = "unknown";
    const lost = await post("/payouts", body);
    expect(lost.status).toBe(504);
    expect(lost.body.sent).toBe("unknown");
    // A retry gets the payout the lost answer made, not a second one.
    const retried = await post("/payouts", body);
    expect(retried.status).toBe(200);
    expect(provider.payouts.size).toBe(1);
    expect(retried.body.result.payoutId).toBe([...provider.payouts.keys()][0]);
  });

  it("remembers paid decisions across a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "payout-ledger-")), "paid.jsonl");
    const provider = new FakePayoutProvider();
    const first = await serve({ ledgerPath: path, provider });
    const body = await instruction(first.identity.sealPublicKey);
    expect((await first.post("/payouts", body)).status).toBe(200);
    const second = await serve({ ledgerPath: path, provider });
    expect((await second.post("/payouts", body)).status).toBe(409);
    expect(provider.calls.filter((c) => c.method === "pay")).toHaveLength(1);
  });
});

describe("lookups and credential checks", () => {
  it("looks a payout up only for a fresh lookup the gate signed", async () => {
    const { identity, provider, post } = await serve();
    const paid = await post("/payouts", await instruction(identity.sealPublicKey));
    const payoutId = paid.body.result.payoutId as string;
    const sealed = await sealPayoutCredential(credential(), identity.sealPublicKey);
    const lookup = { gateAccountId: ACCOUNT, payoutId, issuedAt: Math.floor(clock / 1000) };
    const found = await post("/payouts/lookup", {
      lookup: await signPayoutLookup(lookup, GATE_KEY),
      credential: sealed,
    });
    expect(found.status).toBe(200);
    expect(found.body.result).toMatchObject({ payoutId, status: "processing", decisionId: "" });
    expect(
      await verifyPayoutResult(found.body.result, found.body.signature, identity.evmAddress),
    ).toBe(true);
    const stranger = await post("/payouts/lookup", {
      lookup: await signPayoutLookup(lookup, generatePrivateKey()),
      credential: sealed,
    });
    expect(stranger.status).toBe(403);
    const old = await post("/payouts/lookup", {
      lookup: await signPayoutLookup({ ...lookup, issuedAt: lookup.issuedAt - 301 }, GATE_KEY),
      credential: sealed,
    });
    expect(old.status).toBe(403);
    const missing = await post("/payouts/lookup", {
      lookup: await signPayoutLookup({ ...lookup, payoutId: "obp_test_none" }, GATE_KEY),
      credential: sealed,
    });
    expect(missing.status).toBe(404);
    expect(provider.calls.filter((c) => c.method === "lookup")).toHaveLength(2);
  });

  it("checks a sealed credential and shows only its hint", async () => {
    const { identity, post } = await serve();
    const r = await post("/credentials/check", {
      gateAccountId: ACCOUNT,
      credential: await sealPayoutCredential(credential(), identity.sealPublicKey),
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      provider: "stripe",
      livemode: false,
      keyHint: `${TEST_KEY.slice(0, 8)}…${TEST_KEY.slice(-4)}`,
      financialAccount: "fa_test_65NybHaQx7KJxDc22rZ16NybHIZ4",
    });
  });

  it("never returns or logs a credential", () => {
    expect(texts.length).toBeGreaterThan(10);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of [...texts, ...logs]) {
      expect(line).not.toContain(TEST_KEY);
      expect(line).not.toContain(LIVE_KEY);
      expect(line).not.toContain(TEST_KEY.slice(8));
    }
  });
});
