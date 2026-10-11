import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCodeBlock, getCodeBlock, queryCodeBlock } from "../test/code";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { deployment } from "../config";
import { ApiError, api } from "../lib/api";
import { byoaApi, type PreviewRecord } from "../lib/byoa-api";
import { saveSession } from "../lib/connect";
import {
  connectedRunner,
  finishedRun,
  iso,
  passedCheck,
  preview,
  verifiedUrl,
} from "../test/byoa-fixtures";
import { TestAgent } from "./TestAgent";

const WALLET = "0x00000000000000000000000000000000000000a1";
const wallet = vi.hoisted(() => ({ address: undefined as string | undefined }));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: wallet.address, isConnected: Boolean(wallet.address) }),
  useSignMessage: () => ({ signMessageAsync: async () => "0x5151" }),
}));
vi.mock("../components/wallet", () => ({
  ConnectButton: () => <button type="button">Connect wallet</button>,
}));

function Search() {
  return <span data-testid="search">{useLocation().search}</span>;
}
function show(url = "/agents/test") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[url]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route
            path="/agents/test"
            element={
              <>
                <TestAgent />
                <Search />
              </>
            }
          />
          <Route path="/agents/new" element={<p>Onboarding</p>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
const signedIn = () =>
  saveSession(deployment.chainId, { session: "sess", wallet: WALLET, expiresAt: iso(3_600_000) });
/** The step the page marks as current. */
const current = () => document.querySelector('[aria-current="step"]') as HTMLElement;
const withPreview = (p: PreviewRecord) => {
  signedIn();
  vi.spyOn(byoaApi, "preview").mockResolvedValue(p);
  show(`/agents/test?preview=${p.id}`);
};

beforeEach(() => {
  wallet.address = WALLET;
  vi.spyOn(byoaApi, "previewAllowance").mockResolvedValue({
    allowed: true,
    queued: 0,
    plan: { episodes: 56, budgetSeconds: 2240 },
  });
  vi.spyOn(byoaApi, "listPreviews").mockResolvedValue({ items: [] });
  vi.spyOn(byoaApi, "notifications").mockResolvedValue({
    webhook: null,
    email: null,
    emailAvailable: false,
  });
  vi.spyOn(byoaApi, "estimate").mockResolvedValue({
    episodes: 56,
    perEpisode: { toolCalls: 9, seconds: 20, costUsd: 0.01 },
    total: { seconds: 1120, costUsd: 0.56 },
    basis: "connection check chk-1",
  });
  vi.spyOn(byoaApi, "ratingProgress").mockReturnValue(() => {});
  vi.spyOn(byoaApi, "previewEvents").mockReturnValue(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("Test your agent", () => {
  it("starts by asking for a wallet, and shows the whole path", () => {
    wallet.address = undefined;
    show();
    expect(within(current()).getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(within(current()).getByText(/won't send anything or pay gas/)).toBeTruthy();
    for (const title of [
      "Tell us about your agent",
      "Connect it",
      "Check the connection",
      "Start the preview rating",
      "Your preview report",
    ])
      expect(screen.getByRole("heading", { name: new RegExp(title) })).toBeTruthy();
    expect(screen.getAllByText(/Preview: not on chain, not insurable/).length).toBeGreaterThan(0);
    // The page says this is a preview: nothing else on it does.
    expect(screen.getByRole("heading", { name: "This is a preview rating" })).toBeTruthy();
  });

  it("says how big a preview is from the API's plan, and nothing when it has none", async () => {
    show();
    expect(
      await screen.findByText(/up to 56 episodes, stopped at 37 min at the most/),
    ).toBeTruthy();
    cleanup();
    vi.mocked(byoaApi.previewAllowance).mockResolvedValue({ allowed: true, queued: 0, plan: null });
    show();
    await waitFor(() => expect(byoaApi.previewAllowance).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/minutes|min at the most/)).toBeNull();
  });

  it("signs in once, then asks the framework and where it runs, with the mode under Advanced", async () => {
    const signIn = vi
      .spyOn(byoaApi, "signIn")
      .mockResolvedValue({ session: "sess", wallet: WALLET, expiresAt: iso(3_600_000) });
    show();
    fireEvent.click(within(current()).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith(expect.any(Function), WALLET));
    await waitFor(() =>
      expect(within(current()).getByText("Tell us about your agent")).toBeTruthy(),
    );
    const step = current();
    expect(within(step).getByText("Which framework is your agent built on?")).toBeTruthy();
    for (const f of [
      /^ElizaOS/,
      /^Coinbase AgentKit/,
      /^LangChain or LangGraph/,
      /^Vercel AI SDK/,
      /^Something else/,
      /^Python/,
    ])
      expect(within(step).getByRole("radio", { name: f })).toBeTruthy();
    expect(within(step).getByText("Where do you run it?")).toBeTruthy();
    expect(within(step).getByRole("radio", { name: /It's online at a URL/ })).toBeTruthy();
    expect(within(step).getByRole("radio", { name: /On my computer or server/ })).toBeTruthy();
    expect(within(step).getByText(/Nothing to install/)).toBeTruthy();
    // A hint for those who aren't sure which to pick.
    expect(
      within(step).getByText(
        "Not sure? Choose On my computer or server: it works for any agent you can start from a terminal.",
      ),
    ).toBeTruthy();
    // Tools or chain is for those who need it: under Advanced, closed.
    const advanced = within(step).getByRole("button", { name: "Advanced (optional)" });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    expect(within(step).getByRole("radio", { name: /Tools/ })).toBeTruthy();
    expect(within(step).getByRole("radio", { name: /^Chain/ })).toBeTruthy();
    expect(screen.getByText(/Signed in as/)).toBeTruthy();
  });

  it("creates the preview with the choices and moves on to connecting", async () => {
    signedIn();
    const created = preview({ id: "p7", connection: "runner", mode: "chain" });
    const create = vi.spyOn(byoaApi, "createPreview").mockResolvedValue(created);
    vi.spyOn(byoaApi, "preview").mockResolvedValue(created);
    const token = vi
      .spyOn(byoaApi, "createRunnerToken")
      .mockResolvedValue({ token: "bonded_rt_preview", gatewayUrl: "https://gw.example" });
    show();
    fireEvent.click(await screen.findByRole("radio", { name: /^Python/ }));
    fireEvent.click(screen.getByRole("radio", { name: /On my computer or server/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^Chain/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("sess", { mode: "chain", connection: "runner" }),
    );
    await waitFor(() => expect(screen.getByTestId("search").textContent).toBe("?preview=p7"));
    // The runner's token comes with no signature, straight into the commands.
    await waitFor(() =>
      expect(token).toHaveBeenCalledWith({ kind: "preview", id: "p7" }, { session: "sess" }),
    );
    expect(
      await findCodeBlock(
        "BONDED_RUNNER_TOKEN=bonded_rt_preview npx @bondedhq/runner --gateway https://gw.example --mode chain -- <your agent command>",
      ),
    ).toBeTruthy();
    expect(getCodeBlock(/docker run --rm -e BONDED_RUNNER_TOKEN=bonded_rt_preview/)).toBeTruthy();
    expect(screen.getByText(/Waiting for the runner to connect/)).toBeTruthy();
    expect(screen.getByText("Runner waiting")).toBeTruthy();
    // Python has no package.json for init to read: the page leads with the runner command.
    expect(screen.getByText("Start the runner with your agent's command")).toBeTruthy();
    expect(screen.queryByText(/npx @bondedhq\/runner init/)).toBeNull();
    expect(screen.getByRole("link", { name: "Try the example agent" })).toBeTruthy();
    // Framework snippets, in tabs, opened on the framework picked.
    fireEvent.click(screen.getByText("Code for your agent, by framework"));
    expect(screen.getByRole("tab", { name: "Python", selected: true })).toBeTruthy();
    expect(screen.getByText(/BONDED_TOOLS_URL/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "LangChain" }));
    expect(screen.getByRole("tab", { name: "LangChain", selected: true })).toBeTruthy();
    // Keeping it running, for the renewals.
    fireEvent.click(screen.getByText("Keep it running"));
    expect(
      getCodeBlock(
        "npx @bondedhq/runner service --print systemd --gateway https://gw.example -- <your agent command>",
      ),
    ).toBeTruthy();
  });

  it.each([
    [/^Something else/, false],
    [/^LangChain or LangGraph/, true],
  ])("leads the runner step with init only for a Node framework (%s)", async (framework, init) => {
    signedIn();
    const created = preview({ id: "p8", connection: "runner", mode: "tools" });
    vi.spyOn(byoaApi, "createPreview").mockResolvedValue(created);
    vi.spyOn(byoaApi, "preview").mockResolvedValue(created);
    vi.spyOn(byoaApi, "createRunnerToken").mockResolvedValue({
      token: "bonded_rt_preview",
      gatewayUrl: "https://gw.example",
    });
    show();
    fireEvent.click(await screen.findByRole("radio", { name: framework }));
    fireEvent.click(screen.getByRole("radio", { name: /On my computer or server/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const command =
      "BONDED_RUNNER_TOKEN=bonded_rt_preview npx @bondedhq/runner --gateway https://gw.example --mode tools -- <your agent command>";
    expect(await findCodeBlock(command)).toBeTruthy();
    const initLine = queryCodeBlock(
      "BONDED_RUNNER_TOKEN=bonded_rt_preview npx @bondedhq/runner init --gateway https://gw.example",
    );
    if (init) {
      expect(initLine).toBeTruthy();
      expect(screen.getByText("Or start the runner yourself (Node)")).toBeTruthy();
    } else {
      expect(initLine).toBeNull();
      expect(screen.getByText("Start the runner with your agent's command")).toBeTruthy();
    }
  });

  it("asks for a URL and verifies it", async () => {
    withPreview(preview());
    expect(await screen.findByLabelText("Your agent's URL")).toBeTruthy();
    expect(within(current()).getByText("Connect it")).toBeTruthy();
    fireEvent.click(screen.getByText("Code for your agent: the handler and frameworks"));
    expect(screen.getByRole("tab", { name: "Agent URL handler", selected: true })).toBeTruthy();
  });

  it("moves to the check once the URL is verified", async () => {
    withPreview(preview({ agentUrl: verifiedUrl }));
    await waitFor(() => expect(within(current()).getByText("Check the connection")).toBeTruthy());
    expect(
      within(current()).getByRole("button", { name: "Run the connection check" }),
    ).toHaveProperty("disabled", false);
    expect(screen.getByText(/Verified/)).toBeTruthy();
  });

  it("shows the estimate before starting, then a refused start in plain words", async () => {
    withPreview(
      preview({
        agentUrl: verifiedUrl,
        lastCheck: {
          ...passedCheck("url"),
          warnings: ["It read 2 of 9 surfaces; unread ones are scored as untested"],
        },
      }),
    );
    await waitFor(() =>
      expect(within(current()).getByText("Start the preview rating")).toBeTruthy(),
    );
    expect(await screen.findByText(/About 19 min for 56 episodes/)).toBeTruthy();
    // How big a preview is comes from the API's plan, beside the steps.
    expect(screen.getByText(/up to 56 episodes, stopped at 37 min at the most/)).toBeTruthy();
    // The check's advice stays reachable after it passed, folded away until asked for.
    fireEvent.click(screen.getByText("1 thing worth fixing before you start"));
    expect(screen.getByText(/It read 2 of 9 surfaces/)).toBeTruthy();
    vi.spyOn(byoaApi, "startPreviewRating").mockRejectedValue(
      new ApiError(429, "one preview per wallet per day", { retryAt: iso(9 * 3_600_000) }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start preview rating" }));
    expect(await screen.findByText("You've used today's preview; try again in 9 h.")).toBeTruthy();
  });

  it("says up front when today's preview is used, and still lets the agent be connected", async () => {
    vi.mocked(byoaApi.previewAllowance).mockResolvedValue({
      allowed: false,
      reason: "one preview per wallet per day",
      retryAt: iso(9 * 3_600_000),
      queued: 0,
    });
    withPreview(preview({ agentUrl: verifiedUrl, lastCheck: passedCheck("url") }));
    expect(
      (await screen.findAllByText("You've used today's preview; try again in 9 h.")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/You can still connect your agent/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start preview rating" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("won't start while the runner is away, even with a passing check", async () => {
    withPreview(
      preview({
        connection: "runner",
        hasRunnerToken: true,
        runner: { ...connectedRunner, connected: false },
        lastCheck: passedCheck("runner"),
      }),
    );
    await waitFor(() =>
      expect(within(current()).getByText("Start the preview rating")).toBeTruthy(),
    );
    expect(screen.getByText("The runner isn't connected. Start it again first.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start preview rating" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("follows the rating with its place in line, and offers notifications", async () => {
    vi.spyOn(api, "run").mockResolvedValue({ ...finishedRun(), status: "queued", report: null });
    withPreview(
      preview({
        agentUrl: verifiedUrl,
        lastCheck: passedCheck("url"),
        ratingId: "run-1",
        status: "queued",
        queue: { position: 1 },
      }),
    );
    expect(await screen.findByText("Previews are busy; you're next in line.")).toBeTruthy();
    expect(within(current()).getByText("Rating")).toBeTruthy();
    expect(screen.getByText(/Get told when it finishes, by webhook/)).toBeTruthy();
  });

  it("shows the labelled report when it's done", async () => {
    vi.spyOn(api, "run").mockResolvedValue(finishedRun());
    withPreview(
      preview({
        agentUrl: verifiedUrl,
        lastCheck: passedCheck("url"),
        ratingId: "run-1",
        status: "done",
      }),
    );
    await waitFor(() => expect(within(current()).getByText("Your preview report")).toBeTruthy());
    expect(await within(current()).findByText("Preview: not on chain, not insurable")).toBeTruthy();
    fireEvent.click(within(current()).getByRole("button", { name: "Make it official" }));
    expect(await screen.findByText("Onboarding")).toBeTruthy();
  });

  it("says when a preview isn't this wallet's, with a way to start again", async () => {
    signedIn();
    vi.spyOn(byoaApi, "preview").mockRejectedValue(new ApiError(404, "no such preview"));
    show("/agents/test?preview=nope");
    expect(await screen.findByText("That preview isn't here")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start a new preview" }));
    await waitFor(() => expect(screen.getByTestId("search").textContent).toBe(""));
  });

  it("asks to sign in again when the session expired", async () => {
    signedIn();
    vi.spyOn(byoaApi, "preview").mockRejectedValue(new ApiError(401, "session expired"));
    show("/agents/test?preview=p1");
    expect(await screen.findByText(/Your sign-in expired/)).toBeTruthy();
    expect(within(current()).getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("lists the wallet's earlier previews to reopen", async () => {
    signedIn();
    vi.mocked(byoaApi.listPreviews).mockResolvedValue({
      items: [preview({ id: "old", status: "done", ratingId: "r0" })],
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Open it" }));
    await waitFor(() => expect(screen.getByTestId("search").textContent).toBe("?preview=old"));
  });

  it("shows the API being down with a way to retry", async () => {
    signedIn();
    const read = vi.spyOn(byoaApi, "preview").mockRejectedValue(new ApiError(503, "down"));
    show("/agents/test?preview=p1");
    // Server errors are retried twice first.
    expect(await screen.findByText(/couldn't complete that/, {}, { timeout: 6000 })).toBeTruthy();
    read.mockResolvedValue(preview());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByLabelText("Your agent's URL")).toBeTruthy());
  });

  it("follows the preview's stream, and reads the record again when its status moves on", async () => {
    let push!: (e: Parameters<Parameters<typeof byoaApi.previewEvents>[2]>[0]) => void;
    vi.mocked(byoaApi.previewEvents).mockImplementation((_s, _id, on) => {
      push = on;
      return () => {};
    });
    vi.spyOn(api, "run").mockResolvedValue({ ...finishedRun(), status: "queued", report: null });
    const queued = preview({
      agentUrl: verifiedUrl,
      lastCheck: passedCheck("url"),
      ratingId: "run-1",
      status: "queued",
      queue: { position: 2 },
    });
    withPreview(queued);
    expect(
      await screen.findByText("Previews are busy; 2 are ahead of you. It starts on its own."),
    ).toBeTruthy();
    expect(byoaApi.previewEvents).toHaveBeenCalledWith(
      "sess",
      "p1",
      expect.any(Function),
      expect.any(Function),
    );
    vi.mocked(byoaApi.preview).mockResolvedValue({ ...queued, queue: { position: 1 } });
    const reads = vi.mocked(byoaApi.preview).mock.calls.length;
    act(() =>
      push({
        status: "queued",
        ratingId: "run-1",
        reason: null,
        queue: { position: 1 },
        progress: null,
      }),
    );
    expect(await screen.findByText("Previews are busy; you're next in line.")).toBeTruthy();
    vi.mocked(byoaApi.preview).mockResolvedValue({ ...queued, status: "starting", queue: null });
    act(() =>
      push({ status: "starting", ratingId: "run-1", reason: null, queue: null, progress: null }),
    );
    await waitFor(() =>
      expect(vi.mocked(byoaApi.preview).mock.calls.length).toBeGreaterThan(reads),
    );
  });
});
