import { describe, expect, it, vi } from "vitest";
import { isPaymentRefusal } from "../src/index.js";
import { remoteX402Signer, X402_SIGNER_PATHS } from "../src/x402.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SIGNATURE = `0x${"ab".repeat(65)}`;

/** A fake signer: answers the info route, and the sign route with `answer`. */
function signerAt(answer: { status: number; body: unknown }) {
  const calls: Request[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    const path = new URL(request.url).pathname;
    if (path === X402_SIGNER_PATHS.info)
      return Response.json({ address: ADDRESS, networks: ["eip155:8453"] });
    return Response.json(answer.body, { status: answer.status });
  });
  return { fetch, calls };
}

const typedData = {
  domain: { name: "USD Coin", version: "2", chainId: 8453 },
  types: {},
  primaryType: "TransferWithAuthorization",
  message: { value: 1000n, validBefore: 1_800_000_000n },
};

describe("remoteX402Signer", () => {
  it("reads the signer's address and sends payments with the token, big numbers as strings", async () => {
    const { fetch, calls } = signerAt({ status: 200, body: { signature: SIGNATURE } });
    const signer = await remoteX402Signer({ url: "http://signer:8402/", token: "tok", fetch });
    expect(signer.address).toBe(ADDRESS);
    expect(signer.networks).toEqual(["eip155:8453"]);
    expect(await signer.signTypedData(typedData)).toBe(SIGNATURE);
    const sent = calls[1]!;
    expect(sent.url).toBe("http://signer:8402/v1/x402/sign");
    expect(sent.headers.get("authorization")).toBe("Bearer tok");
    const body = (await sent.json()) as { typedData: { message: Record<string, unknown> } };
    expect(body.typedData.message).toEqual({ value: "1000", validBefore: "1800000000" });
  });

  it.each([
    [403, { error: "refused", reason: "over budget" }, "SIGNER_REFUSED"],
    [400, { error: "invalid", reason: "not a transfer" }, "INVALID_PAYMENT"],
    [401, { error: "unauthorized", reason: "unknown token" }, "SIGNER_UNAUTHORIZED"],
    [500, { error: "error", reason: "broke" }, "SIGNER_UNAVAILABLE"],
    [502, "bad gateway", "SIGNER_UNAVAILABLE"],
  ])("turns HTTP %i into a refusal (%s)", async (status, body, code) => {
    const { fetch } = signerAt({ status, body });
    const signer = await remoteX402Signer({ url: "http://signer", token: "tok", fetch });
    const error = await signer.signTypedData(typedData).catch((e: unknown) => e);
    expect(error).toMatchObject({ code });
    expect(isPaymentRefusal(error)).toBe(true);
  });

  it("fails closed when the signer can't be reached", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      remoteX402Signer({ url: "http://signer", token: "tok", fetch }),
    ).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE",
    });
  });

  it("refuses a signer that sends no address, or no signature", async () => {
    const bad = vi.fn(async () => Response.json({ address: "nope" }));
    await expect(
      remoteX402Signer({ url: "http://signer", token: "tok", fetch: bad }),
    ).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE",
    });
    const { fetch } = signerAt({ status: 200, body: { signature: 42 } });
    const signer = await remoteX402Signer({ url: "http://signer", token: "tok", fetch });
    await expect(signer.signTypedData(typedData)).rejects.toMatchObject({
      code: "SIGNER_UNAVAILABLE",
    });
  });
});
