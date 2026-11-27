import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type LeaderboardRecord } from "../lib/api";
import type { AgentRow } from "../lib/chain";
import type { EpisodeCard } from "../lib/events";
import { Overview, START, heldShare, pathDetails, pulseOf, topAgents } from "./Overview";

const state = vi.hoisted(() => ({ address: undefined as string | undefined }));
vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useAccount: () => ({ address: state.address, isConnected: Boolean(state.address) }),
  useReadContracts: () => ({ data: undefined }),
}));
vi.mock("../lib/owner-session", () => ({ useOwnerSession: () => ({ session: undefined }) }));
vi.mock("../lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chain")>()),
  useAgents: () => ({ data: [] }),
  useVaults: () => ({ data: [] }),
  useClaims: () => ({ data: [] }),
}));

const OWNER = "0x00000000000000000000000000000000000000a1";

/** An on-chain agent with a Security score and an insurance score. */
const agent = (id: number, securityScore?: number, score = 50): AgentRow => ({
  agentId: BigInt(id),
  owner: OWNER,
  ...(securityScore === undefined
    ? {}
    : { score: { score, securityScore, expectedLossBps: 100, issuedAt: 0n, expiresAt: 0n } }),
});

/** The leaderboard entry for an on-chain agent: only the fields the ranking reads. */
const entry = (
  id: number,
  kind: "framework" | "reference",
  securityGrade: number | undefined,
  task: number | null,
) =>
  ({
    kind,
    onchain: { agentId: id },
    name: `Template ${id}`,
    ...(securityGrade === undefined ? {} : { securityGrade }),
    task: task === null ? undefined : { score: task },
  }) as unknown as LeaderboardRecord;

describe("the overview's top agents", () => {
  it("ranks by Security, not the insurance score, with each agent's Task score", () => {
    const top = topAgents(
      [agent(8, 11, 82), agent(3, 33, 40), agent(5, 28, 60), agent(7)],
      [
        entry(8, "framework", 11, 97),
        entry(3, "framework", 33, 98),
        entry(5, "framework", 28, null),
      ],
    );
    expect(top.map((t) => [Number(t.agent.agentId), t.security, t.task])).toEqual([
      [3, 33, 98],
      [5, 28, null],
      [8, 11, 97],
    ]);
    // Each row carries the agent's name on the leaderboard, not just its number.
    expect(top[0]!.name).toBe("Template 3");
  });

  it("ranks only the agents the leaderboard ranks, and keeps four", () => {
    // 1 is a scripted reference agent; 2 is Bonded's own demo agent, not on the leaderboard.
    const top = topAgents(
      [agent(1, 100), agent(2, 100), agent(3, 80), agent(4, 70), agent(5, 60), agent(6, 50)],
      [
        entry(1, "reference", 100, 0),
        ...[3, 4, 5, 6].map((id) => entry(id, "framework", 100 - id * 10, 90)),
      ],
    );
    expect(top.map((t) => Number(t.agent.agentId))).toEqual([3, 4, 5, 6]);
  });

  it("leaves out entries the leaderboard doesn't rank, and shows its grade over the chain's", () => {
    const top = topAgents(
      // 4's on-chain grade is older than its latest rating; 5 has no grade on the leaderboard.
      [agent(4, 20), agent(5, 90), agent(6, 50)],
      [
        entry(4, "framework", 60, 80),
        entry(5, "framework", undefined, 80),
        entry(6, "framework", 50, 70),
      ],
    );
    expect(top.map((t) => [Number(t.agent.agentId), t.security])).toEqual([
      [4, 60],
      [6, 50],
    ]);
  });
});

describe("the overview's way in", () => {
  it("starts with testing an agent, then the payment gate, and needs no wallet for any of them", () => {
    expect(START.map((p) => p.to)).toEqual(["/agents/test", "/gate", "/index"]);
    for (const p of START) {
      expect(p.text.split(" ").length, p.title).toBeLessThanOrEqual(12);
      expect(`${p.title} ${p.text}`, p.title).not.toMatch(/wallet|deposit|underwrite|vault/i);
    }
  });
});

describe("the overview's ways in", () => {
  it("shows a signed-in owner's own counts and the model at the top of the Index", () => {
    expect(pathDetails({ tests: 3, accounts: 1 }, { label: "GLM-5.3", score: 92 })).toEqual([
      "3 tests so far",
      "1 gate account",
      "GLM-5.3 leads, 92",
    ]);
    // Signed out: nothing about the owner, and no wallet talk.
    expect(pathDetails({}, undefined)).toEqual([undefined, undefined, undefined]);
  });
});

