import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { snippets } from "./snippets";

/**
 * Every import the copy-paste snippets show must exist in @bondedhq/sdk, or a builder's first paste
 * fails. Once the SDK's framework helpers are in this repository the test reads the package's
 * own exports map and sources; until then it checks against the list they were written from
 * (Track S, branch ux-sdk at 3574a88).
 */
const SDK_EXPORTS_AT_UX_SDK: Record<string, string[]> = {
  "@bondedhq/sdk": [
    "isBondedEpisode",
    "fromBondedEnv",
    "bondedEpisodeWorld",
    "fromBondedBrokerageEnv",
  ],
  "@bondedhq/sdk/mcp": ["connectEpisodeTools", "mcpConfig", "mcpConfigJson", "finishEpisode"],
  "@bondedhq/sdk/agent-url": ["createBondedHandler", "toNodeHandler"],
  "@bondedhq/sdk/langchain": ["bondedLangChainTools"],
  "@bondedhq/sdk/ai-sdk": ["bondedAiSdkTools"],
  "@bondedhq/sdk/agentkit": ["bondedEpisodeActionProvider"],
  "@bondedhq/sdk/eliza": ["bondedEpisodePlugin", "bondedPlugin"],
};

// Tests run from apps/web (pnpm runs each package's tests in its own folder).
const sdkDir = `${resolve(process.cwd(), process.env.BONDED_SDK_DIR ?? "../../packages/sdk")}/`;

/** The SDK's real exports: subpath to the names its source file exports. Undefined before S lands. */
function realExports(): Record<string, (name: string) => boolean> | undefined {
  const pkg = JSON.parse(readFileSync(`${sdkDir}package.json`, "utf8")) as {
    exports: Record<string, string | { import?: string }>;
  };
  if (!pkg.exports["./langchain"]) return undefined;
  const out: Record<string, (name: string) => boolean> = {};
  for (const [sub, target] of Object.entries(pkg.exports)) {
    const js = typeof target === "string" ? target : target.import;
    if (!js?.endsWith(".js")) continue;
    const src = `${sdkDir}${js.replace("./dist/", "src/").replace(/\.js$/, ".ts")}`;
    if (!existsSync(src)) continue;
    const text = readFileSync(src, "utf8");
    out[sub === "." ? "@bondedhq/sdk" : `@bondedhq/sdk/${sub.slice(2)}`] = (name) =>
      new RegExp(
        `export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`,
      ).test(text);
  }
  return out;
}

describe("snippet imports", () => {
  const real = realExports();
  const all = (["url", "runner"] as const).flatMap((c) => [
    ...(["tools", "chain"] as const).flatMap((m) => snippets(c, m)),
    ...snippets(c, "tools", null, "brokerage"),
  ]);
  it.each(all.flatMap((s) => s.imports.flatMap((i) => i.names.map((n) => [s.label, i.from, n]))))(
    "%s: %s exports %s",
    (_label, from, name) => {
      if (real) {
        expect(real[from], `${from} is in the SDK's exports map`).toBeDefined();
        expect(real[from]!(name)).toBe(true);
      } else expect(SDK_EXPORTS_AT_UX_SDK[from]).toContain(name);
    },
  );
  it("knows whether it checked the real package", () => {
    // Fails loudly if the SDK changed shape so the reader found nothing.
    if (real) expect(Object.keys(real)).toContain("@bondedhq/sdk/agent-url");
    else expect(existsSync(`${sdkDir}package.json`)).toBe(true);
  });
});

describe("stock-trading (brokerage) snippets", () => {
  const url = snippets("url", "tools", null, "brokerage");
  const runner = snippets("runner", "tools", "https://gw.example", "brokerage");
  const code = (list: typeof url) => list.map((s) => s.code).join("\n");

  it("gives an Agent URL handler that takes brokerage episodes", () => {
    // A handler with only onEpisode answers 422 to every brokerage episode.
    expect(url[0]).toMatchObject({ id: "handler" });
    expect(url[0]!.code).toContain("async onBrokerageEpisode(episode");
    expect(code(url)).toContain('"world": "brokerage"');
  });

  it("reads the brokerage episode under the runner, never the vault one", () => {
    expect(code(runner)).toContain("fromBondedBrokerageEnv()");
    expect(code(runner)).toContain("BONDED_WORLD=brokerage");
    // These read a vault episode and throw in a brokerage one.
    for (const vaultOnly of ["fromBondedEnv()", "bonded-mcp-config", "isBondedEpisode()"])
      expect(code([...runner, ...url])).not.toContain(vaultOnly);
    expect(code(runner)).not.toMatch(/bonded(LangChain|AiSdk)Tools\(\)/);
  });

  it("names the package versions it needs", () => {
    for (const s of runner)
      expect(s.note).toMatch(/runner` 0\.1\.4 or later, and `@bondedhq\/sdk` 0\.1\.7 or later if/);
    // An Agent URL agent has no runner: it needs only the SDK.
    for (const s of url.slice(0, 2)) {
      expect(s.note).toMatch(/`@bondedhq\/sdk` 0\.2\.0 or later\.$/);
      expect(s.note).not.toContain("runner");
    }
  });

  it("leaves the crypto-trading snippets as they were", () => {
    expect(snippets("url", "tools")).toEqual(snippets("url", "tools", null, "vault"));
    expect(snippets("url", "tools")[0]!.code).toContain("async onEpisode(episode");
  });
});
