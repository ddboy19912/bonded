import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "./api";
import type { PreviewRecord } from "./byoa-api";
import { preview } from "../test/byoa-fixtures";
import {
  agentUrlError,
  clearSession,
  codeSourceLabel,
  duration,
  emailError,
  estimateLines,
  eventLine,
  isConnected,
  loadSession,
  passingCheck,
  previewStep,
  problemAdvice,
  progressText,
  queueLine,
  refusal,
  saveSession,
  statusFromPreview,
  statusFromRunner,
  waitFor,
  webhookError,
} from "./connect";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const basePreview = (over: Partial<PreviewRecord> = {}) =>
  preview({ createdAt: iso(-60_000), ...over });

describe("connection status", () => {
  it("reads an agent's runner record, defaulting to the runner and the declared hash", () => {
    const s = statusFromRunner(undefined, "chain", "0xabc");
    expect(s).toMatchObject({ connection: "runner", mode: "chain", hasToken: false });
    expect(s.codeHash).toEqual({ value: "0xabc", source: "declared" });
    const url = statusFromRunner(
      {
        token: null,
        runner: null,
        lastSkip: null,
        gatewayUrl: null,
        agentUrl: { url: "https://a.example", verifiedAt: iso(0), version: null },
      },
      "tools",
    );
    expect(url.connection).toBe("url");
    expect(isConnected(url)).toBe(true);
  });

  it("counts a runner as connected only without a problem (e.g. the wrong mode)", () => {
    const runner = {
      connected: true,
      connectedAt: iso(0),
      lastHeartbeatAt: iso(0),
      disconnectedAt: null,
      runnerVersion: "0.2.0",
      mode: "tools",
      teeUrl: null,
    };
    const s = statusFromPreview(basePreview({ connection: "runner", runner }));
    expect(isConnected(s)).toBe(true);
    expect(isConnected({ ...s, problem: "it was started in chain mode" })).toBe(false);
    expect(isConnected({ ...s, runner: { ...runner, connected: false } })).toBe(false);
  });

  it("accepts only a passing check of this connection, within 24 hours", () => {
    const check = {
      id: "c",
      status: "passed" as const,
      createdAt: iso(-3_600_000),
      connection: "url" as const,
    };
    expect(passingCheck({ connection: "url", lastCheck: check }, NOW)).toBe(check);
    expect(passingCheck({ connection: "runner", lastCheck: check }, NOW)).toBeUndefined();
    expect(
      passingCheck({ connection: "url", lastCheck: { ...check, status: "failed" } }, NOW),
    ).toBeUndefined();
    expect(
      passingCheck(
        { connection: "url", lastCheck: { ...check, createdAt: iso(-25 * 3_600_000) } },
        NOW,
      ),
    ).toBeUndefined();
    // The API's own expiry wins when it gives one.
    expect(
      passingCheck({ connection: "url", lastCheck: { ...check, expiresAt: iso(-1) } }, NOW),
    ).toBeUndefined();
  });
});

describe("times", () => {
  it("says how long to wait, roughly", () => {
    expect(waitFor(iso(9 * 3_600_000), NOW)).toBe("9 h");
    expect(waitFor(iso(25 * 60_000), NOW)).toBe("25 min");
    expect(waitFor(iso(10_000), NOW)).toBe("a minute");
    expect(waitFor(iso(-10_000), NOW)).toBe("a minute");
  });
  it("formats durations", () => {
    expect(duration(42)).toBe("42 s");
    expect(duration(300)).toBe("5 min");
    expect(duration(4800)).toBe("1 h 20 min");
    expect(duration(7200)).toBe("2 h");
  });
  it("shows progress as counts and time only", () => {
    expect(progressText(undefined)).toBe("Waiting for the first episode");
    expect(progressText({ done: 41, total: 56, etaSeconds: 540, startedAt: null })).toBe(
      "41 of 56 episodes, about 9 min left",
    );
    expect(progressText({ done: 3, total: null, etaSeconds: null, startedAt: null })).toBe(
      "3 episodes",
    );
    expect(progressText({ done: 56, total: 56, etaSeconds: 0, startedAt: null })).toBe(
      "All 56 episodes ran; working out the score",
    );
  });
});

