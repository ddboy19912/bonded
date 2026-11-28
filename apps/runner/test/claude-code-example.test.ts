import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const example = fileURLToPath(new URL("../examples/claude-code-agent.mjs", import.meta.url));
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function launch(exitCode: number, status = 200, isError = false) {
  const dir = mkdtempSync(join(tmpdir(), "runner-example-"));
  folders.push(dir);
  const bin = join(dir, "claude");
  const request = join(dir, "request.json");
  const mock = join(dir, "gateway.mjs");
  const init = { type: "system", subtype: "init", tools: ["mcp__toolbox__read"] };
  const result = {
    type: "result",
    subtype: "success",
    is_error: isError,
    result: "x".repeat(4001),
    usage: { input_tokens: 3, output_tokens: 2 },
  };
  const stream = [init, result].map((event) => JSON.stringify(event)).join("\n");
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stream)});\nprocess.exitCode = ${exitCode};`,
    { mode: 0o700 },
  );
  writeFileSync(
    mock,
    `import {writeFileSync} from 'node:fs'; globalThis.fetch = async (_, options) => {
    writeFileSync(${JSON.stringify(request)}, options.body); return new Response(null, {status: ${status}});
  };`,
  );
  const done = promisify(execFile)(process.execPath, ["--import", mock, example], {
    env: {
      PATH: process.env.PATH,
      BONDED_TASK: JSON.stringify({ goal: "Read", mandate: "Read only", maxSteps: 2 }),
      CLAUDE_CODE_BIN: bin,
      BONDED_DONE_URL: "http://unused.invalid",
      BONDED_MCP_URL: "http://unused.invalid",
    },
  });
  return { done, request };
}

it.each([
  [1, false],
  [0, true],
] as const)("does not post a failed Claude run (%s, %s)", async (code, error) => {
  const { done, request } = launch(code, 200, error);
  await expect(done).rejects.toMatchObject({ code: 1 });
  expect(existsSync(request)).toBe(false);
});

it("posts usage with a bounded message, including an unterminated result line", async () => {
  const { done, request } = launch(0);
  await done;
  expect(JSON.parse(readFileSync(request, "utf8"))).toEqual({
    finalMessage: "x".repeat(4000),
    usage: { inputTokens: 3, outputTokens: 2, costUsd: 0 },
  });
});

it("reports an unsuccessful gateway response", async () => {
  await expect(launch(0, 400).done).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("HTTP 400"),
  });
});
