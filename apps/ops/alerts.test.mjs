import { describe, expect, it } from "vitest";
import { alertsFor } from "./alerts.mjs";

const row = (name, status, value = "") => ({ group: "G", name, status, value });
const HOUR = 60 * 60 * 1000;

describe("alertsFor", () => {
  it("reports only what's already wrong on the first round", () => {
    const state = new Map();
    expect(
      alertsFor([row("API", "ok", "Up"), row("OpenRouter", "low", "$2.80 left")], state, 0),
    ).toEqual(["⚠️ OpenRouter: Low ($2.80 left)"]);
  });

  it("alerts when a check goes bad, then once when it recovers", () => {
    const state = new Map();
    alertsFor([row("API", "ok", "Up")], state, 0);
    expect(alertsFor([row("API", "down", "Unreachable")], state, HOUR)).toEqual([
      "⚠️ API: Down (Unreachable)",
    ]);
    expect(alertsFor([row("API", "down", "Unreachable")], state, 2 * HOUR)).toEqual([]);
    expect(alertsFor([row("API", "ok", "Up")], state, 3 * HOUR)).toEqual(["✅ API: OK again (Up)"]);
    expect(alertsFor([row("API", "ok", "Up")], state, 4 * HOUR)).toEqual([]);
  });

  it("reminds once a day while a check stays bad", () => {
    const state = new Map();
    alertsFor([row("Gas", "low", "0.002 ETH")], state, 0);
    expect(alertsFor([row("Gas", "low", "0.002 ETH")], state, 23 * HOUR)).toEqual([]);
    expect(alertsFor([row("Gas", "low", "0.001 ETH")], state, 24 * HOUR)).toEqual([
      "⚠️ Gas: Low (0.001 ETH), still",
    ]);
  });

  it("never alerts on the check-by-hand reminders", () => {
    expect(alertsFor([row("Railway", "manual")], new Map(), 0)).toEqual([]);
  });
});