describe("refusals", () => {
  it("turns the daily preview limit into when to try again", () => {
    const e = new ApiError(429, "one preview per wallet per day", { retryAt: iso(9 * 3_600_000) });
    expect(refusal(e, NOW)).toBe("You've used today's preview; try again in 9 h.");
  });
  it("adds the wait to any other limit", () => {
    const e = new ApiError(429, "10 checks an hour per wallet;", { retryAt: iso(20 * 60_000) });
    expect(refusal(e, NOW)).toBe("10 checks an hour per wallet. Try again in 20 min.");
  });
  it("says where a queued preview stands", () => {
    expect(refusal(new ApiError(409, "busy", { queue: { position: 1 } }), NOW)).toBe(
      "Previews are busy; you're next in line.",
    );
    expect(queueLine(0)).toBe("It's next: it starts in a moment.");
    expect(queueLine(2)).toBe("Previews are busy; 2 are ahead of you. It starts on its own.");
  });
  it("leaves other errors to the usual message", () => {
    expect(refusal(new ApiError(500, "boom"), NOW)).toBeUndefined();
    expect(refusal(new Error("x"), NOW)).toBeUndefined();
  });
});

describe("problem advice", () => {
  it.each([
    ["Your agent never called a tool", "runner", /BONDED_MCP_URL/],
    ["Your agent never called a tool", "url", /endpoints in the episode/],
    ["It exited with code 1 before finishing (see its output below)", "runner", /on its own/],
    ["It didn't make the trade its task names", "runner", /swap it names/],
    ["It read 2 of 9 surfaces; unread ones are scored as untested", "runner", /Read every source/],
    ["The runner isn't connected", "runner", /Start the runner/],
    ["Your URL answered 404", "url", /2xx within 10 seconds/],
    ["Nothing accepted a connection at your URL", "url", /Start your agent/],
    [
      "Your URL answered 500 to the check; it must be 200",
      "url",
      /"proof".*HMAC-SHA256 of "verify\." \+ the challenge.*createBondedHandler/,
    ],
    ["Your URL answered the check, but not with JSON", "url", /answerAgentUrlVerify/],
    [
      "If your agent uses a model, report its usage at /done: without it, a cost estimate gives time only",
      "url",
      /usage with done/,
    ],
    ["The runner is connected in the wrong mode: chain", "runner", /--mode chain/],
    ["Your URL answered 401: check your agent secret", "url", /bonded_as_/],
    ["Your URL didn't answer within 10 seconds", "url", /reply within 10 seconds/],
  ] as const)("%s (%s)", (problem, connection, advice) => {
    expect(problemAdvice(problem, connection)).toMatch(advice);
  });
  it("has nothing to add to an unknown problem", () => {
    expect(problemAdvice("Something new", "url")).toBeUndefined();
  });
});

describe("timeline lines", () => {
  it("names each tool call with what it read, and failures", () => {
    expect(eventLine({ type: "tool", name: "read_inbox", surface: "dm", ok: true })).toEqual({
      text: "Called read_inbox (read messages)",
      ok: true,
    });
    expect(eventLine({ type: "tool", name: "swap", ok: false, error: "unknown token" })).toEqual({
      text: "Called swap: unknown token",
      ok: false,
    });
    expect(eventLine({ type: "tx", ok: false, reason: "not the episode's key" }).ok).toBe(false);
    expect(eventLine({ type: "done", exitCode: 1, durationMs: 4000 })).toEqual({
      text: "Finished after 4 s, exit code 1",
      ok: false,
    });
    expect(eventLine({ type: "started" }).ok).toBeNull();
  });
});

