import { existsSync } from "node:fs";
import { getCodeBlock } from "../test/code";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { BringYourAgent, Faq, Roles, ScoreScale, WorksWith } from "./LandingSections";

afterEach(cleanup);
const show = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../../public");

describe("the works-with carousel", () => {
  it("names each integration once for assistive technology, though the row is shown twice", () => {
    show(<WorksWith />);
    const names = screen.getAllByRole("img").map((i) => i.getAttribute("aria-label"));
    expect(names).toHaveLength(11);
    expect(new Set(names).size).toBe(11);
    expect(names).toEqual(
      expect.arrayContaining(["ElizaOS", "Coinbase AgentKit", "Robinhood Chain", "Solana", "Safe"]),
    );
    // The copy that makes the loop seamless is hidden from them.
    expect(document.querySelectorAll(".logo-copy")).toHaveLength(2);
    expect(document.querySelector('.logo-copy[aria-hidden="true"]')).toBeTruthy();
  });

  it("only points at logo files that exist", () => {
    show(<WorksWith />);
    for (const el of document.querySelectorAll<HTMLElement>('[role="img"]')) {
      const url = /url\(["']?([^"')]+)/.exec(el.getAttribute("style") ?? "")?.[1];
      expect(url, el.getAttribute("aria-label") ?? "").toBeTruthy();
      expect(existsSync(join(publicDir, url!)), url).toBe(true);
    }
  });
});

describe("who it is for", () => {
  it("sends each reader to the right place", () => {
    show(<Roles />);
    expect(screen.getByRole("link", { name: "Test your agent, free" }).getAttribute("href")).toBe(
      "/agents/test",
    );
    expect(screen.getByRole("link", { name: "Onboard an agent" }).getAttribute("href")).toBe(
      "/agents/new",
    );
    expect(screen.getByRole("link", { name: /Browse vaults/ }).getAttribute("href")).toBe(
      "/vaults",
    );
    expect(screen.getByRole("link", { name: /Underwrite the pool/ }).getAttribute("href")).toBe(
      "/underwrite",
    );
  });
});

describe("the score scale", () => {
  it("shows every tier with its range and the bond it needs, from the contracts' own rules", () => {
    show(<ScoreScale />);
    const tiers = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(tiers.map((t) => t.textContent)).toEqual([
      "AAA90 to 100Bond of at least 10% of the cover",
      "AA80 to 89Bond of at least 10% of the cover",
      "A70 to 79Bond of at least 10% of the cover",
      "BBB60 to 69Bond of at least 10% of the cover",
      "BB45 to 59Bond of at least 20% of the cover",
      "B25 to 44Bond of at least 30% of the cover",
      "CCC0 to 24Not insurable",
    ]);
  });
});

describe("bringing an agent", () => {
  it("gives the one command and lists every framework", () => {
    show(<BringYourAgent />);
    expect(getCodeBlock("npx @bondedhq/runner init")).toBeTruthy();
    for (const name of ["ElizaOS", "Coinbase AgentKit", "LangChain or LangGraph", "Python"])
      expect(screen.getByText(name)).toBeTruthy();
  });
});

describe("the questions", () => {
  it("are closed until opened, and say the money is test money", () => {
    show(<Faq />);
    const q = screen.getByRole("button", { name: "Is this real money?" });
    expect(q.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(q);
    expect(q.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/test tokens only/)).toBeTruthy();
  });

  it("is honest that the audit is in-house", () => {
    show(<Faq />);
    expect(screen.getByText(/in-house review, not an external audit/)).toBeTruthy();
  });
});
