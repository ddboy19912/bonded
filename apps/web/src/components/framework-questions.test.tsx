import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FRAMEWORKS, FRAMEWORK_TEXT, HOSTING_HINT, rememberedFramework } from "../lib/frameworks";
import { FrameworkQuestions } from "./framework-questions";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** The radio whose name contains this text (titles have brackets, so not a pattern). */
const radio = (text: string) => screen.getByRole("radio", { name: (name) => name.includes(text) });

// One flow, two layouts: whatever one does, the other does too.
describe.each([
  ["flat", true],
  ["boxed", false],
])("the framework questions, %s", (_name, flat) => {
  const show = (props: Partial<Parameters<typeof FrameworkQuestions>[0]> = {}) => {
    const onFramework = vi.fn();
    const onHosting = vi.fn();
    render(
      <FrameworkQuestions
        flat={flat}
        framework={undefined}
        hosting="online"
        onFramework={onFramework}
        onHosting={onHosting}
        {...props}
      />,
    );
    return { onFramework, onHosting };
  };

  it("asks both questions, with every framework and both places it can run", () => {
    show();
    expect(screen.getByText("Which framework is your agent built on?")).toBeTruthy();
    expect(screen.getByText("Where do you run it?")).toBeTruthy();
    for (const f of FRAMEWORKS) expect(radio(FRAMEWORK_TEXT[f].title)).toBeTruthy();
    expect(screen.getByRole("radio", { name: /On my computer or server/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /It's online at a URL/ })).toBeTruthy();
    expect(screen.getByText(HOSTING_HINT)).toBeTruthy();
  });

  it("answers the framework, and remembers it for next time", () => {
    const { onFramework } = show();
    fireEvent.click(radio(FRAMEWORK_TEXT.python.title));
    expect(onFramework).toHaveBeenCalledWith("python");
    expect(rememberedFramework()).toBe("python");
  });

  it("answers where it runs, and marks the current answer", () => {
    const { onHosting } = show({ hosting: "online" });
    expect(screen.getByRole("radio", { name: /It's online at a URL/ })).toHaveProperty(
      "checked",
      true,
    );
    fireEvent.click(screen.getByRole("radio", { name: /On my computer or server/ }));
    expect(onHosting).toHaveBeenCalledWith("machine");
  });

  it("keeps the advanced options behind a toggle, closed until asked for, and tells the parent", () => {
    const onAdvancedToggle = vi.fn();
    show({ advanced: <p>Mode and code hash</p>, onAdvancedToggle });
    const toggle = screen.getByRole("button", { name: "Advanced (optional)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(onAdvancedToggle).toHaveBeenCalledWith(true);
    expect(screen.getByText("Mode and code hash")).toBeTruthy();
  });

  it("has no advanced toggle when there are no advanced options", () => {
    show();
    expect(screen.queryByRole("button", { name: "Advanced (optional)" })).toBeNull();
  });
});
