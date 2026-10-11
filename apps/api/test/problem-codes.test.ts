import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UNKNOWN_PROBLEM, problemCode } from "@bondedhq/shared";

/**
 * Every sentence the API, the workers and the connection check show a builder has a code on
 * the troubleshooting page: the literal sentences in the source are read and each must map to an
 * entry (`PROBLEMS` in @bondedhq/shared). Template values are filled with a number.
 */
// fileURLToPath, not URL.pathname: a checkout whose path has a space ("Fortune Stuff") gets %20.
const src = fileURLToPath(new URL("../src", import.meta.url));
const files = [
  ...readdirSync(src).map((f) => join(src, f)),
  fileURLToPath(new URL("../../arena/src/check.ts", import.meta.url)),
  fileURLToPath(new URL("../../arena/src/gateway/agent-url.ts", import.meta.url)),
].filter((f) => f.endsWith(".ts"));

const PATTERNS = [
  /new Refused\(\s*\d{3},\s*(?:\n\s*)?(["`])((?:(?!\1)[\s\S])*?)\1/g,
  /new RatingRefused\(\s*(?:\n\s*)?(["`])((?:(?!\1)[\s\S])*?)\1/g,
  /(?:problems|warnings)\.push\(\s*(?:\n\s*)?(["`])((?:(?!\1)[\s\S])*?)\1/g,
  /return early\(\s*(?:\n\s*)?(["`])((?:(?!\1)[\s\S])*?)\1/g,
  /problem: (["`])((?:(?!\1)[\s\S])*?)\1/g,
  /c\.json\(\{ error: (["`])((?:(?!\1)[\s\S])*?)\1/g,
];

function sentences(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const pattern of PATTERNS)
      for (const m of source.matchAll(pattern)) {
        const text = m[2]!.replace(/\$\{[^}]*\}/g, "3");
        if (text.length > 8) out.push({ file: file.split("/").slice(-2).join("/"), text });
      }
  }
  return out;
}

describe("the troubleshooting codes", () => {
  it("cover every sentence the services show", () => {
    const all = sentences();
    expect(all.length).toBeGreaterThan(100);
    const unknown = all.filter((s) => problemCode(s.text) === UNKNOWN_PROBLEM);
    expect(unknown).toEqual([]);
  });
});