const card = (k: number, attackClass: string | null, breached = false): EpisodeCard => ({
  eventId: `e${k}`,
  runId: "r",
  index: k,
  total: 3,
  attackId: attackClass ? `${attackClass.toLowerCase()}-x` : null,
  attackClass,
  breached,
  lossUsd: 0,
  frozen: false,
});

describe("the Arena pulse", () => {
  it("puts the newest episode on the right, each with its outcome", () => {
    // The API sends newest first.
    const pulse = pulseOf([card(3, "O1", true), card(2, null), card(1, "O2")]);
    expect(pulse.map((p) => [p.card.eventId, p.outcome])).toEqual([
      ["e1", "held"],
      ["e2", "control"],
      ["e3", "breach"],
    ]);
  });

  it("counts the held share over attacked episodes only, and nothing when none were attacked", () => {
    expect(heldShare({ held: 9, breach: 3 })).toEqual({ attacked: 12, pct: 75 });
    expect(heldShare({ held: 0, breach: 0 })).toBeUndefined();
  });
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/overview"]}>
        <Overview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the overview page", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    state.address = undefined;
  });

  it("opens on the three ways in, then the Index, the red team and the test chain", async () => {
    vi.spyOn(api, "library").mockResolvedValue({
      published: 55,
      acceptedBounties: 0,
      heldOut: { active: 15, retiresFrom: "2027-01-03T00:00:00Z" },
    });
    vi.spyOn(api, "episodes").mockResolvedValue({
      items: [card(2, "O1", true), card(1, "O2")],
      page: 1,
      pages: 1,
      total: 2,
      through: "2",
      counts: { total: 2, held: 1, breach: 1, control: 0 },
    });
    vi.spyOn(api, "leaderboard").mockResolvedValue({
      headline: { templates: 0, failingTemplates: 0, evaluations: 0, failingEvaluations: 0 },
      entries: [],
    });
    show();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Test your agent.Then hold itto your rules.",
    );
    const links = START.map((p) => screen.getByRole("link", { name: new RegExp(p.title) }));
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/agents/test", "/gate", "/index"]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Which models are hardest to trick into paying.",
      "Attacks written to trick agents into paying.",
      "On the test chain",
    ]);
    // The library's numbers, and the Arena's latest verdict with every episode as a link.
    await waitFor(() => expect(screen.getByText("55")).toBeTruthy());
    expect(screen.getByText("15")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Breach.")).toBeTruthy());
    expect(screen.getByText("50%")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "An agent was tricked by o1-x" }).getAttribute("href"),
    ).toBe("/arena/episodes/e2");
    // Signed out: no wallet talk and no roles.
    expect(screen.queryByText(/wallet/i)).toBeNull();
    expect(screen.queryByText("Your on-chain roles")).toBeNull();
  });

  it("says the Arena is quiet when no episodes are running", async () => {
    vi.spyOn(api, "library").mockResolvedValue({
      published: 55,
      acceptedBounties: 0,
      heldOut: { active: 15, retiresFrom: "2027-01-03T00:00:00Z" },
    });
    vi.spyOn(api, "episodes").mockResolvedValue({
      items: [],
      page: 1,
      pages: 1,
      total: 0,
      through: "0",
      counts: { total: 0, held: 0, breach: 0, control: 0 },
    });
    vi.spyOn(api, "leaderboard").mockRejectedValue(new Error("down"));
    show();
    await waitFor(() => expect(screen.getByText("Quiet right now.")).toBeTruthy());
    // No held share is made up from nothing.
    expect(screen.queryByText("Held in the Arena")).toBeNull();
  });

  it("shows a wallet's on-chain roles", () => {
    state.address = "0x00000000000000000000000000000000000000a1";
    vi.spyOn(api, "library").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "episodes").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "leaderboard").mockReturnValue(new Promise(() => {}));
    show();
    expect(screen.getByRole("heading", { name: "Your on-chain roles" })).toBeTruthy();
    expect(screen.getByText("Depositing")).toBeTruthy();
    expect(screen.getByText("Operating")).toBeTruthy();
    expect(screen.getByText("Underwriting")).toBeTruthy();
  });
});
