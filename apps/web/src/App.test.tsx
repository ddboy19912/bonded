import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./App";
import { byoaApi } from "./lib/byoa-api";
import { gateApi } from "./lib/gate";

const state = vi.hoisted(() => ({
  address: undefined as string | undefined,
  session: undefined as { session: string } | undefined,
}));
vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useAccount: () => ({ address: state.address, isConnected: Boolean(state.address) }),
}));
vi.mock("./lib/owner-session", () => ({
  useOwnerSession: () => ({ session: state.session }),
}));
vi.mock("./lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/chain")>()),
  useAgents: () => ({ data: [] }),
  useClaims: () => ({ data: [] }),
}));

function show(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const groups = () => [...document.querySelectorAll("nav .eyebrow")].map((g) => g.textContent);
const link = (name: string) => screen.getByRole("link", { name: new RegExp(`^${name}`) });

describe("the app sidebar", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    state.address = undefined;
    state.session = undefined;
  });

  it("leads with protecting an agent, then benchmarks, with the on-chain pages folded", () => {
    show("/overview");
    expect(groups()).toEqual(["Protect", "Benchmarks", "On-chain"]);
    expect(link("Test your agent").getAttribute("href")).toBe("/agents/test");
    expect(link("Payment gate").getAttribute("href")).toBe("/gate");
    expect(link("Verify a receipt").getAttribute("href")).toBe("/gate/verify");
    // Folded: the on-chain links are hidden until opened.
    expect(screen.queryByRole("link", { name: /^Vaults/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /On-chain/ }));
    expect(link("Vaults")).toBeTruthy();
  });

  it("opens the on-chain group on an on-chain page, with no Testnet badge in the sidebar", () => {
    show("/vaults");
    expect(screen.getByRole("button", { name: /On-chain/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.queryByText("Testnet")).toBeNull();
    cleanup();
    for (const path of ["/overview", "/agents/test", "/gate", "/index"]) {
      show(path);
      expect(screen.queryByText("Testnet"), path).toBeNull();
      cleanup();
    }
  });

  it("marks only the most specific link", () => {
    show("/agents/test");
    expect(link("Test your agent").getAttribute("aria-current")).toBe("page");
    cleanup();
    show("/gate/verify");
    expect(link("Verify a receipt").getAttribute("aria-current")).toBe("page");
    expect(link("Payment gate").getAttribute("aria-current")).toBeNull();
  });

  it("never asks an email or passkey user for a wallet, and counts their tests and gate accounts", async () => {
    state.session = { session: "s1" };
    vi.spyOn(byoaApi, "listPreviews").mockResolvedValue({ items: [], total: 3 });
    vi.spyOn(gateApi, "accounts").mockResolvedValue({ items: [{} as never] });
    show("/overview");
    expect(screen.queryByText(/wallet/i)).toBeNull();
    expect(groups()).not.toContain("Yours");
    await waitFor(() => expect(screen.getByLabelText("3 your tests")).toBeTruthy());
    expect(screen.getByLabelText("1 your gate accounts")).toBeTruthy();
  });

  it("asks nothing of the API when no one is signed in", () => {
    const list = vi.spyOn(byoaApi, "listPreviews");
    const accounts = vi.spyOn(gateApi, "accounts");
    show("/overview");
    expect(list).not.toHaveBeenCalled();
    expect(accounts).not.toHaveBeenCalled();
    expect(screen.queryByText(/wallet/i)).toBeNull();
  });

  it("shows a wallet's on-chain roles under Yours", () => {
    state.address = "0x00000000000000000000000000000000000000a1";
    show("/overview");
    expect(groups()).toEqual(["Protect", "Yours", "Benchmarks", "On-chain"]);
    expect(link("Your agents").getAttribute("href")).toBe("/agents?mine=1");
  });
});
