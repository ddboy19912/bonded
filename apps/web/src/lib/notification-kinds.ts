import { NOTIFICATION_TYPES, type NotificationType } from "@bondedhq/shared";

export type NoticeTone = "safe" | "warn" | "breach";
export type NoticeIconName =
  "check" | "stop" | "clock" | "plug" | "fuel" | "shield" | "claim" | "paid" | "umbrella" | "bell";

export const NOTICE_GROUPS = ["Ratings", "Your agent", "Vault and cover"] as const;
export type NoticeGroup = (typeof NOTICE_GROUPS)[number];

export interface NoticeKind {
  /** A short name for the type, for the list and for the settings. */
  title: string;
  group: NoticeGroup;
  /** How it reads at a glance: good news, something to do, or something that went wrong. */
  tone: NoticeTone;
  icon: NoticeIconName;
}

/** Every notification type, named, grouped and given a colour and an icon. */
export const NOTICE_KINDS: Record<NotificationType, NoticeKind> = {
  rating_finished: { title: "Rating finished", group: "Ratings", tone: "safe", icon: "check" },
  rating_failed: { title: "Rating stopped", group: "Ratings", tone: "warn", icon: "stop" },
  rating_refused: { title: "Rating refused", group: "Ratings", tone: "warn", icon: "stop" },
  score_expiring: { title: "Score expiring", group: "Your agent", tone: "warn", icon: "clock" },
  runner_offline: { title: "Runner offline", group: "Your agent", tone: "warn", icon: "plug" },
  low_gas: { title: "Low on gas", group: "Your agent", tone: "warn", icon: "fuel" },
  breach_recorded: {
    title: "Breach recorded",
    group: "Vault and cover",
    tone: "breach",
    icon: "shield",
  },
  claim_filed: { title: "Claim filed", group: "Vault and cover", tone: "warn", icon: "claim" },
  claim_paid: { title: "Claim paid", group: "Vault and cover", tone: "safe", icon: "paid" },
  cover_lapsing: {
    title: "Cover lapsing",
    group: "Vault and cover",
    tone: "warn",
    icon: "umbrella",
  },
};

const known = (type: string | undefined): type is NotificationType =>
  Boolean(type) && type! in NOTICE_KINDS;

/** A notification's kind, from its settings name (low_gas) or its kebab-case one (low-gas). */
export function noticeKind(item: {
  type?: string | undefined;
  kind?: string;
}): NoticeKind | undefined {
  if (known(item.type)) return NOTICE_KINDS[item.type];
  const snake = item.kind?.replace(/-/g, "_");
  return known(snake) ? NOTICE_KINDS[snake] : undefined;
}

/**
 * The settings, one list per group: each type's short name and the sentence the API describes it
 * with. A type this page doesn't know yet still shows, under "Other", by that sentence.
 */
export function settingGroups(types: readonly string[]) {
  const row = (type: string) => {
    const sentence = NOTIFICATION_TYPES[type as NotificationType];
    return known(type)
      ? { type, title: NOTICE_KINDS[type].title, description: sentence }
      : { type, title: sentence ?? type, description: undefined };
  };
  const groups = NOTICE_GROUPS.map((group) => ({
    group: group as string,
    items: types.filter((t) => known(t) && NOTICE_KINDS[t].group === group).map(row),
  }));
  const other = types.filter((t) => !known(t)).map(row);
  return [...groups, { group: "Other", items: other }].filter((g) => g.items.length > 0);
}

/**
 * Newest-first items split under "Today", "Yesterday", "Earlier this week" and "Older", by the
 * viewer's local days. Order is kept; a heading shows only if something falls under it.
 */
export function dayGroups<T extends { createdAt: string }>(items: readonly T[], now = Date.now()) {
  const day = (ms: number) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  };
  const today = day(now);
  const label = (iso: string) => {
    const age = today - day(Date.parse(iso));
    return age <= 0 ? "Today" : age === 1 ? "Yesterday" : age < 7 ? "Earlier this week" : "Older";
  };
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const l = label(item.createdAt);
    const last = groups.at(-1);
    if (last?.label === l) last.items.push(item);
    else groups.push({ label: l, items: [item] });
  }
  return groups;
}
