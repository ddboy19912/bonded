import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  isLivePayoutKey,
  isSealedPayoutCredential,
  isTestPayoutKey,
  normalAccount,
  payoutKeyHint,
  verifyGateReceipt,
  verifyPayoutLookup,
  type PayoutCredential,
  type PayoutResult,
  type SignedGateReceipt,
  type SignedPayoutLookup,
} from "@bondedhq/shared";
import type { Address } from "viem";
import { z } from "zod";
import type { ProxyIdentity } from "./identity.js";
import type { PayoutLedger } from "./ledger.js";
import {
  ProviderRefused,
  ProviderUnknown,
  type PayoutProvider,
  type PayoutRecord,
} from "./provider.js";

/**
 * The proxy's HTTP face. Read-only: `/health`, `/attestation?nonce=` (fresh TDX evidence) and
 * `/seal-key`. Then three routes that use a sealed credential, each opened inside the TEE for
 * that one request and never returned, logged or stored:
 *
 * - `POST /payouts` pays out one gate decision. Only when the receipt is signed by the gate's
 *   receipt key, allows the payment (`result: "allowed"`, an invoice or a refund), is fresh, was
 *   not paid before, and its payee is exactly the destination asked for. The amount and reference
 *   come from the signed receipt, never from anywhere else.
 * - `POST /payouts/lookup` reads one payout from the provider, for a lookup the gate signed.
 * - `POST /credentials/check` says whether a sealed credential opens and is acceptable, with the
 *   key's hint (for the owner's page).
 *
 * Live-mode credentials are refused unless the proxy itself runs with
 * GATE_ALLOW_LIVE_CREDENTIALS=true (set in its measured compose file).
 */

export interface PayoutServerOptions {
  identity: ProxyIdentity;
  backendName: string;
  provider: PayoutProvider;
  /** The gate's receipt key address (GATE_RECEIPT_ADDRESS): the only signer obeyed. */
  gateSigner: Address;
  allowLiveCredentials: boolean;
  ledger: PayoutLedger;
  /** How old a receipt may be, in seconds (default 600). */
  maxReceiptAgeSeconds?: number;
  now?: () => number;
  /** Operational lines: decision ids, payout ids and reasons only. */
  log?: (line: string) => void;
}

const NONCE = /^(0x)?[0-9a-fA-F]{64}$/;
const MAX_BODY = 64 * 1024;
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const accountId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

const SignedReceipt = z.strictObject({
  receipt: z.strictObject({
    decisionId: z.string().max(64),
    gateAccountId: accountId,
    kind: z.string().max(20),
    decision: z.string().max(20),
    result: z.string().max(20),
    mode: z.string().max(20),
    rules: z.array(z.string().max(64)).max(10),
    amountCents: z.number().int(),
    payee: z.string().max(200),
    reference: z.string().max(200),
    inputHash: hex,
    mandateHash: hex,
    mandateVersion: z.number().int(),
    checkedAt: z.number().int(),
  }),
  signer: hex,
  signature: hex,
});
const Sealed = z.custom<Parameters<ProxyIdentity["open"]>[0]>(isSealedPayoutCredential);
const Instruction = z.strictObject({
  receipt: SignedReceipt,
  destination: z.string().max(200),
  currency: z.literal("usd"),
  credential: Sealed,
});
const Lookup = z.strictObject({
  lookup: z.strictObject({
    lookup: z.strictObject({
      gateAccountId: accountId,
      payoutId: z.string().max(200),
      issuedAt: z.number().int(),
    }),
    signer: hex,
    signature: hex,
  }),
  credential: Sealed,
});
const CredentialCheck = z.strictObject({ gateAccountId: accountId, credential: Sealed });

/** An answer the proxy gives: its status code and JSON body. */
class Answer extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? status));
  }
}
const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): never => {
  throw new Answer(status, { error, sent: false, ...extra });
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Answer(413, { error: "the body is too large", sent: false }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Answer(400, { error: "the body is not JSON", sent: false }));
      }
    });
    req.on("error", () => reject(new Answer(400, { error: "bad request", sent: false })));
  });
}

