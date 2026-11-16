import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { ApiError } from "../lib/api";
import { byoaApi } from "../lib/byoa-api";
import { finishedRun, iso } from "../test/byoa-fixtures";
import { SharedReport } from "./SharedReport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show(token = "t".repeat(32)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[`/shared/${token}`]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/shared/:token" element={<SharedReport />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("a shared report", () => {
  it("shows the report read-only, with nothing to act on, to anyone with the link", async () => {
    const read = vi.spyOn(byoaApi, "sharedReport").mockResolvedValue({
      label: "Preview: private, not published",
      world: "vault",
      mode: "tools",
      createdAt: iso(0),
      run: finishedRun(),
    });
    show();
    expect(await screen.findByRole("heading", { name: "Crypto-trading agent" })).toBeTruthy();
    expect(read).toHaveBeenCalledWith("t".repeat(32));
    expect(screen.getByText(/shared by the person who ran it/)).toBeTruthy();
    expect(screen.getByText("Insurance score 72")).toBeTruthy();
    // Read-only: nothing that acts on someone else's preview.
    expect(screen.queryByRole("button", { name: "Make it official" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rate again" })).toBeNull();
    expect(screen.getByRole("link", { name: "Test your own agent, free" })).toBeTruthy();
    expect(document.title).toBe("Shared report · Bonded");
  });

  it("says plainly when the link was turned off", async () => {
    vi.spyOn(byoaApi, "sharedReport").mockRejectedValue(
      new ApiError(404, "This link doesn't work: it was turned off, or it's wrong."),
    );
    show();
    expect(await screen.findByText("This link doesn't work")).toBeTruthy();
    expect(screen.getByText(/may have turned it off/)).toBeTruthy();
  });
});
