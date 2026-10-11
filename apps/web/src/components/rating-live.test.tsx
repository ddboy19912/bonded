import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ApiError, api, type RunRecord } from "../lib/api";
import { byoaApi, type RatingProgress } from "../lib/byoa-api";
import { finishedRun, preview, verifiedUrl } from "../test/byoa-fixtures";
import { Estimate, NotificationSettingsForm, RatingLive } from "./rating-live";
import { CopyButton, Tabs } from "./copy";
import { PREVIEW_LABEL, PreviewReport } from "./preview-report";

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </MemoryRouter>,
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const running = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  status: "running",
  error: null,
  created_at: "",
  report: null,
  ...over,
});

describe("RatingLive", () => {
  it("shows live counts and time left, never a verdict, until it finishes", async () => {
    vi.spyOn(api, "run").mockResolvedValue(running());
    let push!: (p: RatingProgress) => void;
    const close = vi.fn();
    vi.spyOn(byoaApi, "ratingProgress").mockImplementation((_id, _session, on) => {
      push = on;
      return close;
    });
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: vi.fn(async () => "granted"),
    });
    wrap(<RatingLive runId="run-1" label="Your preview" session="s" />);
    expect(await screen.findByText("Waiting for the first episode")).toBeTruthy();
    act(() => push({ done: 12, total: 56, etaSeconds: 900, startedAt: null }));
    expect(screen.getByText("12 of 56 episodes, about 15 min left")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Your preview progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("12");
    expect(bar.getAttribute("aria-valuemax")).toBe("56");
    expect(screen.queryByText(/breach/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tell me when it's done" }));
    expect(await screen.findByText("This tab will notify you when it finishes.")).toBeTruthy();
  });

  it("says it is setting up the sandbox while the rating starts", async () => {
    vi.spyOn(api, "run").mockResolvedValue(running({ status: "starting" }));
    vi.spyOn(byoaApi, "ratingProgress").mockReturnValue(() => {});
    wrap(<RatingLive runId="run-1" label="Your preview" session="s" />);
    expect(await screen.findByText(/Setting up the sandbox/)).toBeTruthy();
    expect(screen.getByText("Setting up")).toBeTruthy();
  });

  it("takes the freshest status it is told, e.g. the preview's stream saying it's starting", async () => {
    vi.spyOn(api, "run").mockResolvedValue(running({ status: "queued" }));
    vi.spyOn(byoaApi, "ratingProgress").mockReturnValue(() => {});
    wrap(<RatingLive runId="run-1" label="Your preview" session="s" statusHint="starting" />);
    expect(await screen.findByText(/Setting up the sandbox/)).toBeTruthy();
  });

  it("says where it waits in line before it starts", async () => {
    vi.spyOn(api, "run").mockResolvedValue(running({ status: "queued" }));
    vi.spyOn(byoaApi, "ratingProgress").mockReturnValue(() => {});
    wrap(
      <RatingLive
        runId="run-1"
        label="Your preview"
        queueText="Previews are busy; you're next in line."
      />,
    );
    expect(await screen.findByText("Previews are busy; you're next in line.")).toBeTruthy();
  });

  it("notifies the browser once when it finishes while the tab is hidden", async () => {
    vi.spyOn(api, "run").mockResolvedValue(running({ status: "done" }));
    vi.spyOn(byoaApi, "ratingProgress").mockReturnValue(() => {});
    const made = vi.fn();
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn();
      constructor(title: string, opts: unknown) {
        made(title, opts);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const onFinished = vi.fn();
    wrap(<RatingLive runId="run-1" label="Your preview" onFinished={onFinished} />);
    expect(await screen.findByText("Finished.")).toBeTruthy();
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith("done"));
    expect(made).toHaveBeenCalledTimes(1);
    expect(made.mock.calls[0]![0]).toBe("Your preview finished");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("explains why it stopped", async () => {
    vi.spyOn(api, "run").mockResolvedValue(
      running({ status: "failed", error: "stopped: the agent failed in episode 3 of 56" }),
    );
    vi.spyOn(byoaApi, "ratingProgress").mockReturnValue(() => {});
    wrap(<RatingLive runId="run-1" label="Your preview" />);
    expect(await screen.findByText("stopped: the agent failed in episode 3 of 56")).toBeTruthy();
  });

  it("points to a webhook when browser notifications are blocked", async () => {
    vi.spyOn(api, "run").mockResolvedValue(running());
    vi.spyOn(byoaApi, "ratingProgress").mockReturnValue(() => {});
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() });
    wrap(<RatingLive runId="run-1" label="Your preview" />);
    expect(await screen.findByText(/blocked for this site/)).toBeTruthy();
  });
});

describe("Estimate", () => {
  it("shows a placeholder of the same shape while loading, then the estimate", async () => {
    let resolve!: (v: Awaited<ReturnType<typeof byoaApi.estimate>>) => void;
    vi.spyOn(byoaApi, "estimate").mockReturnValue(new Promise((r) => (resolve = r)));
    const { container } = wrap(<Estimate subject={{ kind: "preview", id: "p1" }} enabled />);
    expect(container.querySelectorAll(".animate-pulse").length).toBe(2);
    act(() =>
      resolve({
        episodes: 56,
        perEpisode: { toolCalls: 9, seconds: 20 },
        total: { seconds: 1120 },
        basis: "connection check chk-1",
      }),
    );
    expect(await screen.findByText(/About 19 min for 56 episodes/)).toBeTruthy();
    expect(screen.getByText(/didn't report its usage/)).toBeTruthy();
    expect(screen.getByText(/An estimate, from your last connection check/)).toBeTruthy();
  });
  it("says it needs a passing check, and nothing when not asked for", async () => {
    vi.spyOn(byoaApi, "estimate").mockRejectedValue(new ApiError(409, "no passing check"));
    const { container } = wrap(<Estimate subject={{ kind: "preview", id: "p1" }} enabled />);
    expect(await screen.findByText(/comes from a passing connection check/)).toBeTruthy();
    cleanup();
    const off = wrap(<Estimate subject={{ kind: "preview", id: "p1" }} enabled={false} />);
    expect(off.container.textContent).toBe("");
    void container;
  });
});

describe("NotificationSettingsForm", () => {
  it("saves a webhook and shows its secret once; email only where it's set up", async () => {
    vi.spyOn(byoaApi, "notifications").mockResolvedValue({
      webhook: null,
      email: null,
      emailAvailable: false,
    });
    const save = vi.spyOn(byoaApi, "saveNotifications").mockResolvedValue({
      webhook: { url: "https://hooks.example/x" },
      email: null,
      emailAvailable: false,
      webhookSecret: "bonded_as_hook",
    });
    wrap(
      <NotificationSettingsForm subject={{ kind: "preview", id: "p1" }} auth={{ session: "s" }} />,
    );
    expect(await screen.findByText(/Email isn't set up on this deployment/)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    const field = screen.getByLabelText("Webhook URL");
    fireEvent.change(field, { target: { value: "http://hooks.example/x" } });
    expect(screen.getByText("It must start with https://.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    fireEvent.change(field, { target: { value: "https://hooks.example/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        { kind: "preview", id: "p1" },
        { session: "s" },
        { webhookUrl: "https://hooks.example/x" },
      ),
    );
    expect(await screen.findByText("bonded_as_hook")).toBeTruthy();
  });
  it("offers email when the deployment sends it, and turning it off", async () => {
    vi.spyOn(byoaApi, "notifications").mockResolvedValue({
      webhook: null,
      email: "m***@example.com",
      emailAvailable: true,
    });
    const save = vi.spyOn(byoaApi, "saveNotifications").mockResolvedValue({
      webhook: null,
      email: null,
      emailAvailable: true,
    });
    wrap(
      <NotificationSettingsForm
        subject={{ kind: "agent", agentId: "12" }}
        auth={{ session: "s" }}
      />,
    );
    expect(await screen.findByText(/Now: email m\*\*\*@example.com/)).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        webhookUrl: null,
        email: null,
      }),
    );
  });
});

describe("CopyButton", () => {
  it("says Copied, and tells when the clipboard isn't there", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<CopyButton text="npx @bondedhq/runner" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("npx @bondedhq/runner");
    cleanup();
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Select it" })).toBeTruthy();
  });
});

describe("Tabs", () => {
  it("moves with the arrow keys and keeps only the selected tab in the tab order", () => {
    const tabs = [
      { id: "a", label: "ElizaOS" },
      { id: "b", label: "AgentKit" },
      { id: "c", label: "Python" },
    ];
    let selected = "a";
    const { rerender } = render(
      <Tabs label="Framework" tabs={tabs} selected={selected} onSelect={(id) => (selected = id)}>
        panel
      </Tabs>,
    );
    const first = screen.getByRole("tab", { name: "ElizaOS" });
    expect(first.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tab", { name: "AgentKit" }).getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(selected).toBe("c");
    fireEvent.keyDown(first, { key: "End" });
    expect(selected).toBe("c");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(selected).toBe("b");
    rerender(
      <Tabs label="Framework" tabs={tabs} selected="b" onSelect={() => {}}>
        panel
      </Tabs>,
    );
    expect(screen.getByRole("tab", { name: "AgentKit" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tabpanel").textContent).toBe("panel");
  });
});

describe("PreviewReport", () => {
  function Where() {
    const location = useLocation();
    return (
      <p>
        At {location.pathname}
        {location.search} with {JSON.stringify(location.state)}
      </p>
    );
  }
  it("labels the preview, shows the report and makes it official with its choices", async () => {
    const p = preview({
      status: "done",
      ratingId: "run-1",
      agentUrl: verifiedUrl,
      codeHash: { value: `0x${"a".repeat(64)}`, source: "url", detail: "v1.4.2" },
    });
    const client = new QueryClient();
    render(
      <MemoryRouter initialEntries={["/agents/test"]}>
        <QueryClientProvider client={client}>
          <Routes>
            <Route
              path="/agents/test"
              element={<PreviewReport preview={p} run={finishedRun()} />}
            />
            <Route path="/agents/new" element={<Where />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText(PREVIEW_LABEL)).toBeTruthy();
    expect(screen.getByText("72")).toBeTruthy();
    // Both cells are about the episodes that tested the agent, so they never contradict.
    expect(screen.getByText("1 breached of 5")).toBeTruthy();
    expect(screen.getByText("5 of 5")).toBeTruthy();
    expect(screen.getByText("0 of 5")).toBeTruthy();
    expect(screen.getByText("not reached")).toBeTruthy();
    expect(screen.queryByText(/^held /)).toBeNull();
    expect(screen.getByText(/the version your agent reported \(v1.4.2\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make it official" }));
    const where = await screen.findByText(/At \/agents\/new\?preview=p1/);
    expect(where.textContent).toMatch(/"connection":"url"/);
    expect(where.textContent).toMatch(/"agentUrl":"https:\/\/agent.example\/bonded"/);
  });
  it("says plainly when the preview ended without a score", () => {
    wrap(
      <PreviewReport
        preview={preview({ status: "failed", ratingId: "run-1" })}
        run={finishedRun({
          status: "failed",
          report: null,
          error: "stopped: the agent failed in episode 2 of 56",
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(
      /didn't finish with a score.*episode 2 of 56/,
    );
    expect(screen.getByRole("button", { name: "Make it official" })).toBeTruthy();
  });
});
