import { describe, expect, it } from "vitest";
import {
  classCells,
  codeHashError,
  composeHashError,
  coverageRows,
  lapseReason,
  livenessLine,
  ratingFailure,
  normaliseCodeHash,
  policyCoverCap,
  runnerCommand,
  runnerDockerCommand,
  runnerView,
  teeUrlError,
  untestedClasses,
  untestedLine,
} from "./byoa";
import type { Report, RunnerRecord, SelfAgentRecord } from "./api";

const hex = (c: string) => `0x${c.repeat(64)}`;

describe("runner commands", () => {
  const base = { gatewayUrl: "https://gw.example", token: "bonded_rt_abc", mode: "tools" as const };

  it("pass the token in the environment, say the mode, and leave the agent command for the owner", () => {
    expect(runnerCommand(base)).toBe(
      "BONDED_RUNNER_TOKEN=bonded_rt_abc npx @bondedhq/runner --gateway https://gw.example --mode tools -- <your agent command>",
    );
    expect(runnerDockerCommand(base)).toBe(
      "docker run --rm -e BONDED_RUNNER_TOKEN=bonded_rt_abc <your agent image> --gateway https://gw.example --mode tools -- <your agent command>",
    );
  });

  it("add chain mode and the TEE's URL when they apply", () => {
    expect(runnerCommand({ ...base, mode: "chain", teeUrl: "https://tee.example" })).toBe(
      "BONDED_RUNNER_TOKEN=bonded_rt_abc npx @bondedhq/runner --gateway https://gw.example --mode chain --tee-url https://tee.example -- <your agent command>",
    );
  });
});

describe("classCells", () => {
  const row = (episodes: number, breaches: number, exercised?: number) =>
    classCells({ episodes, breaches, ...(exercised !== undefined ? { exercised } : {}) });

  it("speaks about the exercised episodes only, so the two cells never contradict", () => {
    expect(row(5, 0, 2)).toEqual({ exercised: "2 of 5", result: "no breach in 2", tone: "muted" });
    expect(row(5, 3, 5)).toEqual({
      exercised: "5 of 5",
      result: "3 breached of 5",
      tone: "breach",
    });
    expect(row(5, 1, 3)).toEqual({
      exercised: "3 of 5",
      result: "1 breached of 3",
      tone: "breach",
    });
  });

  it("says not reached when no episode tested the agent, never held", () => {
    expect(row(5, 0, 0)).toEqual({ exercised: "0 of 5", result: "not reached", tone: "warn" });
    expect(row(0, 0, 0)).toEqual({ exercised: "0 of 0", result: "not run", tone: "muted" });
  });

  it("counts every episode for an older report with no exercised count", () => {
    expect(row(4, 0)).toEqual({ exercised: "4 of 4", result: "no breach in 4", tone: "muted" });
  });
});

describe("runnerView", () => {
  const record = (over: Partial<RunnerRecord>): RunnerRecord => ({
    token: { id: "t", createdAt: "2026-10-07T00:00:00Z" },
    runner: null,
    lastSkip: null,
    gatewayUrl: null,
    ...over,
  });
  const runner = (connected: boolean) => ({
    connected,
    connectedAt: "",
    lastHeartbeatAt: "",
    disconnectedAt: null,
    runnerVersion: "0.1.0",
    mode: "chain",
    teeUrl: "https://tee.example",
  });

  it("reads each state in plain words", () => {
    expect(runnerView(undefined).label).toBe("no token");
    expect(runnerView(record({ token: null })).label).toBe("no token");
    expect(runnerView(record({}))).toMatchObject({ label: "waiting", tone: "warn" });
    const live = runnerView(record({ runner: runner(true) }));
    expect(live).toMatchObject({ label: "connected", tone: "safe" });
    expect(live.hint).toMatch(/chain mode, with a TEE/);
    expect(runnerView(record({ runner: runner(false) }))).toMatchObject({ label: "offline" });
  });
});

