# Bonded runs it: hosted agents

Most people who want to test a trading agent don't have a server to run it on, or don't want to change and redeploy their app for a test. So on [Test your agent](https://www.bondedhq.xyz/agents/test) there is a third way in, next to the runner and the Agent URL: give Bonded the agent, and Bonded runs it.

**Status, 2026-11-13:** built, for stock-trading previews ([BROKERAGE.md](BROKERAGE.md)). The crypto-trading world and official ratings still need a runner or an Agent URL.

## What you give Bonded

One of two things, and the model to run it on:

- **Its instructions.** The system prompt your agent runs with. Bonded runs it in a standard tool-calling loop on the model you pick. This tests your instructions on that model, not code you wrote around it.
- **Its code.** One JavaScript or TypeScript file. This tests your own logic: how it loops, what it checks before trading, what it does with what it reads.

The models are the inexpensive ones on the Index: DeepSeek V4.1 Flash (the default), Qwen3.7 Flash, GLM-5.3 Flash and Llama 4 Maverick (`HOSTED_MODELS` in `@bondedhq/shared`). Bonded pays for the model calls.

## The steps

1. Sign in with your wallet.
2. Choose **Stock trading** and **Bonded runs it** (both are the defaults), then **Continue**.
3. Paste the instructions, or paste or upload the file, pick the model, and press **Save and check**. A code file is loaded on Bonded's side first: if it can't run (a syntax error, an import that isn't there, no default export), you're told why straight away.
4. The connection check starts on its own: one test with nothing planted, shown live. Your agent must do the job: read the holder's plan and make the trades it asks for. A code file's `console.log` output is shown under the check.
5. **Start preview rating.** Twenty tests: the control, every staged attack and every benign twin. The report says which attacks worked, what your agent traded on them and the dollars at risk.

Change the instructions, the file or the model at any time before the preview starts. Each change is a new agent, so it needs a new check.

## A code file

Its default export is called once per test with the episode:

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

| It gets | What it is |
|---|---|
| `goal` | The test's task, the sentence to give your agent |
| `mandate` | The account's rules, as the holder set them |
| `tools` | The account's tools as an OpenAI-style function list (Alpaca's names when you chose them) |
| `callTool(name, args)` | Uses one tool. Answers `{ ok: true, output }` or `{ ok: false, error }`, exactly as the HTTP tools do |
| `maxSteps`, `model`, `episodeId` | The step cap, the model's id, and the test's id |
| `import OpenAI from "openai"` | A client whose `chat.completions.create` calls the model you picked, whatever model the code names. No key. Code written against the OpenAI SDK's chat completions works unchanged |
| `console.log` | Kept and shown under the check |

Return a short summary of what it did (a string, or `{ finalMessage }`).

**What it doesn't get.** One file, no other packages. No network, no files, no timers and no Node APIs: everything goes through `callTool` and the model. TypeScript has its types removed before it runs (Node's type stripping), so enums and namespaces aren't supported.

## Limits, per test

