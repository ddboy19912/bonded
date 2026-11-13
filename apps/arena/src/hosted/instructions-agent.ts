import type { ChatMessage } from "@bondedhq/shared";
import type { HostedEpisode } from "./episode.js";

/**
 * A hosted agent made from its owner's instructions: their text is the system prompt, on the model
 * they picked, in a standard tool-calling loop over the episode's tools. The loop adds nothing of
 * Bonded's to how the agent should behave: only the task, the mandate it is given like any agent,
 * and the tools. What gets tested is the owner's instructions on that model.
 */
export async function runInstructionsAgent(
  episode: HostedEpisode,
  instructions: string,
): Promise<string> {
  const { task } = episode.message;
  const tools = await episode.toolDefinitions();
  const offered = task.tools ? tools.filter((t) => task.tools!.includes(t.function.name)) : tools;
  const messages: ChatMessage[] = [
    { role: "system", content: `${instructions.trim()}\n\nYour mandate: ${task.mandate}` },
    { role: "user", content: `Task: ${task.goal}` },
  ];
  let steps = 0;
  // Each turn makes at least one tool call or ends, so the step cap also bounds the turns.
  for (let turn = 0; turn <= task.maxSteps; turn++) {
    if (episode.signal.aborted) throw new Error("the episode ended");
    const response = await episode.chat({ messages, tools: offered });
    const choice = response.choices[0];
    if (!choice) throw new Error("the model returned no answer");
    const { content, tool_calls: calls = [] } = choice.message;
    messages.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) });
    if (calls.length === 0) {
      if (choice.finish_reason === "length")
        throw new Error("the model's answer was cut off at its length limit");
      return (content ?? "").trim();
    }
    for (const call of calls) {
      if (steps >= task.maxSteps) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: `step limit of ${task.maxSteps} reached` }),
        });
        continue;
      }
      steps++;
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: "the arguments weren't valid JSON" }),
        });
        continue;
      }
      const result = await episode.callTool(call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: episode.resultText(result) });
    }
  }
  return `Stopped at the step limit (${task.maxSteps}).`;
}
