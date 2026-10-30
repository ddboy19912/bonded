import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { ApiError, api, type LeaderboardRecord } from "../lib/api";
import { Agent } from "./Agent";

const REPORT_HASH = "0x" + "ab".repeat(32);
const OWNER = "0x" + "11".repeat(20);

// The on-chain score, owner, bond and freshness the page reads from the registry.
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined }),
  useReadContract: () => ({ data: undefined }),
  useReadContracts: () => ({
    isLoading: false,
    isError: false,
    data: [
      {
        result: {
          securityScore: 33,
          score: 83,
          expectedLossBps: 133,
          issuedAt: 1_792_000_000n,
          expiresAt: 1_794_600_000n,
          reportHash: REPORT_HASH,
          mandateHash: "0x" + "cd".repeat(32),
          teeMeasurement: "0x" + "00".repeat(32),
        },
      },
      { result: OWNER },
      { result: 0n },
      { result: true },
    ],
  }),
}));
vi.mock("../lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chain")>()),
  useAgents: () => ({ data: [] }),
}));
vi.mock("../components/owner-tools", () => ({ OwnerTools: () => null }));
vi.mock("../components/wallet", () => ({
  ConnectButton: () => null,
  useSend: () => ({}),
  useOperatorToken: () => ({}),
  OperatorTokenField: () => null,
  OperatorTokenProvider: ({ children }: { children: unknown }) => children,
}));

const entry = (reportHash: string): LeaderboardRecord =>
  ({
    slug: "agentkit",
    name: "AgentKit chatbot",
    kind: "framework",
    framework: "Coinbase AgentKit",
    model: null,
    ratedAt: "2026-10-01T12:00:00Z",
    securityGrade: 33,
    score: 83,
    tier: "AA",
    expectedLossBps: 133,
    premiumRateBps: 200,
    insurable: true,
    episodes: { attacks: 75, controls: 5, controlBreaches: 0 },
    classes: [
      { class: "A2", name: "Injection via content", episodes: 40, manipulated: 0, breaches: 0 },
      { class: "A8", name: "Volatility and panic", episodes: 35, manipulated: 0, breaches: 0 },
    ],
    s1Classes: [
      {
        class: "A8",
        counted: 12,
        manipulated: 8,
        inducedInaction: 0,
        breaches: 0,
        graded: true,
      },
    ],
    reportHash,
    onchain: { chain: "robinhood-testnet", agentId: "4", tx: "0x" + "1".repeat(64) },
    disclosure: { status: "not-needed" },
    verified: true,
  }) as LeaderboardRecord;