| | Limit |
|---|---|
| Model calls | 40, each up to 16,384 output tokens |
| Tokens | 150,000, input and output together (a real test uses 40,000 to 65,000) |
| Tool calls | 80 (the test's own step cap applies too) |
| Memory | 64 MB |
| Computing time | 10 s in all; any stretch of code that runs 250 ms without awaiting a tool or the model is stopped |
| Time | The test's deadline, 90 seconds in a preview |
| File | 100 KB; instructions, 8,000 characters |

Going past one ends that test, and the check or report says which limit it was.

## Hostile code

Anyone can sign in and save a file, so the file is treated as hostile.

| What it might try | What stops it |
|---|---|
| Reach the server: files, processes, environment variables, Bonded's keys, the network | It runs in QuickJS compiled to WebAssembly, a separate engine whose memory is its own. It is handed two functions and nothing else: the model and the episode's tools. A bug in QuickJS stays inside that memory; getting out would take a bug in Node's WebAssembly itself |
| Other users' tests | Each test runs in a fresh engine instance. Its tools are behind that one episode's unguessable address, and the episode ends when the test does |
| Hold the worker: endless loops, huge memory | Each test runs on a thread of its own, which Bonded ends at the deadline or a cap whatever the code is doing, so it never holds the thread that serves the gateway and the API. On top: 250 ms per stretch of code, 10 s in all, 64 MB in the engine and a capped heap for the thread |
| Run the process out of memory with many threads at once | A process runs only so many sandbox threads at a time. Saving a file gets 2 (`HOSTED_INSPECT_THREADS`), and a save is refused at once with "save it again in a few seconds" when both are busy. Tests get 8 (`HOSTED_RUN_THREADS`, two previews' worth), and wait their turn |
| Flood the host with data | A model request may be 1 MB and a tool call's arguments 64 KB; console output is cut at 200 lines |
| Use Bonded's model key as free AI | Per test: 40 calls and 150,000 tokens. Each wallet: a daily share (`HOSTED_WALLET_DAILY_USD`, $1 by default), so a few wallets can't spend everyone's day. Across everyone: a daily budget (`HOSTED_DAILY_USD`, $10 by default). Both are kept in the database (`hosted_spend`, migration 0038), so a deploy or a second process doesn't start the day over. Past either, a check or rating is refused before it starts, and a test already running stops, saying it's Bonded's limit. On top, the existing caps: 10 checks an hour per wallet, 30 an hour in all, and 20 previews a day in all |
| Cheat the test | It can only call the episode's tools; the broker ledger judges what it did, as for any agent |

What remains, honestly:

- **The thread shares the worker's process.** A thread is a strong wall for CPU and memory, not a separate operating-system process: an escape from WebAssembly and from the thread would land in the worker. A separate process or container per test is the next step if hosted code ever handles more than test accounts.
- **What the model is asked is the owner's choice.** Within the caps, someone could use a test to ask the model anything. The daily budget bounds the cost; the model provider's own policies apply to the content.
- **Saving a file runs its top-level code once** on its own thread in the API process, with a 1-second limit, to check it can run. At most two such threads run at once.
- **Calls in flight are reserved per process.** Spending lands in the database when a call ends, so two processes can each admit calls up to the limit at the same moment: the overshoot is bounded by the calls in flight, a few cents.

## How it works

- **The same test as any agent.** Bonded's gateway opens the episode exactly as for a runner or an Agent URL, and the hosted agent reaches its tools through the same endpoints (on Bonded's own machine). The broker ledger judges every order and withdrawal the same way. Nothing about the test changes with how the agent is connected.
- **The sandbox.** A code file runs on its own thread (`apps/arena/src/hosted/code-worker.ts`) in QuickJS compiled to WebAssembly: a separate JavaScript engine with its own memory, which can reach nothing of the server's. Its two functions, the model and the tools, are calls back to Bonded's thread (`code-agent.ts`), which makes them and enforces the caps where the code can't reach. A fresh thread and engine run every test.
- **The code hash.** Bonded knows exactly what ran, so a hosted agent's code hash is keccak256 of `"hosted:"` and the kind, the model and the instructions or code (`hostedCodeHash`), labelled "hosted". One changed character or a new model is a new hash.
- **Whose failure.** If the model account refuses (a key or credit problem on Bonded's side), the test says so and isn't counted against your agent. If Bonded's daily budget runs out mid-preview, the preview stops saying so, and isn't retried the same day. Your code throwing, or going past a limit, is your agent's.

Where it lives: `packages/shared/src/hosted.ts` (models, limits, the spec and code hash), `apps/arena/src/hosted/` (the runtime), the `hosted` transport in `apps/arena/src/gateway/remote-agent.ts`, `PUT /previews/:id/hosted-agent` in `apps/api/src/previews.ts`, the `hosted_agents` table (migration 0037) and `ConnectHosted` in `apps/web/src/components/connect-hosted.tsx`.

## What's next

- **Official ratings.** A hosted agent has no official rating yet, like every stock-trading preview.
- **The crypto-trading world.** Its tools mode would work the same way; chain mode needs the agent to sign transactions, which the sandbox doesn't offer.
- **Python, and files with packages.** These need a fuller sandbox (a container per test). That is a larger build, and worth it when design partners ask.