export function createPayoutServer(options: PayoutServerOptions): Server {
  const { identity, provider, ledger } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  const maxAge = options.maxReceiptAgeSeconds ?? 600;

  /** Open the sealed credential for this account and check it is one the proxy may use. */
  const credentialFor = async (
    sealed: z.infer<typeof Sealed>,
    gateAccountId: string,
  ): Promise<PayoutCredential> => {
    let credential: PayoutCredential;
    try {
      credential = await identity.open(sealed, gateAccountId);
    } catch {
      return refuse(403, "the credential is not sealed to this proxy for this gate account");
    }
    if (credential.provider !== provider.name || !provider.validCredential(credential))
      return refuse(400, "the sealed credential is not a valid credential for this provider");
    if (isLivePayoutKey(credential.secretKey)) {
      if (!options.allowLiveCredentials)
        return refuse(
          403,
          "live credentials are refused: this proxy takes test-mode credentials only",
        );
    } else if (!isTestPayoutKey(credential.secretKey))
      return refuse(400, "the credential is neither a test nor a live key");
    return credential;
  };

  const signed = async (result: PayoutResult) => ({
    result,
    signer: identity.evmAddress,
    signature: await identity.signResult(result),
  });

  const resultOf = (
    record: PayoutRecord,
    decisionId: string,
    gateAccountId: string,
  ): PayoutResult => ({
    decisionId,
    gateAccountId,
    provider: provider.name,
    payoutId: record.id,
    status: record.status,
    amountCents: record.amountCents,
    currency: record.currency,
    destination: record.destination,
    gateDecision: record.gateDecision,
    livemode: record.livemode,
  });

  async function payout(raw: unknown) {
    const parsed = Instruction.safeParse(raw);
    if (!parsed.success) return refuse(400, "that is not a payout instruction");
    const { receipt: signedReceipt, destination, credential: sealed } = parsed.data;
    const r = signedReceipt.receipt;
    const why = (reason: string) => {
      log(`payout: refused decision ${r.decisionId}: ${reason}`);
      return refuse(403, reason);
    };
    if (!(await verifyGateReceipt(signedReceipt as SignedGateReceipt, options.gateSigner)))
      return why("the receipt is not signed by the payment gate's receipt key");
    if (r.result !== "allowed") return why("the gate did not allow this payment");
    if (r.kind !== "invoice" && r.kind !== "refund")
      return why("only invoice payments and refunds are paid out");
    if (!Number.isSafeInteger(r.amountCents) || r.amountCents <= 0)
      return why("the receipt has no positive amount");
    if (!r.reference.trim()) return why("the receipt has no reference");
    if (normalAccount(destination) !== r.payee)
      return why("the destination is not the payee the gate allowed");
    const to = provider.destination(destination);
    if (!to) return why(`the payee is not a ${provider.name} payout destination`);
    const nowSeconds = Math.floor(now() / 1000);
    if (r.checkedAt > nowSeconds + 60 || nowSeconds - r.checkedAt > maxAge)
      return why("the receipt is too old to pay out");
    const credential = await credentialFor(sealed, r.gateAccountId);
    const claim = ledger.claim(r.decisionId);
    if (!claim.ok) {
      log(`payout: refused decision ${r.decisionId}: already paid out`);
      throw new Answer(409, {
        error: "this decision was already paid out",
        replayed: true,
        ...(claim.payoutId ? { payoutId: claim.payoutId } : {}),
      });
    }
    let record: PayoutRecord;
    try {
      record = await provider.pay(credential, {
        decisionId: r.decisionId,
        gateAccountId: r.gateAccountId,
        amountCents: r.amountCents,
        currency: "usd",
        destination: to,
        reference: r.reference,
      });
    } catch (error) {
      ledger.release(r.decisionId);
      if (error instanceof ProviderRefused) {
        log(`payout: ${provider.name} refused decision ${r.decisionId} (${error.code})`);
        return refuse(502, "the provider refused the payout", { code: error.code });
      }
      log(
        `payout: decision ${r.decisionId} outcome unknown: ${error instanceof ProviderUnknown ? error.message : "error"}`,
      );
      throw new Answer(504, { error: "the provider's answer was lost", sent: "unknown" });
    }
    ledger.done(r.decisionId, record.id);
    log(`payout: paid decision ${r.decisionId} as ${record.id} (${record.status})`);
    return signed(resultOf(record, r.decisionId, r.gateAccountId));
  }

  async function lookup(raw: unknown) {
    const parsed = Lookup.safeParse(raw);
    if (!parsed.success) return refuse(400, "that is not a payout lookup");
    const l = parsed.data.lookup as SignedPayoutLookup;
    if (!(await verifyPayoutLookup(l, options.gateSigner)))
      return refuse(403, "the lookup is not signed by the payment gate's receipt key");
    if (Math.abs(Math.floor(now() / 1000) - l.lookup.issuedAt) > 300)
      return refuse(403, "the lookup is too old");
    const credential = await credentialFor(parsed.data.credential, l.lookup.gateAccountId);
    try {
      const record = await provider.lookup(credential, l.lookup.payoutId);
      return signed(resultOf(record, "", l.lookup.gateAccountId));
    } catch (error) {
      if (error instanceof ProviderRefused)
        return refuse(404, "the provider has no such payout", { code: error.code });
      throw new Answer(504, { error: "the provider did not answer" });
    }
  }

  async function check(raw: unknown) {
    const parsed = CredentialCheck.safeParse(raw);
    if (!parsed.success) return refuse(400, "that is not a credential check");
    const c = await credentialFor(parsed.data.credential, parsed.data.gateAccountId);
    return {
      provider: c.provider,
      livemode: isLivePayoutKey(c.secretKey),
      keyHint: payoutKeyHint(c.secretKey),
      financialAccount: c.financialAccount,
    };
  }

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://proxy.local");
    } catch {
      return send(400, { error: "bad request" });
    }
    const run = (work: () => Promise<unknown>) =>
      work().then(
        (body) => send(200, body),
        (error: unknown) => {
          if (error instanceof Answer) return send(error.status, error.body);
          log(`payout: ${url.pathname} failed: ${error instanceof Error ? error.name : "error"}`);
          // An unexpected failure on a payout may come after the provider paid: say "unknown",
          // so the gate keeps the invoice held until the provider reports.
          send(500, {
            error: "internal error",
            sent: url.pathname === "/payouts" ? "unknown" : false,
          });
        },
      );
    if (req.method === "GET") {
      if (url.pathname === "/health")
        return send(200, {
          ok: true,
          backend: options.backendName,
          codeHash: identity.codeHash,
          evmAddress: identity.evmAddress,
          sealPublicKey: identity.sealPublicKey,
          gateSigner: options.gateSigner,
          provider: provider.name,
          allowLiveCredentials: options.allowLiveCredentials,
        });
      if (url.pathname === "/seal-key")
        return send(200, {
          codeHash: identity.codeHash,
          evmAddress: identity.evmAddress,
          sealPublicKey: identity.sealPublicKey,
          signature: identity.sealKeySignature,
        });
      if (url.pathname === "/attestation") {
        const nonce = url.searchParams.get("nonce") ?? "";
        if (!NONCE.test(nonce))
          return send(400, {
            error: "nonce must be 32 bytes of hex (the caller's random challenge)",
          });
        identity.attest(nonce).then(
          (evidence) => send(200, evidence),
          () => send(503, { error: "attestation unavailable" }),
        );
        return;
      }
      return send(404, { error: "not found" });
    }
    if (req.method !== "POST") return send(405, { error: "method not allowed" });
    const routes: Record<string, (raw: unknown) => Promise<unknown>> = {
      "/payouts": payout,
      "/payouts/lookup": lookup,
      "/credentials/check": check,
    };
    const route = routes[url.pathname];
    if (!route) return send(404, { error: "not found" });
    run(async () => route(await readBody(req)));
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  return server;
}
