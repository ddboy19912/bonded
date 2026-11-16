import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { ApiError } from "../lib/api";
import { byoaApi } from "../lib/byoa-api";
import { finishedRun } from "../test/byoa-fixtures";
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
      label: "Preview: not published",
      world: "vault",
      mode: "tools",
      // Made one day, rated another: the page says when it ran.
      createdAt: "2026-03-01T12:00:00Z",
      run: finishedRun({ created_at: "2026-03-04T12:00:00Z" }),
    });
    show();
    expect(await screen.findByRole("heading", { name: "Crypto-trading agent" })).toBeTruthy();
    expect(read).toHaveBeenCalledWith("t".repeat(32));
    const ran = new Date("2026-03-04T12:00:00Z").toLocaleDateString(undefined, {
      dateStyle: "medium",
    });
    expect(screen.getByText(/shared by the person who ran it/).textContent).toContain(
      `Ran ${ran}.`,
    );
    expect(screen.getByText("Insurance score 72")).toBeTruthy();
    // Shared, so not "private": the label is the API's, said once.
    expect(screen.getAllByText(/Preview: /).map((e) => e.textContent)).toEqual([
      "Preview: not published",
    ]);
    // Read-only: nothing that acts on someone else's preview.
    expect(screen.queryByRole("button", { name: "Make it official" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rate again" })).toBeNull();
    expect(screen.getByRole("link", { name: "Test your own agent, free" })).toBeTruthy();
    expect(document.title).toBe("Shared report · Bonded");
    // Unlisted: search engines are asked not to index it, only while it's shown.
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "noindex",
    );
    cleanup();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
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
