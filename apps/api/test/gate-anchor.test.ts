import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANVIL_KEYS, CONTRACTS_DIR } from "@bonded/arena";
import {
  GateAnchorJob,
  connectChain,
  connectGateAnchor,
  type GateAnchorTarget,
} from "@bonded/keeper";
import {
  evaluateGateInput,
  gateAccountKey,
  gateAnchorAbi,
  gateDayNumber,
  gateInputHash,
  gateLogRoot,
  gateReceiptHash,
  parseEvmDeployment,
  selfServeMessage,
  verifyGateLogProof,
  verifyGateReceipt,
  type GateInput,
  type GateLogProof,
  type SignedGateReceipt,
} from "@bondedhq/shared";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import { postgres } from "./postgres.js";

const TOKEN = "gate-anchor-test-token-at-least-24-chars";
// Throwaway keys, made for this run.
const RECEIPT_KEY = generatePrivateKey();
const RECEIPT_SIGNER = privateKeyToAccount(RECEIPT_KEY).address;
const owner = privateKeyToAccount(generatePrivateKey());

const deployment = parseEvmDeployment(
  readFileSync(new URL("../../../contracts/evm/deployments/46630.json", import.meta.url), "utf8"),
);
const chain = connectChain(deployment, "http://127.0.0.1:1", ANVIL_KEYS.deployer);

