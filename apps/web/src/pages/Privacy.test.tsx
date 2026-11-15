import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Privacy } from "./Privacy";

afterEach(cleanup);

describe("the privacy page", () => {
  it("says what is kept for how long, and how to ask for deletion", () => {
    render(<Privacy />);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy" })).toBeTruthy();
    expect(screen.getByText("Test traces")).toBeTruthy();
    expect(screen.getByText("30 days, then deleted automatically")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Deleting your data" })).toBeTruthy();
    for (const link of screen.getAllByRole("link", { name: "hello@bondedhq.xyz" }))
      expect(link.getAttribute("href")).toBe("mailto:hello@bondedhq.xyz");
    expect(document.title).toBe("Privacy · Bonded");
  });
});
