import { expect, it } from "vitest";
import { originAllowed } from "../src/origins.js";

const allowed = [
  "https://www.bondedhq.xyz",
  "https://bonded-nu.vercel.app",
  "http://localhost:5173",
  "https://bonded-*-team.vercel.app",
];

it("allows exact origins", () => {
  expect(originAllowed("https://www.bondedhq.xyz", allowed)).toBe(true);
  expect(originAllowed("https://bonded-nu.vercel.app", allowed)).toBe(true);
  expect(originAllowed("http://localhost:5173", allowed)).toBe(true);
  expect(originAllowed("http://localhost:5174", allowed)).toBe(false);
});

it("allows the web app's preview deployments through one wildcard", () => {
  expect(originAllowed("https://bonded-git-red-team-page-team.vercel.app", allowed)).toBe(true);
  expect(originAllowed("https://bonded-abc123xyz-team.vercel.app", allowed)).toBe(true);
});

it("never lets the wildcard cross a dot, change the scheme or the rest of the host", () => {
  expect(originAllowed("https://evil.example/bonded-x-team.vercel.app", allowed)).toBe(false);
  expect(originAllowed("https://x.bonded-a-team.vercel.app", allowed)).toBe(false);
  expect(originAllowed("https://bonded-a.b-team.vercel.app", allowed)).toBe(false);
  expect(originAllowed("http://bonded-x-team.vercel.app", allowed)).toBe(false);
  expect(originAllowed("https://bonded--team.vercel.app", allowed)).toBe(false);
  expect(originAllowed("https://bonded-x-team.vercel.app.evil.example", allowed)).toBe(false);
  expect(originAllowed("https://bonded-x-other.vercel.app", allowed)).toBe(false);
});

it("ignores wildcards that aren't https or have more than one star", () => {
  expect(originAllowed("http://a.test", ["http://*.test"])).toBe(false);
  expect(originAllowed("https://a-b.test", ["https://*-*.test"])).toBe(false);
});
