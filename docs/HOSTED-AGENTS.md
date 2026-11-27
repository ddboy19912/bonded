# Bonded runs it: hosted agents

If you don't have a server for your agent, or don't want to change and redeploy your app for a test, give Bonded the agent and Bonded runs it. It's one of the ways in on [Test your agent](https://app.bondedhq.xyz/agents/test), next to the runner and the Agent URL.

Hosted agents work for stock-trading previews ([BROKERAGE.md](BROKERAGE.md)). The crypto-trading world and official ratings need a runner or an Agent URL.

## What you give Bonded

One of two things, and the model to run it on:

- **Its instructions.** The system prompt your agent runs with. Bonded runs it in a standard tool-calling loop on the model you pick. This tests your instructions on that model.
- **Its code.** One JavaScript or TypeScript file. This tests your own logic: how it loops, what it checks before trading, and what it does with what it reads.

You can pick DeepSeek V4.1 Flash (the default), Qwen3.7 Flash, GLM-5.3 Flash or Llama 4 Maverick. Bonded pays for the model calls.

## Steps

1. Sign in with your email, a passkey or a crypto wallet.
2. Choose **Stock trading** and **Bonded runs it** (both are the defaults), then **Continue**.
3. Paste the instructions, or paste or upload the file. Pick the model and press **Save and check**. If a code file can't run (a syntax error, a missing import, no default export), you're told why straight away.
4. The connection check starts on its own: one test with nothing planted, shown live. Your agent must do the job: read the holder's plan and make the trades it asks for. A code file's `console.log` output shows under the check.
5. Press **Start preview rating**. It runs twenty tests: the control, every stock-trading attack and every benign twin. The report says which attacks worked, what your agent traded and the dollars at risk.

You can change the instructions, the file or the model any time before the preview starts. Each change makes a new agent, which needs a new check.

## A code file

Its default export is called once per test, with the episode:

```js
import OpenAI from "openai";

const openai = new OpenAI();

export default async function run({ goal, mandate, tools, callTool }) {
  const messages = [
    { role: "system", content: `You manage a client's brokerage account.\nRules: ${mandate}` },
    { role: "user", content: goal },
  ];
  for (let turn = 0; turn < 20; turn++) {
    const response = await openai.chat.completions.create({ messages, tools });
    const message = response.choices[0].message;
    messages.push(message);
    // Shown under the connection check.
    console.log(`turn ${turn}:`, message.tool_calls?.map((c) => c.function.name).join(", ") ?? "done");
    if (!message.tool_calls?.length) return message.content;
    for (const call of message.tool_calls) {
      const result = await callTool(call.function.name, JSON.parse(call.function.arguments));
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return "Stopped after 20 turns.";
}
```

The function gets:

- `goal`: the test's task, the sentence to give your agent.
- `mandate`: the account's rules, as the holder set them.
- `tools`: the account's tools as an OpenAI-style function list (Alpaca's names if you chose them).
- `callTool(name, args)`: uses one tool, and answers `{ ok: true, output }` or `{ ok: false, error }`.
- `maxSteps`, `model`, `episodeId`: the step cap, the model's id and the test's id.

`import OpenAI from "openai"` gives a client that calls the model you picked, whatever model the code names, with no key. Code written against the OpenAI SDK's chat completions works unchanged. Return a short summary of what the agent did: a string, or `{ finalMessage }`.

The file can't import other packages, and has no network, files, timers or Node APIs: everything goes through `callTool` and the model. TypeScript has its types stripped before it runs, so enums and namespaces aren't supported.

## Limits per test

| | Limit |
|---|---|
| Model calls | 40, each up to 16,384 output tokens |
| Tokens | 150,000, input and output together |
| Tool calls | 80 (the test's own step cap applies too) |
| Memory | 64 MB |
| Computing time | 10 s in all; 250 ms at a stretch without awaiting a tool or the model |
| Time | The test's deadline, 90 seconds in a preview |
| File size | 100 KB |
| Instructions | 8,000 characters |

A real test uses 40,000 to 65,000 tokens. Going past a limit ends that test, and the check or report says which one. A model request can be 1 MB, a tool call's arguments 64 KB, and console output is cut at 200 lines.

## How your code is contained

Anyone can sign in and save a file, so Bonded treats every file as hostile.

- **It can't reach the server.** Code runs in QuickJS compiled to WebAssembly, a separate JavaScript engine with its own memory. It gets two functions, the model and the episode's tools, and nothing else: no files, processes, environment variables, keys or network.
- **It can't reach other tests.** Each test gets a fresh engine on its own thread, and its tools sit behind that one episode's unguessable address. Bonded ends the thread at the deadline or a limit, whatever the code is doing.
- **It can't use Bonded's model key as free AI.** Besides the per-test limits, each account has a daily share of model spend and there's a daily budget across everyone. Past either, a check or rating is refused, and a running test stops and says so. Connection checks are capped at 10 an hour per account.
- **It can't cheat the test.** It can only call the episode's tools, and the broker ledger judges what it did, as for any agent.

The thread shares a process with Bonded's worker: a strong wall for CPU and memory, but not a separate operating-system process.

## How it's judged

- **The same test as any agent.** Bonded opens the episode exactly as for a runner or an Agent URL, and the broker ledger judges every order the same way.
- **The code hash** is keccak256 of `"hosted:"`, the kind, the model, and the instructions or code, labelled "hosted". One changed character or a new model gives a new hash.
- **Whose failure it is.** A problem on Bonded's side, such as the model account refusing or the daily budget running out, is reported and doesn't count against your agent. Your code throwing an error, or going past a limit, does.
