import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CopyBlock } from "./copy";

afterEach(cleanup);

it("shows a short note under the command", () => {
  render(<CopyBlock label="Install" text="npm i x" note="Run it in your agent's folder." />);
  expect(screen.getByText("Run it in your agent's folder.").closest("details")).toBeNull();
  expect(screen.queryByText("What this does")).toBeNull();
});

it("folds a long note away until it's asked for", () => {
  const note = "It finds your framework and changes one line. ".repeat(6);
  render(<CopyBlock label="Install" text="npm i x" note={note} />);
  const summary = screen.getByText("What this does");
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(details.textContent).toContain("It finds your framework");
});

it("leaves a note that is markup alone", () => {
  render(
    <CopyBlock
      label="Run"
      text="x"
      note={
        <>
          Replace <code>x</code> first.
        </>
      }
    />,
  );
  expect(screen.queryByText("What this does")).toBeNull();
});
