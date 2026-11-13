import { describe, expect, it } from "vitest";
import {
  HOSTED_MODELS,
  HostedAgentSpec,
  hostedCodeHash,
  hostedModelLabel,
  problemCode,
} from "../src/index.js";

describe("hosted agents", () => {
  const instructions = {
    kind: "instructions",
    model: "deepseek/deepseek-v4.1-flash",
    instructions: "Read the holder's plan first, then make only the trades it asks for.",
  } as const;

  it("accept instructions or one code file on a listed model, and nothing else", () => {
    expect(HostedAgentSpec.safeParse(instructions).success).toBe(true);
    expect(
      HostedAgentSpec.safeParse({
        kind: "code",
        model: HOSTED_MODELS[1].id,
        language: "ts",
        code: "x",
      }).success,
    ).toBe(true);
    const off = HostedAgentSpec.safeParse({ ...instructions, model: "openai/gpt-5" });
    expect(off.success).toBe(false);
    expect(off.error?.issues[0]?.message).toMatch(/models on the list/);
    expect(HostedAgentSpec.safeParse({ ...instructions, instructions: "Trade." }).success).toBe(
      false,
    );
    expect(HostedAgentSpec.safeParse({ ...instructions, extra: 1 }).success).toBe(false);
    expect(
      HostedAgentSpec.safeParse({
        kind: "code",
        model: instructions.model,
        language: "py",
        code: "x",
      }).success,
    ).toBe(false);
  });

  it("hash what runs: a new model or one changed character is a new code hash", () => {
    const base = hostedCodeHash(instructions);
    expect(base).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hostedCodeHash({ ...instructions })).toBe(base);
    expect(hostedCodeHash({ ...instructions, model: "qwen/qwen3.7-flash" })).not.toBe(base);
    expect(
      hostedCodeHash({ ...instructions, instructions: `${instructions.instructions}!` }),
    ).not.toBe(base);
  });

  it("name models in words, and their problems with codes", () => {
    expect(hostedModelLabel("z-ai/glm-5.3-flash")).toBe("GLM-5.3 Flash");
    expect(hostedModelLabel("unknown/model")).toBe("unknown/model");
    expect(problemCode("Save your agent first: its instructions, or its code file.")).toBe(
      "hosted-not-saved",
    );
    expect(problemCode("Your file can't run: SyntaxError: unexpected token at agent.js:1:3.")).toBe(
      "hosted-file-cant-run",
    );
    expect(
      problemCode(
        "the agent ran for more than 250 ms without waiting on a tool or the model (an endless loop?)",
      ),
    ).toBe("hosted-endless-loop");
    expect(problemCode("the agent made more than 60 model calls in one episode")).toBe(
      "hosted-cap",
    );
  });
});
