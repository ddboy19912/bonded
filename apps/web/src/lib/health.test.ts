import { afterEach, describe, expect, it } from "vitest";
import {
  inboxLines,
  coverTokens,
  gasNotice,
  jobAge,
  markInboxSeen,
  overallStatus,
  scoreLine,
  unreadCount,
  vaultTradingLine,
  type ServiceStatus,
} from "./health";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
afterEach(() => localStorage.clear());

describe("health lines", () => {
  it("says whether the agent trades through its vault", () => {
    expect(vaultTradingLine(null, NOW).tone).toBe("neutral");
    expect(
      vaultTradingLine(
        { firstTradeAt: null, lastTradeAt: null, trades24h: 0, lastTxHash: null },
        NOW,
      ),
    ).toMatchObject({
      tone: "warn",
      text: expect.stringMatching(/No trade through the vault yet/),
    });
    expect(
      vaultTradingLine(
        { firstTradeAt: iso(-9e8), lastTradeAt: iso(-3_600_000), trades24h: 4, lastTxHash: "0x1" },
        NOW,
      ),
    ).toEqual({
      text: "Last trade through the vault 1h ago; 4 trades in the last 24 hours.",
      tone: "safe",
    });
    expect(
      vaultTradingLine(
        {
          firstTradeAt: iso(-9e9),
          lastTradeAt: iso(-8 * 86_400_000),
          trades24h: 0,
          lastTxHash: "0x1",
        },
        NOW,
      ).tone,
    ).toBe("warn");
  });

  it("warns on low gas only when the API says it's low", () => {
    expect(gasNotice({ balance: "1000000000000000", low: false })).toBeUndefined();
    expect(gasNotice({ balance: "200000000000000", low: true, estimatedTradesLeft: 3 })).toBe(
      "Your agent's key is low on gas: it has 0.0002 ETH, and it pays the gas for every trade through the vault. That's enough for about 3 more trades.",
    );
    // The agent's record and vault-activity give balanceWei, and say what the estimate rests on.
    expect(
      gasNotice({
        balanceWei: "200000000000000",
        balanceEth: 0.0002,
        low: true,
        estimatedTradesLeft: 3,
        basis: "assumed",
        gasPerTrade: "350000",
      }),
    ).toMatch(/about 3 more trades \(assuming a typical trade's gas\)\.$/);
  });

  it("reads the score's expiry", () => {
    const s = (days: number, valid = true) => ({
      value: 72,
      tier: "A",
      expiresAt: iso(days * 86_400_000),
      valid,
    });
    expect(scoreLine(null, NOW).text).toBe("Not rated yet");
    expect(scoreLine({ ...s(20), securityScore: 0 }, NOW).text).toBe(
      "Security score 0; insurance score 72 (A), valid for 20 more days",
    );
    expect(scoreLine(s(20), NOW)).toEqual({
      text: "Insurance score 72 (A); security unavailable, valid for 20 more days",
      tone: "safe",
    });
    expect(scoreLine(s(3), NOW)).toEqual({
      text: "Insurance score 72 (A); security unavailable expires in 3 days",
      tone: "warn",
    });
    expect(scoreLine(s(-1, false), NOW).tone).toBe("breach");
    // Still in date, but superseded by a rating the agent stopped.
    expect(scoreLine(s(20, false), NOW)).toEqual({
      text: "Insurance score 72 (A); security unavailable superseded",
      tone: "breach",
    });
    expect(coverTokens("5000000000")).toBe("5,000");
    expect(coverTokens(null)).toBeUndefined();
  });

  it("counts unread notifications by the API's flag, or since the last visit", () => {
    const items = [
      { id: "1", kind: "low-gas", message: "a", createdAt: iso(-1000) },
      { id: "2", kind: "low-gas", message: "b", createdAt: iso(-1e7) },
      { id: "3", kind: "low-gas", message: "c", createdAt: iso(-10), read: true },
    ];
    expect(unreadCount(items, NOW - 60_000)).toBe(1);
    markInboxSeen(NOW);
    expect(unreadCount(items)).toBe(0);
    // The API's own count wins.
    expect(unreadCount({ items, unread: 7, next: null })).toBe(7);
  });

  it("sums the service status up", () => {
    const ok: ServiceStatus = {
      gateway: { up: true },
      lanes: {
        check: { healthy: true, lastJobAgeSeconds: 30 },
        remote: { healthy: true, lastJobAgeSeconds: 600 },
      },
      previewQueue: 0,
      version: "abc",
      checkedAt: iso(0),
    };
    expect(overallStatus(ok, false).label).toBe("All systems normal");
    expect(overallStatus({ ...ok, gateway: { up: false } }, false).tone).toBe("breach");
    // No gateway configured: nothing to ask, so it doesn't count as down.
    expect(overallStatus({ ...ok, gateway: { configured: false, up: null } }, false).tone).toBe(
      "safe",
    );
    expect(
      overallStatus(
        { ...ok, lanes: { ...ok.lanes, remote: { healthy: false, lastJobAgeSeconds: null } } },
        false,
      ).tone,
    ).toBe("warn");
    expect(overallStatus(undefined, true).label).toBe("Status unknown");
    // A stuck job is never "normal", even if a lane still says healthy.
    expect(
      overallStatus(
        { ...ok, lanes: { ...ok.lanes, check: { ...ok.lanes.check, staleRunning: 1 } } },
        false,
      ),
    ).toEqual({ label: "A job looks stuck", tone: "warn" });
    expect(jobAge(null)).toBe("no job yet");
    expect(jobAge(600)).toBe("10 min ago");
  });
});

describe("inboxLines", () => {
  it("starts the title with a capital", () => {
    expect(inboxLines({ message: "your preview rating finished", action: null })).toEqual({
      title: "Your preview rating finished",
    });
  });

  it("uses the full sentence as the title when it only extends the title", () => {
    expect(
      inboxLines({
        message: "your preview rating finished",
        action: "Your preview rating finished with a score of 35 (B).",
      }),
    ).toEqual({ title: "Your preview rating finished with a score of 35 (B)." });
  });

  it("drops a line that only says the title again", () => {
    expect(
      inboxLines({
        message: "The agent key is low on gas.",
        action: "the agent key is low on gas",
      }),
    ).toEqual({ title: "The agent key is low on gas." });
  });

  it("keeps a different line as the detail", () => {
    expect(
      inboxLines({
        message: "The agent key is low on gas.",
        action: "Send the agent key some ETH.",
      }),
    ).toEqual({ title: "The agent key is low on gas.", detail: "Send the agent key some ETH." });
  });
});
