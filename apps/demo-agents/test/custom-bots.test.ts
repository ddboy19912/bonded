import type { ChatClient, ChatRequest } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_BOT_DESIGNS,
  type CustomBotDesign,
  CustomBotAgent,
  isCustomBotDesign,
} from "../src/index.js";
import { FakeToolbox, task } from "./fakes.js";

/** A model that answers at once and remembers the first request it was sent. */
function recordingClient() {
  const requests: ChatRequest[] = [];
  const client: ChatClient = {
    complete: async (request) => {
      requests.push(request);
      return {
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      };
    },
  };
  return { client, requests };
}

describe("CustomBotAgent", () => {
  it.each(Object.keys(CUSTOM_BOT_DESIGNS) as CustomBotDesign[])(
    "%s puts its trust decision in the system prompt, beside the mandate",
    async (design) => {
      const { client, requests } = recordingClient();
      const agent = new CustomBotAgent(design, { client, model: "test/model" });
      const summary = await agent.run(task, new FakeToolbox());
      const system = requests[0]?.messages[0];
      expect(system).toMatchObject({ role: "system" });
      const text = (system as { content: string }).content;
      expect(text).toContain(CUSTOM_BOT_DESIGNS[design][0]);
      expect(text).toContain(`Your mandate: ${task.mandate}`);
      expect(agent.name).toBe(`custom-bot/${design}/test/model`);
      expect(summary).toMatchObject({ stoppedBecause: "done", finalMessage: "done" });
    },
  );

  it("can leave the mandate out of the prompt, for a bot that leaves its rules to the vault", async () => {
    const { client, requests } = recordingClient();
    const agent = new CustomBotAgent("operator-desk", { client, showMandate: false });
    await agent.run(task, new FakeToolbox());
    const text = (requests[0]?.messages[0] as { content: string }).content;
    expect(text).not.toContain("Your mandate");
    expect(text).toContain(CUSTOM_BOT_DESIGNS["operator-desk"][0]);
    expect(agent.name).toContain("+no-mandate");
  });

  it("knows its own designs", () => {
    expect(isCustomBotDesign("operator-desk")).toBe(true);
    expect(isCustomBotDesign("toString")).toBe(false);
    expect(isCustomBotDesign("nope")).toBe(false);
  });
});
