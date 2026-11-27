/**
 * The docs' navigation, read from Starlight's sidebar: each top-level sidebar group is a tab in the
 * header, and the sidebar shows only the group of the tab you are on (as docs.busha.io does).
 */

export interface NavLink {
  type: "link";
  label: string;
  href: string;
  isCurrent: boolean;
  attrs?: Record<string, unknown>;
}
export interface NavGroup {
  type: "group";
  label: string;
  entries: NavEntry[];
  collapsed?: boolean;
}
export type NavEntry = NavLink | NavGroup;

/** Whether an entry is, or holds, the page you are on. */
export function hasCurrent(entry: NavEntry): boolean {
  return entry.type === "link" ? entry.isCurrent : entry.entries.some(hasCurrent);
}

/** The first page an entry leads to: where its tab goes. */
export function firstHref(entry: NavEntry): string | undefined {
  if (entry.type === "link") return entry.href;
  for (const e of entry.entries) {
    const href = firstHref(e);
    if (href) return href;
  }
  return undefined;
}

export interface Tab {
  label: string;
  href: string;
  active: boolean;
  group: NavGroup;
}

/**
 * One tab per top-level group, the one holding the current page marked. A page in no group (the
 * docs home) belongs to the first tab.
 */
export function tabs(sidebar: NavEntry[]): Tab[] {
  const groups = sidebar.filter((e): e is NavGroup => e.type === "group");
  const current = groups.findIndex(hasCurrent);
  return groups.map((group, i) => ({
    label: group.label,
    href: firstHref(group) ?? "/",
    active: i === (current === -1 ? 0 : current),
    group,
  }));
}

/** The labels of the groups leading to the current page, outermost first. */
export function trail(entries: NavEntry[]): string[] {
  for (const e of entries) {
    if (e.type === "group" && hasCurrent(e)) return [e.label, ...trail(e.entries)];
  }
  return [];
}