const NIMBUS = "GB29 NWBK 6016 1331 9268 19";
const FRAUD = "LT12 1000 0111 0100 1000";
const DAY = "2026-11-02";
/** When the keeper runs: a quarter of an hour into the next day, past the 10-minute grace. */
const NEXT_MORNING = Date.parse("2026-11-03T00:15:00Z");

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
let clock = Date.parse(`${DAY}T10:00:00Z`);
const wide = { perClient: 100_000, total: 1_000_000, windowMs: 600_000 };

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: string, path: string, body?: unknown, auth?: string) {
  const res = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

let session: string | undefined;
async function sessionFor(who: PrivateKeyAccount) {
  if (session) return session;
  const timestamp = Math.floor(clock / 1000);
  const signature = await who.signMessage({
    message: selfServeMessage({
      action: "sign-in",
      chainId: chain.deployment.chainId,
      wallet: who.address,
      timestamp,
    }),
  });
  const r = await call("POST", "/self/session", { wallet: who.address, timestamp, signature });
  expect(r.status).toBe(201);
  session = r.body.session as string;
  return session;
}

/** A gate account with Nimbus as a vendor and invoice NIM-1 approved for $612.40. */
async function gateAccount() {
  const s = await sessionFor(owner);
  const made = await call(
    "POST",
    "/gate/accounts",
    { name: "Acme AP", mode: "enforce", maxPaymentUsd: 5_000, maxDailyUsd: 8_000 },
    s,
  );
  const id = made.body.account.id as string;
  const base = `/gate/accounts/${id}`;
  await call("POST", `${base}/vendors`, { id: "nimbus", name: "Nimbus", account: NIMBUS }, s);
  await call(
    "POST",
    `${base}/invoices`,
    { vendorId: "nimbus", reference: "NIM-1", amountUsd: 612.4 },
    s,
  );
  return { id, key: made.body.apiKey.key as string, session: s, base };
}

/** Three checks a minute apart on DAY: a pass, a block and a duplicate. Their decision ids. */
async function dayOfChecks(key: string) {
  const ids: string[] = [];
  for (const [account, amountUsd] of [
    [NIMBUS, 612.4],
    [FRAUD, 612.4],
    [NIMBUS, 612.4],
  ] as const) {
    clock += 60_000;
    const r = await call(
      "POST",
      "/payments/check",
      { account, amountUsd, invoiceReference: "NIM-1" },
      key,
    );
    expect(r.status).toBe(200);
    ids.push(r.body.id);
  }
  return ids;
}

const keeper = (now: number, target?: GateAnchorTarget) =>
  new GateAnchorJob(pg.db, target, { now: () => now });

beforeAll(async () => {
  pg = await postgres();
  app = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: TOKEN,
    selfServe: { now: () => clock },
    ownerRequests: { writes: wide, reads: wide },
    gate: { receiptKey: RECEIPT_KEY, maxAccountsPerOwner: 100 },
  });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe("the payment gate's log roots", () => {
  it("makes a finished day's root once, after the grace period, and stores it unposted", async () => {
    const { id, key } = await gateAccount();
    const ids = await dayOfChecks(key);
    // Not before the day has ended and ten minutes have passed.
    expect((await keeper(Date.parse(`${DAY}T23:59:00Z`)).tick()).sealed).toBe(0);
    expect((await keeper(Date.parse("2026-11-03T00:05:00Z")).tick()).sealed).toBe(0);
    const first = await keeper(NEXT_MORNING).tick();
    expect(first).toMatchObject({ posted: 0, failed: 0 });
    expect(first.sealed).toBeGreaterThanOrEqual(1);
    expect((await keeper(NEXT_MORNING).tick()).sealed).toBe(0);

    const store = keeper(NEXT_MORNING).store;
    const root = await store.logRoot(id, DAY);
    const receipts = await Promise.all(
      ids.map(
        async (d) => (await call("GET", `/payments/decisions/${d}`, undefined, key)).body.receipt,
      ),
    );
    expect(root).toMatchObject({
      day: DAY,
      receipts: 3,
      root: gateLogRoot(receipts.map((r: SignedGateReceipt) => gateReceiptHash(r.receipt))),
      posted: null,
    });
  });

  it("gives the owner and the agent a proof, and the receipt checks offline end to end", async () => {
    const { id, key, base, session: s } = await gateAccount();
    const [, blocked] = await dayOfChecks(key);
    await keeper(NEXT_MORNING).tick();

    const proof = await call("GET", `/payments/decisions/${blocked}/proof`, undefined, key);
    expect(proof.status).toBe(200);
    expect(proof.body).toMatchObject({
      decisionId: blocked,
      accountKey: gateAccountKey(id),
      day: DAY,
      dayNumber: gateDayNumber(DAY),
      proof: { index: 1, count: 3 },
      posted: null,
    });
    // The owner gets the same proof.
    expect((await call("GET", `${base}/decisions/${blocked}/proof`, undefined, s)).body).toEqual(
      proof.body,
    );

    // The decision checks out: Bonded's signature, the input's hash, the rules, and the root.
    const d = (await call("GET", `/payments/decisions/${blocked}`, undefined, key)).body;
    const receipt = d.receipt as SignedGateReceipt;
    expect(await verifyGateReceipt(receipt, RECEIPT_SIGNER)).toBe(true);
    expect(gateInputHash(d.input as GateInput)).toBe(receipt.receipt.inputHash);
    expect(evaluateGateInput(d.input as GateInput)).toMatchObject({ rules: receipt.receipt.rules });
    const roots = (await call("GET", `/gate/anchors/${id}/roots`)).body;
    const p = proof.body.proof as GateLogProof;
    expect(gateReceiptHash(receipt.receipt)).toBe(proof.body.receiptHash);
    expect(verifyGateLogProof(gateReceiptHash(receipt.receipt), p, roots.items[0].root)).toBe(true);
    // A tampered receipt fails each check it touches.
    const tampered = { ...receipt.receipt, amountCents: 1 };
    expect(await verifyGateReceipt({ ...receipt, receipt: tampered }, RECEIPT_SIGNER)).toBe(false);
    expect(verifyGateLogProof(gateReceiptHash(tampered), p, roots.items[0].root)).toBe(false);

    // Nobody else gets it.
    const other = await gateAccount();
    expect(
      (await call("GET", `/payments/decisions/${blocked}/proof`, undefined, other.key)).status,
    ).toBe(404);
    expect((await call("GET", `/payments/decisions/${blocked}/proof`)).status).toBe(401);
    expect(
      (await call("GET", `${other.base}/decisions/${blocked}/proof`, undefined, s)).status,
    ).toBe(404);
  });

  it("says when a day has no root yet, and when its log can't be proved any more", async () => {
    const { key } = await gateAccount();
    const ids = await dayOfChecks(key);
    const early = await call("GET", `/payments/decisions/${ids[0]}/proof`, undefined, key);
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/no log root yet/);

    await keeper(NEXT_MORNING).tick();
    expect((await call("GET", `/payments/decisions/${ids[0]}/proof`, undefined, key)).status).toBe(
      200,
    );
    // One decision of the day is deleted (retention): the rest can't be proved against the root.
    await pg.db.pool.query("DELETE FROM gate_decisions WHERE id=$1", [ids[2]]);
    const gone = await call("GET", `/payments/decisions/${ids[0]}/proof`, undefined, key);
    expect(gone.status).toBe(409);
    expect(gone.body.error).toMatch(/no longer matches its root/);
  });

  it("publishes each account's roots and mandate hashes to anyone, and nothing they cover", async () => {
    const { id, key, base, session: s } = await gateAccount();
    await dayOfChecks(key);
    await keeper(NEXT_MORNING).tick();
    const roots = await call("GET", `/gate/anchors/${id}/roots`);
    expect(roots.status).toBe(200);
    expect(roots.body).toMatchObject({ accountId: id, accountKey: gateAccountKey(id), next: null });
    expect(roots.body.items).toEqual([
      {
        day: DAY,
        dayNumber: gateDayNumber(DAY),
        root: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        posted: null,
      },
    ]);

    const mandates = await call("GET", `/gate/anchors/${id}/mandates`);
    const owners = (await call("GET", `${base}/mandates`, undefined, s)).body.items;
    // Version 1 (the account) and 2 (Nimbus added), the same hashes the owner sees.
    expect(mandates.body.items.map((m: Body) => [m.version, m.hash])).toEqual(
      owners.map((m: Body) => [m.version, m.hash]),
    );
    expect(Object.keys(mandates.body.items[0]).sort()).toEqual([
      "createdAt",
      "hash",
      "posted",
      "version",
    ]);

    expect((await call("GET", `/gate/anchors/${crypto.randomUUID()}/roots`)).status).toBe(404);
    expect((await call("GET", "/gate/anchors/not-an-id/mandates")).status).toBe(404);
    expect((await call("GET", `/gate/anchors/${id}/roots?before=2026-13-01`)).status).toBe(400);
  });
});

