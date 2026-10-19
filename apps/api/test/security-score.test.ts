import { expect, it, vi } from "vitest";
import type { Database } from "@bonded/db";
import { latestScore } from "../src/agent-health.js";
import { emailText } from "../src/notifications.js";

it("keeps the health security grade separate from insurance and leaves legacy grades unknown", async () => {
  const attestation = { score: 95, securityScore: 0, issuedAt: 1790000000, expiresAt: 1792592000 };
  const query = vi
    .fn()
    .mockResolvedValue({ rows: [{ id: "run", a: attestation, tx_hash: "0x123" }] });
  const db = { pool: { query } } as unknown as Database;
  expect(await latestScore(db, "agent")).toMatchObject({
    score: 95,
    securityScore: 0,
    tier: "AAA",
  });
  query.mockResolvedValue({ rows: [{ a: { ...attestation, securityScore: undefined } }] });
  expect(await latestScore(db, "agent")).toMatchObject({ score: 95, securityScore: null });
});

it("labels notification scores without treating insurance as security", () => {
  const notification = {
    type: "rating_finished" as const,
    ratingId: "run",
    agentId: "1",
    chainId: 1,
    status: "done",
    score: 95,
    tier: "AAA",
    at: "2026-10-19T00:00:00Z",
  };
  const current = emailText({ ...notification, securityScore: 0 }).text;
  expect(current).toContain("Bonded Score of 0");
  expect(current).toContain("insurance score 95 (AAA)");
  expect(emailText(notification).text).not.toContain("Bonded Score");
});
