import { isAddress } from "viem";
import { DstackBackend, MockBackend, type TeeBackend } from "./backend.js";
import { FakePayoutProvider } from "./fake.js";
import { ProxyIdentity } from "./identity.js";
import { PayoutLedger } from "./ledger.js";
import type { PayoutProvider } from "./provider.js";
import { createPayoutServer } from "./server.js";
import { stripePayouts } from "./stripe.js";

/**
 * Settings, all from the environment, which on Phala is the compose file the hardware measures:
 *
 * - CODE_HASH: baked into the image (Dockerfile).
 * - GATE_RECEIPT_ADDRESS: the payment gate's receipt key address (`GET /gate/receipt-key`). The
 *   proxy pays only what that key signed.
 * - GATE_ALLOW_LIVE_CREDENTIALS: "true" accepts live provider keys. Anything else: test mode only.
 * - TEE_BACKEND: dstack (default) or mock (no hardware, for local runs).
 * - PAYOUT_PROVIDER: stripe (default) or fake (moves no money; only with TEE_BACKEND=mock).
 * - PAYOUT_LEDGER_PATH: where paid decisions are remembered across a restart (optional).
 * - PAYOUT_MAX_RECEIPT_AGE_SECONDS: how old a receipt may be (default 600).
 * - STRIPE_PAYOUTS_API_VERSION: the Stripe-Version sent (default in stripe.ts).
 */
async function main(): Promise<void> {
  const mode = process.env.TEE_BACKEND ?? "dstack";
  if (mode !== "dstack" && mode !== "mock") throw new Error(`unknown TEE_BACKEND ${mode}`);
  const backend: TeeBackend = mode === "mock" ? new MockBackend() : new DstackBackend();
  if (mode === "mock") console.warn("TEE_BACKEND=mock: no hardware, no real quote, not a TEE.");
  const gateSigner = process.env.GATE_RECEIPT_ADDRESS?.trim() ?? "";
  if (!isAddress(gateSigner))
    throw new Error("GATE_RECEIPT_ADDRESS must be the payment gate's receipt key address");
  const which = process.env.PAYOUT_PROVIDER ?? "stripe";
  if (which === "fake" && mode !== "mock")
    throw new Error("PAYOUT_PROVIDER=fake runs only with TEE_BACKEND=mock");
  if (which !== "stripe" && which !== "fake") throw new Error(`unknown PAYOUT_PROVIDER ${which}`);
  const provider: PayoutProvider =
    which === "fake"
      ? new FakePayoutProvider()
      : stripePayouts(
          process.env.STRIPE_PAYOUTS_API_VERSION?.trim()
            ? { apiVersion: process.env.STRIPE_PAYOUTS_API_VERSION.trim() }
            : {},
        );
  const maxAge = Number(process.env.PAYOUT_MAX_RECEIPT_AGE_SECONDS ?? 600);
  if (!Number.isInteger(maxAge) || maxAge < 30 || maxAge > 3600)
    throw new Error("PAYOUT_MAX_RECEIPT_AGE_SECONDS must be a whole number from 30 to 3600");
  const allowLive = process.env.GATE_ALLOW_LIVE_CREDENTIALS === "true";
  const identity = await ProxyIdentity.create(backend, process.env.CODE_HASH ?? "");
  const ledger = new PayoutLedger({
    ...(process.env.PAYOUT_LEDGER_PATH ? { path: process.env.PAYOUT_LEDGER_PATH } : {}),
    maxAgeSeconds: maxAge,
    now: Date.now,
  });
  const port = Number(process.env.PORT ?? 8080);
  createPayoutServer({
    identity,
    backendName: backend.name,
    provider,
    gateSigner,
    allowLiveCredentials: allowLive,
    ledger,
    maxReceiptAgeSeconds: maxAge,
  }).listen(port, "0.0.0.0", () => {
    console.log(`Payout proxy listening on :${port} (${backend.name}, ${which})`);
    console.log(`EVM ${identity.evmAddress} · gate ${gateSigner} · live keys ${allowLive}`);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
