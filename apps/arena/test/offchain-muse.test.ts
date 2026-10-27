import type { ChatClient, ChatRequest, ChatResponse } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import {
  type Counterparty,
  PROBE_REPLIES,
  probeCounterparty,
} from "../src/offchain/counterparty.js";
import {
  checkProblem,
  forgeImage,
  MetaImageClient,
  MUSE_IMAGE_SPECS,
} from "../src/offchain/muse-image.js";

const env = { MODEL_API_KEY: "meta-key" };
const spec = MUSE_IMAGE_SPECS[0]!;
const base = { mediaType: "image/png", base64: "QkFTRQ==" };

function imageFetch(...responses: Response[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const image = (b64: string) =>
  new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });

/** A vision checker that reads back whatever `reads` says, one answer per call. */
function checker(
  ...reads: Record<string, string | null>[]
): ChatClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    async complete(request): Promise<ChatResponse> {
      requests.push(request);
      return {
        choices: [
          {
            message: { role: "assistant", content: JSON.stringify(reads.shift()) },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 50 },
      };
    },
  };
}

const exact = {
  plantedAccount: spec.plantedAccount,
  printedAccount: spec.base.account,
  reference: spec.base.reference,
};

describe("MetaImageClient", () => {
  it("posts an edit of the base image to Meta Model API and returns the picture", async () => {
    const { impl, calls } = imageFetch(image("SU1H"));
    const made = await new MetaImageClient({ env, fetch: impl }).edit({ prompt: "p", image: base });
    expect(made).toEqual({ ok: true, mediaType: "image/jpeg", base64: "SU1H" });
    expect(calls[0]!.url).toBe("https://api.meta.ai/v1/images/edits");
    expect(calls[0]!.body).toMatchObject({
      model: "muse-image-1.0",
      prompt: "p",
      images: [{ image_url: "data:image/png;base64,QkFTRQ==" }],
      response_format: "b64_json",
      output_format: "jpeg",
    });
  });

  it("tells a content-policy decline from a failed request", async () => {
    const { impl } = imageFetch(
      new Response('{"error":{"message":"Request blocked by safety policy"}}', { status: 400 }),
      new Response("upstream timeout", { status: 504 }),
    );
    const client = new MetaImageClient({ env, fetch: impl });
    expect(await client.edit({ prompt: "p", image: base })).toMatchObject({
      ok: false,
      refused: true,
    });
    expect(await client.edit({ prompt: "p", image: base })).toMatchObject({
      ok: false,
      refused: false,
    });
  });

  it("fails at once without MODEL_API_KEY", () => {
    expect(() => new MetaImageClient({ env: {} })).toThrow(/MODEL_API_KEY/);
  });
});

describe("forging a picture", () => {
  it("keeps a picture only when every detail reads back exactly", () => {
    expect(checkProblem(spec, exact)).toBeUndefined();
    // Spacing and case don't matter; a wrong digit does.
    expect(
      checkProblem(spec, { ...exact, plantedAccount: "lt121000011101001000" }),
    ).toBeUndefined();
    expect(checkProblem(spec, { ...exact, plantedAccount: "LT12 1000 0111 0100 1008" })).toMatch(
      /planted account reads/,
    );
    expect(checkProblem(spec, { ...exact, printedAccount: null })).toMatch(/printed account/);
    expect(checkProblem(spec, { ...exact, reference: "NIM-88413" })).toMatch(/reference/);
  });

  it("retries an illegible or refused picture, and records every attempt", async () => {
    const { impl, calls } = imageFetch(
      new Response("content policy violation", { status: 400 }),
      image("QkFE"),
      image("R09PRA=="),
    );
    const vision = checker({ ...exact, plantedAccount: "LT12 1000 0111 0100 1OOO" }, exact);
    const result = await forgeImage({
      spec,
      base,
      images: new MetaImageClient({ env, fetch: impl }),
      checker: vision,
      checkerModel: "muse-spark-1.3",
    });
    expect(result.attempts.map((a) => a.outcome)).toEqual(["refused", "illegible", "kept"]);
    expect(result.image?.base64).toBe("R09PRA==");
    expect(calls).toHaveLength(3);
    expect(result.checkerUsage).toEqual({ inputTokens: 2000, outputTokens: 100 });
    // The checker is shown the picture itself.
    expect(JSON.stringify(vision.requests[1]!.messages)).toContain(
      "data:image/jpeg;base64,R09PRA==",
    );
  });

  it("gives up after its tries without a picture", async () => {
    const { impl } = imageFetch(image("QQ=="), image("Qg=="));
    const result = await forgeImage({
      spec,
      base,
      images: new MetaImageClient({ env, fetch: impl }),
      checker: checker({ ...exact, reference: null }, { ...exact, reference: null }),
      checkerModel: "muse-spark-1.3",
      tries: 2,
    });
    expect(result.image).toBeUndefined();
    expect(result.attempts.map((a) => a.outcome)).toEqual(["illegible", "illegible"]);
  });
});

describe("probing a counterparty", () => {
  it("asks each typical reply once and counts replies, refusals and failures", async () => {
    let n = 0;
    const counterparty: Counterparty = {
      reply: async () => {
        n++;
        if (n === 2) return { refused: "I can't help with that." };
        if (n === 3) return null;
        return "Here's our bank letter.";
      },
    };
    const result = await probeCounterparty(counterparty, { from: "x", body: "hello" });
    expect(result).toEqual({
      asked: PROBE_REPLIES.length,
      replied: PROBE_REPLIES.length - 2,
      refused: 1,
      failed: 1,
      refusals: ["I can't help with that."],
    });
  });
});
