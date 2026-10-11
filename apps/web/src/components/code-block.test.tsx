import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CodeBlock, Rich } from "./code-block";

afterEach(cleanup);

describe("Rich", () => {
  it("shows what is in backticks as inline code, and the rest as it is", () => {
    const { container } = render(
      <p>
        <Rich>{"It writes `src/bonded.ts` and takes `--yes`."}</Rich>
      </p>,
    );
    const code = [...container.querySelectorAll("code")].map((c) => c.textContent);
    expect(code).toEqual(["src/bonded.ts", "--yes"]);
    expect(container.textContent).toBe("It writes src/bonded.ts and takes --yes.");
  });

  it("leaves plain text, and a lone backtick, alone", () => {
    const { container } = render(
      <p>
        <Rich>{"Nothing special here."}</Rich> <Rich>{"One ` only."}</Rich>
      </p>,
    );
    expect(container.querySelectorAll("code")).toHaveLength(0);
    expect(container.textContent).toBe("Nothing special here. One ` only.");
  });
});

describe("CodeBlock", () => {
  it("names the block, says its language and keeps the code itself intact", () => {
    render(
      <CodeBlock
        label="Agent URL handler"
        language="ts"
        code={'import { a } from "@bondedhq/sdk";\nconst b = 1;'}
      />,
    );
    const block = screen.getByLabelText("Agent URL handler");
    expect(block.tagName).toBe("PRE");
    // Framed as in the docs: a header with the name and a copy button in the corner.
    expect(block.closest("figure")?.querySelector("figcaption")?.textContent).toBe(
      "Agent URL handler",
    );
    expect(screen.getByRole("button", { name: /Copy/ })).toBeTruthy();
    expect(block.textContent).toContain('import { a } from "@bondedhq/sdk";');
    expect(block.textContent).toContain("const b = 1;");
  });

  it("colours tokens: keywords, strings and numbers differ from plain text", () => {
    render(<CodeBlock label="x" language="ts" code={'const b = "s" + 1;'} />);
    const colour = (text: string) =>
      [...document.querySelectorAll<HTMLElement>("pre span")].find((s) => s.textContent === text)
        ?.style.color;
    expect(colour("const")).toBeTruthy();
    expect(colour('"s"')).toBeTruthy();
    expect(colour("1")).toBeTruthy();
    expect(new Set([colour("const"), colour('"s"'), colour("1")]).size).toBe(3);
  });

  it("understands a shell command: the command, its flags and its variables", () => {
    render(
      <CodeBlock
        label="Run"
        code={
          "BONDED_RUNNER_TOKEN=abc npx @bondedhq/runner --gateway https://gw.example -- node agent.js"
        }
      />,
    );
    const colour = (text: string) =>
      [...document.querySelectorAll<HTMLElement>("pre span")].find((s) =>
        s.textContent?.trim().startsWith(text),
      )?.style.color;
    expect(colour("npx")).toBeTruthy();
    expect(colour("--gateway")).toBeTruthy();
    expect(colour("BONDED_RUNNER_TOKEN")).toBeTruthy();
    // A flag and a command are not the same colour as the plain arguments.
    expect(colour("npx")).not.toBe(colour("node"));
  });

  it("uses the docs' colours: tan strings, blue commands and flags, green builtins", () => {
    render(<CodeBlock label="x" code={"git clone --recursive https://example.com/x && cd x"} />);
    const colour = (text: string) =>
      [...document.querySelectorAll<HTMLElement>("pre span")].find((s) =>
        s.textContent?.trim().startsWith(text),
      )?.style.color;
    const rgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    expect(colour("git")).toBe(rgb("#82aaff"));
    expect(colour("--recursive")).toBe(rgb("#82aaff"));
    expect(colour("clone")).toBe(rgb("#ecc48d"));
    expect(colour("https://example.com/x")).toBe(rgb("#ecc48d"));
    expect(colour("cd")).toBe(rgb("#addb67"));
  });

  it("wraps a shell command but scrolls code sideways", () => {
    const { rerender } = render(<CodeBlock label="x" code="npx a --b" language="bash" />);
    expect(screen.getByLabelText("x").className).toContain("whitespace-pre-wrap");
    rerender(<CodeBlock label="x" code="const a = 1;" language="ts" />);
    expect(screen.getByLabelText("x").className).toContain("overflow-x-auto");
  });
});
