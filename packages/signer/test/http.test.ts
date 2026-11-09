import type { AddressInfo } from "node:net";
import { isPaymentRefusal } from "@bondedhq/sdk";
import { remoteX402Signer } from "@bondedhq/sdk/x402";
import { x402Client } from "@x402/core/client";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { verifyTypedData } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { serveX402Signer, x402SignerHandler } from "../src/http.js";
import { X402Signer } from "../src/signer.js";
import {
  account,
  BASE_USDC,
  localGuard,
  NOW_MS,
  payment,
  SERVICE,
  STRANGER,
  TYPES,
} from "./helpers.js";

const TOKEN = "t".repeat(40);

function handlerFor() {
  const key = account();
  const signer = new X402Signer({ account: key, guard: localGuard().guard, now: () => NOW_MS });
  return { key, signer, handle: x402SignerHandler(signer, { tokens: [TOKEN] }) };
}

const request = (path: string, init: RequestInit & { token?: string } = {}) =>
  new Request(`http://signer${path}`, {
    ...init,
    headers: {
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });

describe("x402SignerHandler", () => {
  it("needs tokens of at least 32 characters", () => {
    const signer = new X402Signer({ account: account(), guard: localGuard().guard });
    expect(() => x402SignerHandler(signer, { tokens: [] })).toThrow();
    expect(() => x402SignerHandler(signer, { tokens: ["short"] })).toThrow();
  });

  it("answers health checks without a token", async () => {
    const { handle } = handlerFor();
    expect((await handle(request("/healthz"))).status).toBe(200);
  });

  it("refuses a missing or wrong token", async () => {
    const { handle } = handlerFor();
    expect((await handle(request("/v1/x402/signer"))).status).toBe(401);
    expect((await handle(request("/v1/x402/signer", { token: "x".repeat(40) }))).status).toBe(401);
  });

  it("gives its address and networks", async () => {
    const { handle, key } = handlerFor();
    const response = await handle(request("/v1/x402/signer", { token: TOKEN }));
    const body = (await response.json()) as { address: string; networks: string[] };
    expect(body.address).toBe(key.address);
    expect(body.networks).toContain("eip155:8453");
  });

  it("signs, refuses with 403, and rejects bad requests with 400", async () => {
    const { handle, key } = handlerFor();
    const sign = (body: unknown) =>
      handle(
        request("/v1/x402/sign", { method: "POST", token: TOKEN, body: JSON.stringify(body) }),
      );
    const ok = await sign({ typedData: payment(key.address) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { signature: string }).signature).toMatch(/^0x[0-9a-f]{130}$/);
    const refused = await sign({ typedData: payment(key.address, { to: STRANGER }) });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("refused");
    expect(
      (await sign({ typedData: { ...payment(key.address), primaryType: "Permit" } })).status,
    ).toBe(400);
    expect((await sign({})).status).toBe(400);
    const notJson = await handle(
      request("/v1/x402/sign", { method: "POST", token: TOKEN, body: "{" }),
    );
    expect(notJson.status).toBe(400);
    const huge = await sign({ typedData: payment(key.address), pad: "x".repeat(20_000) });
    expect(huge.status).toBe(400);
  });

  it("answers 404 for other routes and methods", async () => {
    const { handle } = handlerFor();
    expect((await handle(request("/v1/x402/sign", { token: TOKEN }))).status).toBe(404);
    expect((await handle(request("/sign", { token: TOKEN }))).status).toBe(404);
  });
});

describe("an agent paying through the signer", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start() {
    const key = account();
    const signer = new X402Signer({ account: key, guard: localGuard().guard });
    const server = await serveX402Signer(signer, { tokens: [TOKEN], port: 0 });
    close = () => new Promise((resolve) => server.close(() => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { key, signer, url };
  }

  /** An x402 server that answers 402 with these requirements, then 200 once a payment comes. */
  function x402Server(accepts: PaymentRequirements) {
    const payments: string[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const signature = req.headers.get("PAYMENT-SIGNATURE");
      if (signature) {
        payments.push(signature);
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            x402Version: 2,
            resource: { url: "https://api.example.com/forecast" },
            accepts: [accepts],
          }),
        },
      });
    };
    return { fetch, payments };
  }

  const requirements = (payTo: string): PaymentRequirements => ({
    scheme: "exact",
    network: "eip155:8453",
    asset: BASE_USDC,
    amount: "1000",
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  });

  it("pays an x402 service with a signature from the signer's key", async () => {
    const { key, url, signer } = await start();
    const remote = await remoteX402Signer({ url, token: TOKEN });
    expect(remote.address).toBe(key.address);
    const service = x402Server(requirements(SERVICE));
    const client = new x402Client().register("eip155:*", new ExactEvmScheme(remote));
    const pay = wrapFetchWithPayment(service.fetch, client);
    const response = await pay("https://api.example.com/forecast");
    expect(response.status).toBe(200);
    expect(service.payments).toHaveLength(1);
    const paid = decodePaymentSignatureHeader(service.payments[0]!);
    const { authorization, signature } = paid.payload as {
      authorization: Record<string, string>;
      signature: `0x${string}`;
    };
    const valid = await verifyTypedData({
      address: key.address,
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE_USDC },
      types: TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as `0x${string}`,
        to: authorization.to as `0x${string}`,
        value: BigInt(authorization.value!),
        validAfter: BigInt(authorization.validAfter!),
        validBefore: BigInt(authorization.validBefore!),
        nonce: authorization.nonce as `0x${string}`,
      },
      signature,
    });
    expect(valid).toBe(true);
    expect(signer.budgets()[0]!.spentMicros).toBe(1000);
  });

  it("can't pay a service the gate doesn't allow", async () => {
    const { url } = await start();
    const remote = await remoteX402Signer({ url, token: TOKEN });
    const service = x402Server(requirements(STRANGER));
    const client = new x402Client().register("eip155:*", new ExactEvmScheme(remote));
    const pay = wrapFetchWithPayment(service.fetch, client);
    await expect(pay("https://api.example.com/forecast")).rejects.toThrow(/refused/);
    expect(service.payments).toHaveLength(0);
    const direct = await remote
      .signTypedData(
        payment(remote.address, {
          to: STRANGER,
          validBefore: String(Math.floor(Date.now() / 1000) + 60),
        }),
      )
      .catch((e: unknown) => e);
    expect(isPaymentRefusal(direct)).toBe(true);
    expect((direct as { code: string }).code).toBe("SIGNER_REFUSED");
  });

  it("fails closed when the signer is down or the token is wrong", async () => {
    const { url } = await start();
    await expect(remoteX402Signer({ url, token: "w".repeat(40) })).rejects.toMatchObject({
      code: "SIGNER_UNAUTHORIZED",
    });
    await close!();
    close = undefined;
    await expect(remoteX402Signer({ url, token: TOKEN, timeoutMs: 2000 })).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE",
    });
  });
});
