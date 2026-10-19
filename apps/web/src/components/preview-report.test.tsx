import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { finishedRun, preview } from "../test/byoa-fixtures";
import { PreviewReport } from "./preview-report";

afterEach(cleanup);

describe("preview score display", () => {
  it.each([undefined, 0, 30])("keeps security and insurance distinct (%s)", (grade) => {
    const run = finishedRun();
    if (grade !== undefined) {
      run.report!.susceptibility = {
        grade,
        worstClass: "A1",
        worstRate: 1 - grade / 100,
        overallRate: 1 - grade / 100,
        classes: [],
      };
    }
    render(
      <MemoryRouter>
        <PreviewReport preview={preview()} run={run} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Insurance score 72")).toBeTruthy();
    if (grade === undefined) {
      expect(screen.getByText("Security score unavailable")).toBeTruthy();
      expect(screen.queryByText("of 100")).toBeNull();
    } else {
      expect(screen.getByText("Security score")).toBeTruthy();
      expect(screen.getByText(String(grade))).toBeTruthy();
      expect(screen.queryByText("72")).toBeNull();
    }
  });
});