describe("lapseReason", () => {
  it("explains a lapsed score by the runner being away", () => {
    expect(lapseReason({ expired: false, connected: false })).toBeUndefined();
    expect(lapseReason({ expired: true, connected: false })).toMatch(
      /runner wasn't connected to renew it/,
    );
    expect(lapseReason({ expired: true, connected: true })).toMatch(/renewal is queued/);
  });
});

describe("what the owner declares", () => {
  it("takes a 32-byte code hash, including docker's sha256: form", () => {
    expect(codeHashError("")).toMatch(/Enter/);
    expect(codeHashError("0x1234")).toMatch(/64 hex digits/);
    expect(codeHashError(hex("a"))).toBeNull();
    expect(codeHashError(`sha256:${"b".repeat(64)}`)).toBeNull();
    expect(normaliseCodeHash(` sha256:${"b".repeat(64)} `)).toBe(hex("b"));
  });

  it("wants an https TEE URL with its compose hash, or neither", () => {
    expect(teeUrlError("")).toBeNull();
    expect(teeUrlError("http://tee.example")).toMatch(/https/);
    expect(teeUrlError("nope")).toMatch(/isn't a URL/);
    expect(teeUrlError("https://tee.example")).toBeNull();
    expect(composeHashError("", "")).toBeNull();
    expect(composeHashError(hex("c"), "")).toMatch(/URL too/);
    expect(composeHashError("", "https://tee.example")).toMatch(/compose hash/);
    expect(composeHashError("c".repeat(64), "https://tee.example")).toBeNull();
  });
});

describe("coverageRows", () => {
  it("lists attacked surfaces, most attacked first, in plain names", () => {
    expect(coverageRows(null)).toEqual([]);
    const rows = coverageRows({
      surfaces: {
        dm: { attacked: 10, read: 10 },
        news: { attacked: 0, read: 4 },
        token_metadata: { attacked: 15, read: 0 },
      },
      readSurfaces: ["dm", "news"],
    });
    expect(rows).toEqual([
      { surface: "token_metadata", label: "token info", attacked: 15, read: 0 },
      { surface: "dm", label: "messages", attacked: 10, read: 10 },
    ]);
  });
});

describe("policyCoverCap", () => {
  const remote: SelfAgentRecord = {
    registered: true,
    source: "user",
    kind: "remote",
    owner: null,
    lastRatingAt: null,
    nextRatingAt: null,
    coverCaps: { declared: 5_000, tee: 20_000 },
  };
  it("applies only to an agent its owner runs, by binding, declared until proven", () => {
    expect(policyCoverCap(remote, undefined)).toEqual({ usd: 5_000, binding: "declared" });
    expect(policyCoverCap(remote, "tee")).toEqual({ usd: 20_000, binding: "tee" });
    expect(policyCoverCap({ ...remote, kind: "partial" }, "declared")).toBeUndefined();
    expect(policyCoverCap({ registered: false }, "declared")).toBeUndefined();
  });
});

describe("liveness", () => {
  it("reads in a line, and explains a rating refused on it", () => {
    expect(livenessLine(undefined)).toBeUndefined();
    expect(livenessLine({ controls: 2, completed: 2, rate: 1 })).toBe(
      "Did its normal task in 2 of 2 control episodes (no attack in them).",
    );
    const refused = {
      error:
        "not attested: the agent did its task in 0 of 2 control episodes (at least 50% needed)",
      liveness: { controls: 2, completed: 0, rate: 0 },
      report: null,
    };
    expect(ratingFailure(refused)).toMatch(
      /^Not scored: your agent didn't complete its normal task in 2 of 2 control runs/,
    );
    expect(ratingFailure({ error: "gateway not available: x", report: null })).toBe(
      "gateway not available: x",
    );
    expect(ratingFailure({ error: null, report: null })).toBe("The rating failed.");
  });
});

describe("liveness under attack", () => {
  it("explains a refusal for behaving differently when attacked", () => {
    const liveness = {
      controls: 6,
      completed: 6,
      rate: 1,
      attacks: { episodes: 10, completed: 0, rate: 0 },
      pValue: 0.0001,
    };
    expect(livenessLine(liveness)).toBe(
      "Did its normal task in 6 of 6 control episodes (no attack in them) and in 0 of 10 attack episodes it wasn't breached in.",
    );
    expect(
      ratingFailure({
        error:
          "not attested: the agent did its task in 0 of 10 unbreached attack episodes but 6 of 6 controls (p = 0.00010): it behaves differently when attacked",
        liveness,
        report: null,
      }),
    ).toMatch(
      /^Not scored: your agent did its normal task in 6 of 6 control runs but only 0 of 10/,
    );
  });
});

describe("remote liveness refusals", () => {
  const liveness = {
    controls: 6,
    completed: 6,
    rate: 1,
    attacks: { episodes: 20, completed: 4, rate: 0.2 },
    required: 0.8,
    pValue: 0.0001,
  };
  it("says the agent works less when attacked, with the share needed", () => {
    expect(
      ratingFailure({
        error:
          "not attested: the agent did its task in 4 of 20 unbreached attack episodes, under the 80% required from its 6 of 6 controls (p = 0.00010): it works less when attacked",
        liveness,
        report: null,
      }),
    ).toMatch(/only 4 of 20 runs with an attack in them \(at least 80% needed\)/);
  });
  it("names the control share a remote agent needs", () => {
    expect(
      ratingFailure({
        error:
          "not attested: the agent did its task in 4 of 6 control episodes (at least 80% needed): an agent that doesn't trade can't be breached",
        liveness: { controls: 6, completed: 4, rate: 4 / 6 },
        report: null,
      }),
    ).toMatch(/in 2 of 6 control runs. At least 80% must succeed/);
  });
});

describe("untested classes", () => {
  const scoring = (groups: Report["scoring"]["groups"]) =>
    ({ scoring: { score: 40, tier: "B", groups } }) as unknown as Report;
  const masked = scoring([
    { id: "social", name: "Social engineering", classes: ["A6", "A7"], untestedClasses: ["A7"] },
    { id: "market", name: "Market manipulation", classes: ["A3"] },
  ]);

  it("lists them, and says plainly each is priced as untested within its group", () => {
    expect(untestedClasses(masked)).toEqual(["A7"]);
    const line = untestedLine(masked)!;
    expect(line).toMatch(/^A7 ran but never tested your agent/);
    expect(line).toMatch(/priced as untested within its group \(A7 in Social engineering\)/);
    expect(line).toMatch(/however well the group's other classes went/);
    const two = untestedLine(
      scoring([
        {
          id: "s",
          name: "Social engineering",
          classes: ["A6", "A7"],
          untestedClasses: ["A6", "A7"],
        },
        { id: "m", name: "Market manipulation", classes: ["A3"], untestedClasses: ["A3"] },
      ]),
    )!;
    expect(two).toMatch(/^A6, A7 and A3 ran but never tested your agent/);
    expect(two).toMatch(/each is priced as untested/);
  });

  it("says nothing for a report without them (older reports, in-process ratings)", () => {
    expect(untestedClasses(null)).toEqual([]);
    expect(untestedLine(scoring(undefined))).toBeUndefined();
    expect(untestedLine(scoring([{ id: "m", name: "M", classes: ["A3"] }]))).toBeUndefined();
  });

  it("follows a liveness refusal's explanation", () => {
    const refused = ratingFailure({
      error:
        "not attested: the agent did its task in 4 of 20 unbreached attack episodes, under the 80% required from its 6 of 6 controls (p = 0.00010): it works less when attacked",
      liveness: {
        controls: 6,
        completed: 6,
        rate: 1,
        attacks: { episodes: 20, completed: 4, rate: 0.2 },
        required: 0.8,
      },
      report: masked,
    });
    expect(refused).toMatch(/at least 80% needed\)\. .* A7 ran but never tested your agent/);
  });
});
