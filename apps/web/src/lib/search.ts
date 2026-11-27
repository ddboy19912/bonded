/**
 * Where a search box query should go: an agent by ID, a vault by address, an attack by its id
 * (e.g. A4-honeypot-otc-004), or a tx on the explorer.
 */
export type SearchTarget = { href: string; external: boolean };

export function searchTarget(
  query: string,
  deps: { isAddress: (value: string) => boolean; explorerUrl: string },
): SearchTarget | null {
  const q = query
    .trim()
    .replace(/^#/, "")
    .replace(/^agent\s+/i, "");
  if (/^\d+$/.test(q)) return { href: `/agents/${BigInt(q)}`, external: false };
  if (deps.isAddress(q)) return { href: `/vaults/${q}`, external: false };
  if (/^a(10|[1-9])-[a-z0-9-]+$/i.test(q))
    return {
      href: `/attacks/${q.toUpperCase().slice(0, q.indexOf("-"))}${q.slice(q.indexOf("-")).toLowerCase()}`,
      external: false,
    };
  if (/^0x[0-9a-fA-F]{64}$/.test(q) && deps.explorerUrl)
    return { href: `${deps.explorerUrl}/tx/${q}`, external: true };
  return null;
}

/** What a result is, for its mark and its group. */
export type SearchKind = "go" | "page" | "agent" | "vault" | "model" | "attack";

export interface SearchItem {
  id: string;
  kind: SearchKind;
  title: string;
  /** A line under the title: a score, an owner, a provider. */
  sub?: string;
  href: string;
  external?: boolean;
  /** Other words that find it (an id, an address, a provider). */
  keywords?: string[];
  /** A page's sidebar icon (a key of ICONS in components/nav-icons). */
  icon?: string;
}

/** The groups, in the order they show. */
export const SEARCH_GROUPS: { kind: SearchKind; label: string; max: number }[] = [
  { kind: "go", label: "Go to", max: 1 },
  { kind: "page", label: "Pages", max: 6 },
  { kind: "agent", label: "Agents", max: 5 },
  { kind: "vault", label: "Vaults", max: 4 },
  { kind: "model", label: "Models", max: 5 },
  { kind: "attack", label: "Attacks", max: 5 },
];

/** Every page of the app, with the words people might type for it. */
export const SEARCH_PAGES: SearchItem[] = (
  [
    ["Overview", "/overview", "overview", ["home", "dashboard", "start"]],
    ["Test your agent", "/agents/test", "test", ["preview", "rating", "try", "check"]],
    ["Payment gate", "/gate", "gate", ["gate", "payments", "accounts", "x402"]],
    ["Verify a receipt", "/gate/verify", "receipt", ["receipt", "check", "signature"]],
    ["Index", "/index", "index", ["bonded index", "models", "benchmark", "llm", "charts"]],
    ["Leaderboard", "/leaderboard", "leaderboard", ["ranking", "frameworks", "agents"]],
    ["Arena", "/arena", "arena", ["episodes", "live", "runs"]],
    ["Red team", "/attacks", "redteam", ["attacks", "library", "classes", "injection"]],
    ["Sentinel", "/sentinel", "sentinel", ["guard", "firewall", "model"]],
    ["Agents", "/agents", "agents", ["registry", "on-chain", "insured"]],
    ["Onboard an agent", "/agents/new", "agents", ["register", "new", "official"]],
    ["Vaults", "/vaults", "vaults", ["deposits", "mandate"]],
    ["Claims", "/claims", "claims", ["breach", "payout"]],
    ["Cover pool", "/underwrite", "pool", ["underwrite", "pool", "insurance", "cover"]],
    ["Bounties", "/bounties", "bounties", ["submit", "attack", "reward"]],
    ["Inbox", "/inbox", "deposits", ["notifications", "alerts"]],
    ["Status", "/status", "sentinel", ["uptime", "health", "service"]],
  ] as const
).map(([title, href, icon, keywords]) => ({
  id: `page:${href}`,
  kind: "page" as const,
  title,
  href,
  icon,
  keywords: [...keywords],
}));

/** How well an item matches: its title first, then a word in it, then anything it carries. */
function rank(item: SearchItem, q: string): number {
  const title = item.title.toLowerCase();
  if (title === q) return 5;
  if (title.startsWith(q)) return 4;
  if (title.split(/[\s·,/-]+/).some((w) => w.startsWith(q))) return 3;
  if (title.includes(q)) return 2;
  // Hidden words (addresses, ids, providers) only from 3 characters: "7" shouldn't find every
  // address with a 7 in it.
  if (q.length < 3) return 0;
  const rest = [item.sub ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
  return rest.includes(q) ? 1 : 0;
}

/**
 * The results for a query, grouped and in order: a direct jump first (an agent number, a vault
 * address, an attack id, a transaction), then pages, agents, vaults, models and attacks that match,
 * best first, a few per group. An empty query lists the pages.
 */
export function searchResults(
  query: string,
  items: readonly SearchItem[],
  deps: { isAddress: (value: string) => boolean; explorerUrl: string },
): { kind: SearchKind; label: string; items: SearchItem[] }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ kind: "page", label: "Pages", items: items.filter((i) => i.kind === "page") }];
  const direct = searchTarget(query, deps);
  const all: SearchItem[] = direct
    ? [
        {
          id: `go:${direct.href}`,
          kind: "go",
          ...directLabel(direct, query.trim()),
          href: direct.href,
          external: direct.external,
        },
        ...items,
      ]
    : [...items];
  return SEARCH_GROUPS.map((g) => ({
    kind: g.kind,
    label: g.label,
    items: all
      .filter((i) => i.kind === g.kind)
      .map((i) => ({ i, r: i.kind === "go" ? 9 : rank(i, q) }))
      .filter((x) => x.r > 0)
      .sort((a, b) => b.r - a.r)
      .slice(0, g.max)
      .map((x) => x.i),
  })).filter((g) => g.items.length > 0);
}

/** A direct jump's title and line, from where it goes. */
function directLabel(t: SearchTarget, q: string): { title: string; sub: string } {
  const end = t.href.slice(t.href.lastIndexOf("/") + 1);
  const cut = (v: string) => (v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v);
  if (t.external) return { title: "Transaction on the explorer", sub: cut(q) };
  if (t.href.startsWith("/agents/"))
    return { title: `Agent ${end}`, sub: "Its rating, report and proof" };
  if (t.href.startsWith("/vaults/"))
    return { title: `Vault ${cut(end)}`, sub: "Its funds, mandate and cover" };
  return { title: end, sub: "A published attack" };
}
