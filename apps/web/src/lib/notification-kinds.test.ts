import { NOTIFICATION_TYPE_LIST } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { NOTICE_KINDS, dayGroups, noticeKind, settingGroups } from "./notification-kinds";

describe("notice kinds", () => {
  it("names every notification type the API can send", () => {
    expect(Object.keys(NOTICE_KINDS).sort()).toEqual([...NOTIFICATION_TYPE_LIST].sort());
  });

  it("finds a kind from its settings name or its kebab-case one", () => {
    expect(noticeKind({ type: "low_gas" })?.title).toBe("Low on gas");
    expect(noticeKind({ kind: "claim-paid" })?.tone).toBe("safe");
    expect(noticeKind({ kind: "something-new" })).toBeUndefined();
  });
});

describe("settingGroups", () => {
  it("groups the types it knows, keeping the API's order inside a group", () => {
    const groups = settingGroups(["claim_paid", "rating_finished", "low_gas", "breach_recorded"]);
    expect(groups.map((g) => g.group)).toEqual(["Ratings", "Your agent", "Vault and cover"]);
    expect(groups[2]!.items.map((i) => i.title)).toEqual(["Claim paid", "Breach recorded"]);
    expect(groups[0]!.items[0]!.description).toBe("A rating or preview finished.");
  });

  it("still lists a type it doesn't know, by its sentence, under Other", () => {
    const groups = settingGroups(["low_gas", "future_type"]);
    expect(groups.at(-1)).toEqual({
      group: "Other",
      items: [{ type: "future_type", title: "future_type", description: undefined }],
    });
  });
});

describe("dayGroups", () => {
  const now = new Date(2026, 9, 11, 15, 0).getTime();
  const at = (days: number, hour = 9) => new Date(2026, 9, 11 - days, hour).toISOString();

  it("splits newest-first items under local days, and skips empty headings", () => {
    const items = [
      { id: "a", createdAt: at(0, 14) },
      { id: "b", createdAt: at(0, 1) },
      { id: "c", createdAt: at(1) },
      { id: "d", createdAt: at(4) },
      { id: "e", createdAt: at(30) },
    ];
    expect(dayGroups(items, now).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      ["Earlier this week", ["d"]],
      ["Older", ["e"]],
    ]);
    expect(dayGroups([{ createdAt: at(30) }], now).map((g) => g.label)).toEqual(["Older"]);
    expect(dayGroups([], now)).toEqual([]);
  });
});
