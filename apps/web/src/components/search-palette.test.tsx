import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { SearchPalette } from "./search-palette";

vi.mock("../lib/chain", () => ({
  useAgents: () => ({
    data: [
      {
        agentId: 7n,
        owner: "0xd42fa5ae8949710479954ae78d1b12ff2e50a841",
        score: { score: 80, securityScore: 33, expectedLossBps: 100, issuedAt: 1n, expiresAt: 2n },
        vault: "0x87A10e1E57843fe0B6d1Ba90eeAE9abfd623A161",
      },
    ],
  }),
}));

afterEach(cleanup);

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/overview"]}>
        <SearchPalette />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("search palette", () => {
  it("opens on Cmd K, finds a page by a word it's known by, and Enter goes there", () => {
    show();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const box = screen.getByRole("combobox", { name: "Search" });
    fireEvent.change(box, { target: { value: "insurance" } });
    const results = screen.getByRole("listbox", { name: "Results" });
    expect(within(results).getByRole("option", { name: /Cover pool/ })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/underwrite");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("jumps to an agent by number, and lists its vault by address", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const box = screen.getByRole("combobox", { name: "Search" });
    fireEvent.change(box, { target: { value: "0x87a1" } });
    expect(screen.getByRole("option", { name: /Vault 0x87A1/ })).toBeTruthy();
    fireEvent.change(box, { target: { value: "7" } });
    const go = screen.getByRole("group", { name: "Go to" });
    fireEvent.click(within(go).getByRole("option", { name: /Agent 7/ }));
    expect(screen.getByTestId("where").textContent).toBe("/agents/7");
  });

  it("says so when nothing matches", () => {
    show();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox", { name: "Search" }), {
      target: { value: "zzqx" },
    });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });
});