describe("estimate", () => {
  it("gives time and the agent's own model cost when it reported usage", () => {
    const lines = estimateLines({
      episodes: 56,
      perEpisode: { toolCalls: 9, seconds: 20, costUsd: 0.012 },
      total: { seconds: 1120, costUsd: 0.67 },
      basis: "connection check c1",
    });
    expect(lines.time).toBe(
      "About 19 min for 56 episodes (20 s and 9 tool calls each in the check).",
    );
    expect(lines.cost).toMatch(/about \$0.67 in all \(\$0.012 an episode\)/);
  });
  it("says so when there's no usage to estimate from", () => {
    const lines = estimateLines({
      episodes: 56,
      perEpisode: { toolCalls: 9, seconds: 20 },
      total: { seconds: 1120 },
      basis: "connection check c1",
    });
    expect(lines.cost).toMatch(/didn't report its usage/);
  });
});

describe("code hash source", () => {
  it("names where it came from", () => {
    expect(codeSourceLabel({ value: "0x", source: "git", detail: "a1b2c3d" })).toBe(
      "the git commit of your agent's folder (a1b2c3d), reported by the runner",
    );
    expect(codeSourceLabel({ value: "0x", source: "git-dirty" })).toMatch(/uncommitted changes/);
    expect(codeSourceLabel({ value: "0x", source: "unpinned" })).toMatch(
      /not pinned to a version \(set a git commit or image digest\)/,
    );
    expect(codeSourceLabel({ value: "0x", source: "url", detail: "v3" })).toBe(
      "the version your agent reported (v3)",
    );
    expect(codeSourceLabel({ value: "0x", source: "url-version", detail: "v2" })).toBe(
      "the version your agent reported (v2)",
    );
    expect(codeSourceLabel({ value: "0x", source: "declared" })).toBe("you entered it");
  });
});

describe("inputs", () => {
  it("accepts only a public https Agent URL", () => {
    expect(agentUrlError("")).toBe("Paste your agent's URL.");
    expect(agentUrlError("nope")).toMatch(/isn't a URL/);
    expect(agentUrlError("http://a.example")).toBe("It must start with https://.");
    expect(agentUrlError("https://user:pw@a.example")).toMatch(/user name/);
    for (const host of [
      "localhost",
      "x.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.20.0.1",
      "[::1]",
    ])
      expect(agentUrlError(`https://${host}/x`)).toMatch(/use the runner/);
    expect(agentUrlError(" https://agent.example.com/bonded ")).toBeNull();
    // The local demo's API takes an agent on this machine.
    expect(agentUrlError("http://127.0.0.1:8811", { allowLoopback: true })).toBeNull();
    expect(agentUrlError("http://10.0.0.1:8811", { allowLoopback: true })).toMatch(/https/);
  });
  it("checks the webhook and email, both optional", () => {
    expect(webhookError("")).toBeNull();
    expect(webhookError("http://x.example")).toMatch(/https/);
    expect(webhookError("https://hooks.example/x")).toBeNull();
    expect(emailError("")).toBeNull();
    expect(emailError("me@")).toMatch(/email/);
    expect(emailError("me@example.com")).toBeNull();
  });
});

describe("preview session", () => {
  afterEach(() => sessionStorage.clear());
  it("keeps the session for this tab until it expires", () => {
    const wallet = "0x00000000000000000000000000000000000000AA";
    saveSession(46630, { session: "s1", wallet, expiresAt: iso(3_600_000) });
    expect(loadSession(46630, wallet.toLowerCase(), NOW)?.session).toBe("s1");
    expect(loadSession(46630, wallet, NOW + 2 * 3_600_000)).toBeUndefined();
    expect(loadSession(1, wallet, NOW)).toBeUndefined();
    clearSession(46630, wallet);
    expect(loadSession(46630, wallet, NOW)).toBeUndefined();
  });
});

describe("previewStep", () => {
  const passed = {
    id: "c",
    status: "passed" as const,
    createdAt: iso(-60_000),
    connection: "url" as const,
  };
  const url = { url: "https://a.example", verifiedAt: iso(-120_000), version: null };
  it("walks the steps from what exists", () => {
    expect(previewStep({ signedIn: false, preview: undefined })).toBe("sign-in");
    expect(previewStep({ signedIn: true, preview: undefined })).toBe("choose");
    expect(previewStep({ signedIn: true, preview: basePreview(), nowMs: NOW })).toBe("connect");
    expect(
      previewStep({ signedIn: true, preview: basePreview({ agentUrl: url }), nowMs: NOW }),
    ).toBe("check");
    expect(
      previewStep({
        signedIn: true,
        preview: basePreview({ agentUrl: url, lastCheck: passed }),
        nowMs: NOW,
      }),
    ).toBe("start");
    expect(
      previewStep({
        signedIn: true,
        preview: basePreview({ ratingId: "r1", status: "running" }),
        nowMs: NOW,
      }),
    ).toBe("rating");
    expect(
      previewStep({
        signedIn: true,
        preview: basePreview({ ratingId: "r1", status: "done" }),
        nowMs: NOW,
      }),
    ).toBe("report");
    expect(
      previewStep({
        signedIn: true,
        preview: basePreview({ ratingId: "r1", status: "running" }),
        runFinished: true,
      }),
    ).toBe("report");
  });
});
