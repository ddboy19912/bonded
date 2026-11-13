import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { byoaApi, type HostedInfo } from "../lib/byoa-api";
import { CODE_EXAMPLE, ConnectHosted, hostedSummary } from "./connect-hosted";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SAVED: HostedInfo = {
  kind: "code",
  model: "z-ai/glm-5.3-flash",
  language: "ts",
  codeHash: `0x${"cd".repeat(32)}`,
  savedAt: new Date().toISOString(),
};

function show(saved: HostedInfo | null = null) {
  const onChanged = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ConnectHosted previewId="p1" session="sess" saved={saved} onChanged={onChanged} />
    </QueryClientProvider>,
  );
  return { onChanged };
}

describe("Bonded runs it", () => {
  it("saves a code file from the example, then starts the check", async () => {
    const save = vi.spyOn(byoaApi, "saveHostedAgent").mockResolvedValue(SAVED);
    const check = vi.spyOn(byoaApi, "startCheck").mockResolvedValue({ checkId: "k1" });
    const { onChanged } = show();
    fireEvent.click(screen.getByRole("radio", { name: /^Its code/ }));
    // What the file is handed, said plainly before anyone writes one.
    fireEvent.click(screen.getByText("What your file gets"));
    expect(screen.getByText(/No key needed: Bonded pays/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    expect(await screen.findByText("Paste your file, or upload it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start from the example" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("sess", "p1", {
        kind: "code",
        model: "deepseek/deepseek-v4.1-flash",
        language: "js",
        code: CODE_EXAMPLE,
      }),
    );
    await waitFor(() => expect(check).toHaveBeenCalled());
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows the server's reason when a file can't run, and starts no check", async () => {
    vi.spyOn(byoaApi, "saveHostedAgent").mockRejectedValue(
      new ApiError(422, "Your file can't run: SyntaxError: unexpected token at agent.js:3:7."),
    );
    const check = vi.spyOn(byoaApi, "startCheck");
    show();
    fireEvent.click(screen.getByRole("radio", { name: /^Its code/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start from the example" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    expect(await screen.findByText(/SyntaxError: unexpected token at agent.js:3:7/)).toBeTruthy();
    expect(check).not.toHaveBeenCalled();
  });

  it("reads a file you upload, TypeScript by its name", async () => {
    const save = vi.spyOn(byoaApi, "saveHostedAgent").mockResolvedValue(SAVED);
    vi.spyOn(byoaApi, "startCheck").mockResolvedValue({ checkId: "k1" });
    show();
    fireEvent.click(screen.getByRole("radio", { name: /^Its code/ }));
    const file = new File(["export default async () => 'hi';"], "agent.ts", {
      type: "text/plain",
    });
    fireEvent.change(screen.getByLabelText("Upload your agent's file"), {
      target: { files: [file] },
    });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "TypeScript" })).toHaveProperty("checked", true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("sess", "p1", {
        kind: "code",
        model: "deepseek/deepseek-v4.1-flash",
        language: "ts",
        code: "export default async () => 'hi';",
      }),
    );
  });

  it("shows what's saved, and loads it to change it", async () => {
    const stored = vi.spyOn(byoaApi, "hostedAgent").mockResolvedValue({
      kind: "instructions",
      model: "qwen/qwen3.7-flash",
      instructions: "Read the plan first. Trade only what it asks for.",
      codeHash: SAVED.codeHash,
      savedAt: SAVED.savedAt,
    });
    show({ ...SAVED, kind: "instructions", model: "qwen/qwen3.7-flash", language: null });
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("Instructions on Qwen3.7 Flash")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change it" }));
    await waitFor(() => expect(stored).toHaveBeenCalledWith("sess", "p1"));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Your agent's instructions") as HTMLTextAreaElement).value,
      ).toBe("Read the plan first. Trade only what it asks for."),
    );
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("qwen/qwen3.7-flash");
  });

  it("names what is saved in plain words", () => {
    expect(hostedSummary(SAVED)).toBe("A TypeScript file on GLM-5.3 Flash");
    expect(hostedSummary({ ...SAVED, language: "js" })).toBe("A JavaScript file on GLM-5.3 Flash");
  });
});
