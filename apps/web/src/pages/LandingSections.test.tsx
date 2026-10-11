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
  const open = (name: string) =>
    screen.getByRole("button", { name }).getAttribute("aria-expanded") === "true";

  it("are an accordion: the first is open, and opening another closes it", () => {
    show(<Faq />);
    expect(open("Who decides whether I get paid?")).toBe(true);
    expect(open("What does the red team actually do?")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "What does the red team actually do?" }));
    expect(open("What does the red team actually do?")).toBe(true);
    expect(open("Who decides whether I get paid?")).toBe(false);
    // The open one can be closed again, leaving none open.
    fireEvent.click(screen.getByRole("button", { name: "What does the red team actually do?" }));
    expect(open("What does the red team actually do?")).toBe(false);
    expect(
      screen.getAllByRole("button").filter((b) => b.getAttribute("aria-expanded") === "true"),
    ).toHaveLength(0);
  });

  it("has these questions, in this order, and not the two that were taken out", () => {
    show(<Faq />);
    const questions = screen
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter(Boolean);
    expect(questions).toEqual([
      "Who decides whether I get paid?",
      "Is Bonded only for trading agents?",
      "What does the red team actually do?",
      "What counts as a breach, and what isn't covered?",
      "How fast is a claim paid, and how much?",
      "Can an agent game its score?",
      "Can I test my agent without a vault or tokens?",
      "Which chains does it use?",
    ]);
    expect(questions).not.toContain("Is this real money?");
    expect(questions).not.toContain("Has it been audited?");
    expect(questions).not.toContain("What does cover cost?");
  });

  it("answers whether it is only for trading agents", () => {
    show(<Faq />);
    fireEvent.click(screen.getByRole("button", { name: "Is Bonded only for trading agents?" }));
    expect(screen.getByText(/any AI agent that can move money/)).toBeTruthy();
  });

  it("points at the docs and the security policy", () => {
    show(<Faq />);
    expect(screen.getByRole("link", { name: /Read the docs/ }).getAttribute("href")).toBe("/docs/");
    expect(screen.getByRole("link", { name: /Security policy/ }).getAttribute("href")).toBe(
      "/docs/security/policy/",
    );
  });
});