/** A fresh anvil chain, its clock on 4 November so the 2nd has ended on chain too. */
async function startAnvil(): Promise<{
  process: ChildProcess;
  rpcUrl: string;
  read: PublicClient;
}> {
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address() as { port: number };
      s.close(() => resolve(a.port));
    });
  });
  const timestamp = String(Date.parse("2026-11-04T00:00:00Z") / 1000);
  const process = spawn("anvil", ["--port", String(port), "--silent", "--timestamp", timestamp], {
    stdio: "ignore",
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const read = createPublicClient({
    transport: http(rpcUrl, { retryCount: 0 }),
    pollingInterval: 50,
  });
  for (let i = 0; ; i++) {
    try {
      await read.getChainId();
      break;
    } catch (error) {
      if (i > 100) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { process, rpcUrl, read };
}

describe("posting to GateAnchor", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let address: Address;
  let target: GateAnchorTarget;
  const poster = privateKeyToAccount(ANVIL_KEYS.operator);

  beforeAll(async () => {
    anvil = await startAnvil();
    const artifact = JSON.parse(
      readFileSync(`${CONTRACTS_DIR}out/GateAnchor.sol/GateAnchor.json`, "utf8"),
    ) as { bytecode: { object: Hex } };
    const localChain = defineChain({
      id: await anvil.read.getChainId(),
      name: "anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [anvil.rpcUrl] } },
    });
    const deployer = createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS.deployer),
      chain: localChain,
      transport: http(anvil.rpcUrl),
    });
    const hash = await deployer.deployContract({
      abi: gateAnchorAbi,
      bytecode: artifact.bytecode.object,
      args: [deployer.account.address],
    });
    address = (await anvil.read.waitForTransactionReceipt({ hash })).contractAddress!;
    await anvil.read.waitForTransactionReceipt({
      hash: await deployer.writeContract({
        address,
        abi: gateAnchorAbi,
        functionName: "setPoster",
        args: [poster.address, true],
      }),
    });
    target = await connectGateAnchor(deployment, anvil.rpcUrl, ANVIL_KEYS.operator, address);
  }, 120_000);
  afterAll(() => {
    anvil?.process.kill();
  });

  const onChainRoot = (id: string) =>
    anvil.read.readContract({
      address,
      abi: gateAnchorAbi,
      functionName: "logRootOf",
      args: [gateAccountKey(id) as Hex, gateDayNumber(DAY)],
    });

  it("refuses an address without a contract", async () => {
    await expect(
      connectGateAnchor(deployment, anvil.rpcUrl, ANVIL_KEYS.operator, poster.address),
    ).rejects.toThrow(/no contract/);
  });

  it("posts every mandate hash and root once, and anyone can check a receipt on chain", async () => {
    const { id, key } = await gateAccount();
    const [first] = await dayOfChecks(key);
    const result = await keeper(NEXT_MORNING, target).tick();
    expect(result.failed).toBe(0);
    expect(result.posted).toBeGreaterThanOrEqual(3);
    // Nothing is left unposted, and a second pass sends nothing.
    const store = keeper(NEXT_MORNING).store;
    expect(await store.unpostedMandates()).toEqual([]);
    expect(await store.unpostedRoots()).toEqual([]);
    expect(await keeper(NEXT_MORNING, target).tick()).toEqual({ sealed: 0, posted: 0, failed: 0 });

    const stored = (await store.logRoot(id, DAY))!;
    expect(stored.posted).toMatchObject({
      chainId: 31337,
      contract: address.toLowerCase(),
      txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect((await onChainRoot(id)).hash).toBe(stored.root);
    const versions = (await call("GET", `/gate/anchors/${id}/mandates`)).body.items as Body[];
    for (const v of versions) {
      expect(v.posted).toMatchObject({ chainId: 31337 });
      const onChain = await anvil.read.readContract({
        address,
        abi: gateAnchorAbi,
        functionName: "mandateHashOf",
        args: [gateAccountKey(id) as Hex, BigInt(v.version)],
      });
      expect(onChain.hash).toBe(v.hash);
    }

    // The API's proof checks on chain; an edited receipt doesn't.
    const proof = (await call("GET", `/payments/decisions/${first}/proof`, undefined, key)).body;
    expect(proof.posted).toMatchObject({ chainId: 31337 });
    const receipt = (await call("GET", `/payments/decisions/${first}`, undefined, key)).body
      .receipt as SignedGateReceipt;
    const check = (receiptHash: Hex) =>
      anvil.read.readContract({
        address,
        abi: gateAnchorAbi,
        functionName: "verifyReceipt",
        args: [
          gateAccountKey(id) as Hex,
          gateDayNumber(DAY),
          receiptHash,
          BigInt(proof.proof.index),
          BigInt(proof.proof.count),
          proof.proof.siblings,
        ],
      });
    expect(await check(gateReceiptHash(receipt.receipt))).toBe(true);
    expect(
      await check(gateReceiptHash({ ...receipt.receipt, payee: "LT121000011101001000" })),
    ).toBe(false);
  });

  it("never overwrites a different hash, and records a hash already there as posted", async () => {
    const { id, key } = await gateAccount();
    await dayOfChecks(key);
    await keeper(NEXT_MORNING).tick();
    const store = keeper(NEXT_MORNING).store;
    const stored = (await store.logRoot(id, DAY))!;
    const [v1] = (await store.mandates(id)).items.filter((v) => v.version === 1);
    // Someone with the poster key posted a different root, and the right hash for version 1.
    const wallet = target.chain;
    const other = `0x${"ab".repeat(32)}` as Hex;
    await wallet.send(address, gateAnchorAbi, "postLogRoot", [
      gateAccountKey(id),
      gateDayNumber(DAY),
      other,
    ]);
    await wallet.send(address, gateAnchorAbi, "postMandate", [gateAccountKey(id), 1n, v1!.hash]);

    await keeper(NEXT_MORNING, target).tick();
    const after = (await store.logRoot(id, DAY))!;
    expect(after.posted).toBeNull();
    expect(after.postError).toBe("a different hash is already posted on chain for this");
    expect((await onChainRoot(id)).hash).toBe(other);
    expect(after.root).toBe(stored.root);
    const version1 = (await store.mandates(id)).items.find((v) => v.version === 1)!;
    expect(version1.posted).toMatchObject({ chainId: 31337, txHash: null });
  });

  it("never posts a mandate whose stored hash doesn't match, and names the contract's refusal", async () => {
    const { id } = await gateAccount();
    // The stored mandate was changed after it was hashed.
    await pg.db.pool.query(
      `UPDATE gate_mandates SET mandate=jsonb_set(mandate,'{maxPaymentCents}','1') WHERE account_id=$1 AND version=1`,
      [id],
    );
    // A key GateAnchor doesn't allow.
    const stranger = await connectGateAnchor(
      deployment,
      anvil.rpcUrl,
      ANVIL_KEYS.depositor,
      address,
    );
    await keeper(NEXT_MORNING, stranger).tick();
    const versions = (await keeper(NEXT_MORNING).store.mandates(id)).items;
    expect(versions.find((v) => v.version === 1)).toMatchObject({
      posted: null,
      postError: "the stored mandate doesn't match its hash",
    });
    expect(versions.find((v) => v.version === 2)).toMatchObject({
      posted: null,
      postError: "GateAnchor refused it (NotPoster); will retry",
    });
  });
});