function show(entries: LeaderboardRecord[]) {
  vi.spyOn(api, "leaderboard").mockResolvedValue({
    headline: { templates: 0, failingTemplates: 0, evaluations: 0, failingEvaluations: 0 },
    entries,
  });
  render(
    <MemoryRouter initialEntries={["/agents/4"]}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Routes>
          <Route path="/agents/:id" element={<Agent />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // Rated outside the hosted service: the API holds no score record or run for it.
  vi.spyOn(api, "score").mockRejectedValue(new ApiError(404, "not found"));
  vi.spyOn(api, "selfAgent").mockResolvedValue({ registered: false } as never);
  vi.spyOn(api, "sentinelAgent").mockRejectedValue(new ApiError(404, "not found"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const reportCard = async () =>
  (await screen.findByRole("heading", { name: "Attack report" })).closest("section")!;

describe("agent page without a hosted report", () => {
  it("builds the attack report and score panel from the matching leaderboard rating", async () => {
    show([entry("0x" + "00".repeat(32)), entry(REPORT_HASH.toUpperCase().replace("0X", "0x"))]);
    const card = await reportCard();
    expect(await within(card).findByText("From the published leaderboard rating")).toBeTruthy();
    expect(within(card).getByText("One weak class: A8")).toBeTruthy();
    expect(within(card).getByRole("table")).toBeTruthy();
    // The score panel names what set the score.
    expect(
      screen.getByText(
        "Its weakest class is A8, volatility and panic: false market data moved it to trade in 8 of 12 tries.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Easily tricked")).toBeTruthy();
  });

  it("says the report isn't available when no leaderboard rating matches", async () => {
    show([entry("0x" + "00".repeat(32))]);
    const card = await reportCard();
    expect(
      await within(card).findByText("The full report isn't available right now."),
    ).toBeTruthy();
    expect(within(card).queryByRole("table")).toBeNull();
    expect(within(card).queryByText("From the published leaderboard rating")).toBeNull();
  });
});

describe("task score tile", () => {
  it("shows the leaderboard rating's Task score and what set it", async () => {
    show([
      {
        ...entry(REPORT_HASH),
        task: {
          version: 1,
          score: 0,
          worst: "benign",
          controls: { trials: 6, done: 6, graded: true },
          underAttack: { trials: 0, done: 0, graded: false },
          benign: { trials: 11, done: 0, graded: true },
          classes: [],
          measuredAt: "2026-10-25T10:00:00.000Z",
          source: "task",
        },
      },
    ]);
    expect(
      await screen.findByText(
        "Did its job in 6 of 6 control episodes and 0 of 11 benign twins. Set by its benign twins.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("What is a benign twin?")).toBeTruthy();
  });

  it("says why when a Task score had too few episodes to count", async () => {
    show([
      {
        ...entry(REPORT_HASH),
        task: {
          version: 2,
          score: null,
          worst: null,
          controls: { trials: 2, done: 2, graded: false },
          underAttack: { trials: 0, done: 0, graded: false },
          benign: { trials: 0, done: 0, graded: false },
          classes: [],
          measuredAt: "2026-10-25T10:00:00.000Z",
          source: "task",
        },
      },
    ]);
    expect(
      await screen.findByText(
        "Not measured: too few episodes to count. Did its job in 2 of 2 control episodes (too few to count).",
      ),
    ).toBeTruthy();
  });

  it("explains benign twins when they ran but the Task score was not measured", async () => {
    show([
      {
        ...entry(REPORT_HASH),
        task: {
          version: 2,
          score: null,
          worst: null,
          controls: { trials: 2, done: 2, graded: false },
          underAttack: { trials: 0, done: 0, graded: false },
          benign: { trials: 3, done: 3, graded: false },
          classes: [],
          measuredAt: "2026-10-25T10:00:00.000Z",
          source: "task",
        },
      },
    ]);
    expect(await screen.findByText("What is a benign twin?")).toBeTruthy();
  });

  it("says it wasn't measured for a rating from before the Task score", async () => {
    show([entry(REPORT_HASH)]);
    expect(
      await screen.findByText(
        "Not measured for this rating: it ran before the Task score existed.",
      ),
    ).toBeTruthy();
  });
});

describe("dollars at risk beside the score", () => {
  const hosted = (extra: Record<string, unknown>) => {
    vi.spyOn(api, "score").mockResolvedValue({
      runId: "run-1",
      tx_hash: "0x" + "1".repeat(64),
      signed: { attestation: { reportHash: REPORT_HASH, issuedAt: 0, expiresAt: 0 } },
    } as never);
    vi.spyOn(api, "run").mockResolvedValue({
      id: "run-1",
      status: "done",
      report: {
        agent: "demo",
        modelFamily: "other",
        mandateMode: "monitor",
        forked: false,
        startedAt: "2026-10-30T10:00:00Z",
        durationMs: 1000,
        scoring: { score: 83, tier: "AA" },
        episodes: { total: 200, attacks: 150, controls: 50, agentErrors: 0 },
        controls: { episodes: 50, breaches: 0 },
        classes: [],
        ...extra,
      },
    } as never);
    show([]);
  };

  it("shows the report's figure in one line, with its assumptions", async () => {
    hosted({
      dollarsAtRisk: {
        perThousandRunsUsd: 4100,
        lostUsd: 820,
        runs: 200,
        attackRuns: 150,
        assumptions: ["Every run counts, attacked or not: 150 with an attack, 50 without."],
      },
    });
    expect(
      await screen.findByText("About $4,100 lost per 1,000 runs, attacked or not."),
    ).toBeTruthy();
    expect(screen.getByText("Assumptions")).toBeTruthy();
    expect(
      screen.getByText("Every run counts, attacked or not: 150 with an attack, 50 without."),
    ).toBeTruthy();
  });

  it("shows nothing for an older report without it, never $0", async () => {
    hosted({});
    // The hosted report has loaded: its episode counts head the attack report.
    expect(await screen.findByText(/150 attacks · 50 controls/)).toBeTruthy();
    expect(screen.queryByText("Dollars at risk:")).toBeNull();
    expect(screen.queryByText(/lost per 1,000 runs/)).toBeNull();
  });
});
