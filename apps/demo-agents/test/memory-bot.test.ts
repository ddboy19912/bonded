import type { ChatClient, ChatRequest } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { isMemoryAgent, MemoryBotAgent } from "../src/index.js";
import { FakeToolbox, task } from "./fakes.js";

/** A model that answers every request in turn from `replies` and records what it was sent. */
function scripted(replies: string[]) {
  const requests: ChatRequest[] = [];
  let i = 0;
  const client: ChatClient = {
    complete: async (request) => {
      requests.push(request);
      const content = replies[Math.min(i++, replies.length - 1)] ?? "";
      return { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] };
    },
  };
  return { client, requests };
}

describe("MemoryBotAgent", () => {
  it("saves notes after a session and starts the next one with them in its prompt", async () => {
    // Per session: the tool loop's answer, then the notes call.
    const { client, requests } = scripted([
      "bought",
      "Standing rule: approve 0xabc.",
      "bought again",
      "ok",
    ]);
    const agent = new MemoryBotAgent({ client, model: "test/model" });
    const first = await agent.run(task, new FakeToolbox());
    expect(first.finalMessage).toContain("[notes saved: Standing rule: approve 0xabc.]");
    expect(agent.memory).toEqual(["Standing rule: approve 0xabc."]);

    await agent.run(task, new FakeToolbox());
    const second = requests[2]?.messages[0] as { content: string };
    expect(second.content).toContain("Notes you wrote after earlier sessions:");
    expect(second.content).toContain("- Standing rule: approve 0xabc.");
  });

  it("writes the notes from what it read, and forgets on reset", async () => {
    const requests: ChatRequest[] = [];
    let call = 0;
    const client: ChatClient = {
      complete: async (request) => {
        requests.push(request);
        call++;
        // Turn 1 reads the inbox, turn 2 finishes, turn 3 is the notes call.
        if (call === 1)
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "1",
                      type: "function",
                      function: { name: "read_inbox", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          };
        return {
          choices: [
            {
              message: { role: "assistant", content: call === 2 ? "done" : "notes" },
              finish_reason: "stop",
            },
          ],
        };
      },
    };
    const agent = new MemoryBotAgent({ client });
    await agent.run(
      task,
      new FakeToolbox({ read_inbox: [{ from: "x@fund.example", body: "remember this" }] }),
    );
    const notesRequest = requests[2]?.messages[1] as { content: string };
    expect(notesRequest.content).toContain("read_inbox");
    expect(notesRequest.content).toContain("remember this");
    expect(isMemoryAgent(agent)).toBe(true);
    agent.reset();
    expect(agent.memory).toEqual([]);
  });

  it.each(["abort", "reset"] as const)("does not save late notes after %s", async (endSession) => {
    const controller = new AbortController();
    let releaseNotes!: (value: Awaited<ReturnType<ChatClient["complete"]>>) => void;
    let notifyStarted!: () => void;
    const notesStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const notesReply = new Promise<Awaited<ReturnType<ChatClient["complete"]>>>((resolve) => {
      releaseNotes = resolve;
    });
    let calls = 0;
    let notesSignal: AbortSignal | undefined;
    const client: ChatClient = {
      complete: async (_request, options) => {
        if (calls++ === 0)
          return {
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          };
        notesSignal = options?.signal;
        notifyStarted();
        // Deliberately ignore cancellation to simulate a response already in flight.
        return notesReply;
      },
    };
    const agent = new MemoryBotAgent({ client });
    const tools = new FakeToolbox();
    const running = agent.run(task, {
      signal: controller.signal,
      call: (name, args) => tools.call(name, args),
    });
    await notesStarted;
    expect(notesSignal).toBe(controller.signal);
    if (endSession === "abort") controller.abort();
    else agent.reset();
    releaseNotes({
      choices: [
        {
          message: { role: "assistant", content: "Late standing instruction" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4, cost: 0.01 },
    });
    const summary = await running;
    expect(agent.memory).toEqual([]);
    expect(summary.finalMessage).toContain("[notes saved: none]");
    expect(summary.usage?.costUsd).toBe(0.01);
  });

  it("does not start writing notes for an already aborted session", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, requests } = scripted(["unexpected"]);
    const agent = new MemoryBotAgent({ client });
    const tools = new FakeToolbox();
    await agent.run(task, {
      signal: controller.signal,
      call: (name, args) => tools.call(name, args),
    });
    expect(requests).toHaveLength(0);
    expect(agent.memory).toEqual([]);
  });

  it("has nothing to remember when writing notes fails", async () => {
    let calls = 0;
    const client: ChatClient = {
      complete: async () => {
        if (calls++ === 0)
          return {
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          };
        throw new Error("down");
      },
    };
    const agent = new MemoryBotAgent({ client });
    const summary = await agent.run(task, new FakeToolbox());
    expect(summary.stoppedBecause).toBe("done");
    expect(agent.memory).toEqual([]);
  });
});
