import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { byoaApi, type CheckEvent } from "../lib/byoa-api";
import { statusFromPreview } from "../lib/connect";
import { failingEvents, passingEvents, preview, verifiedUrl } from "../test/byoa-fixtures";
import { CheckVerdict, ConnectionCheck } from "./connection-check";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A check whose events the test sends one at a time, as the stream would. */
function liveCheck() {
  let push!: (e: CheckEvent) => void;
  let drop!: (e: Error) => void;
  const close = vi.fn();
  vi.spyOn(byoaApi, "startCheck").mockResolvedValue({ checkId: "chk-9" });
  const events = vi
    .spyOn(byoaApi, "checkEvents")
    .mockImplementation((_id, _session, onEvent, onError) => {
      push = onEvent;
      drop = onError!;
      return close;
    });
  return {
    send: (e: CheckEvent) => act(() => push(e)),
    drop: (e: Error) => act(() => drop(e)),
    close,
    events,
  };
}

function show(over: Parameters<typeof preview>[0] = {}, ready = true) {
  const onFinished = vi.fn();
  const p = preview({ agentUrl: verifiedUrl, ...over });
  render(
    <ConnectionCheck
      subject={{ kind: "preview", id: p.id }}
      auth={{ session: "s" }}
      status={statusFromPreview(p)}
      ready={ready}
      notReadyReason="Verify your URL first."
      onFinished={onFinished}
    />,
  );
  return { onFinished };
}

describe("ConnectionCheck", () => {
  it("can't run until the connection is up, and says why", () => {
    show({ agentUrl: null }, false);
    expect(screen.getByRole("button", { name: "Run the connection check" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("Verify your URL first.")).toBeTruthy();
  });

  it("shows each event as it arrives, then a pass, and refreshes once", async () => {
    const live = liveCheck();
    const { onFinished } = show();
    fireEvent.click(screen.getByRole("button", { name: "Run the connection check" }));
    expect(await screen.findByText("Starting the episode…")).toBeTruthy();
    expect(live.events).toHaveBeenCalledWith(
      "chk-9",
      "s",
      expect.any(Function),
      expect.any(Function),
    );
    live.send(passingEvents[0]!);
    live.send(passingEvents[1]!);
    expect(screen.getByText("Called read_inbox (read messages)")).toBeTruthy();
    expect(screen.getByText("Watching…")).toBeTruthy();
    // While it runs, it can't be started twice.
    expect(screen.getByRole("button", { name: "Run the check again" })).toHaveProperty(
      "disabled",
      true,
    );
    for (const e of passingEvents.slice(2)) live.send(e);
    const verdict = await screen.findByRole("status");
    expect(verdict.textContent).toMatch(/Passed: your agent is connected/);
    expect(verdict.textContent).toMatch(/called 3 tools, read 2 of 9 sources, and did its task/);
    // A pass can still carry advice, and says where the code hash came from.
    expect(verdict.textContent).toMatch(/Worth fixing: It read 2 of 9 surfaces/);
    expect(verdict.textContent).toMatch(
      /Code hash from the git commit of your agent's folder \(3f9c2e1\), reported by the runner/,
    );
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(live.close).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Run the check again" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("explains a failure problem by problem, with the agent's output", async () => {
    const live = liveCheck();
    show();
    fireEvent.click(screen.getByRole("button", { name: "Run the connection check" }));
    await screen.findByText("Starting the episode…");
    for (const e of failingEvents) live.send(e);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/It didn't pass. Fix these, then run the check again/);
    expect(alert.textContent).toMatch(/Your agent never called a tool/);
    expect(alert.textContent).toMatch(/uses the endpoints in the episode/);
    expect(alert.textContent).toMatch(/Run your agent command on its own/);
    expect(screen.getByText("Finished after 1 s, exit code 1")).toBeTruthy();
    expect(screen.getByText(/Its output, as reported/)).toBeTruthy();
    expect(screen.getByText("Error: OPENAI_API_KEY is not set")).toBeTruthy();
  });

  it("reads the check instead when the live stream drops", async () => {
    const live = liveCheck();
    const read = vi.spyOn(byoaApi, "check").mockResolvedValue({
      id: "chk-9",
      status: "passed",
      events: passingEvents,
    });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Run the connection check" }));
    await screen.findByText("Starting the episode…");
    vi.useFakeTimers();
    live.drop(new Error("the live updates stopped"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    vi.useRealTimers();
    expect(read).toHaveBeenCalledWith("chk-9", "s");
    expect((await screen.findByRole("status")).textContent).toMatch(/Passed/);
  });

  it("says when a check can't start, e.g. past its hourly limit", async () => {
    vi.spyOn(byoaApi, "startCheck").mockRejectedValue(
      new ApiError(429, "10 checks an hour per wallet; try again in 40 min"),
    );
    show();
    fireEvent.click(screen.getByRole("button", { name: "Run the connection check" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/10 checks an hour/);
  });

  it("shows the last check's outcome before running again", () => {
    show({
      lastCheck: {
        id: "c0",
        status: "failed",
        createdAt: new Date().toISOString(),
        connection: "url",
        problems: ["Your URL answered 404"],
      },
    });
    expect(screen.getByText(/The last check failed .*Your URL answered 404/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run the check again" })).toBeTruthy();
  });

  it("shows unreported model usage as a note, not as something to fix", () => {
    const result = passingEvents.at(-1) as Extract<CheckEvent, { type: "result" }>;
    render(
      <CheckVerdict
        connection="runner"
        result={{
          ...result,
          warnings: [
            ...result.warnings!,
            "If your agent uses a model, report its usage at /done: without it, a cost estimate gives time only",
          ],
        }}
      />,
    );
    const verdict = screen.getByRole("status");
    expect(verdict.textContent).toMatch(/Worth fixing: It read 2 of 9 surfaces/);
    expect(verdict.textContent).toMatch(/Note: If your agent uses a model, report its usage/);
    expect(verdict.textContent).not.toMatch(/Worth fixing: If your agent uses a model/);
  });
});
