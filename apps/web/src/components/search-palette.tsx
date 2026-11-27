import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { isAddress } from "viem";
import {
  ArrowUpRight,
  CornerDownLeft,
  FileText,
  Hash,
  Search,
  ShieldAlert,
  Vault,
} from "lucide-react";
import { explorerUrl } from "../config";
import { api } from "../lib/api";
import { useAgents } from "../lib/chain";
import { short } from "../lib/format";
import { loadBondedIndex, modelPath } from "../lib/bonded-index";
import { PROVIDER_LOGOS } from "../lib/provider-logos";
import { ICONS, Icon } from "./nav-icons";
import { SEARCH_PAGES, searchResults, type SearchItem, type SearchKind } from "../lib/search";

/** Is this a Mac, for the shortcut's label. */
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Search for the whole app, in the header: a field-like button that opens a palette (also on ⌘K or
 * Ctrl K, and "/"). Type to find a page, an agent, a vault, a model on the Index or a published
 * attack; paste an agent number, a vault address, an attack id or a transaction hash to jump to it.
 * Arrows move, Enter opens, Esc closes.
 */
export function SearchPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing =
        t instanceof Element && t.closest("input, textarea, select, [contenteditable]");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Search"
          className="group flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-full px-4 text-left text-sm text-muted shadow-[inset_0_0_0_1px_var(--color-line)] transition hover:bg-white/[0.03] hover:text-soft hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)] sm:max-w-md"
        >
          <Search aria-hidden className="size-4 shrink-0" strokeWidth={2} />
          <span className="min-w-0 flex-1 truncate">Search pages, agents, models…</span>
          <kbd className="hidden rounded-md px-1.5 py-0.5 font-mono text-[11px] shadow-[inset_0_0_0_1px_var(--color-line-strong)] sm:block">
            {mac ? "⌘" : "Ctrl "}K
          </kbd>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] [animation:fade_.15s_ease_both]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="pop fixed top-[12vh] left-1/2 z-50 flex max-h-[72vh] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden outline-none"
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          {open && <Palette onClose={() => setOpen(false)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const agents = useAgents();
  // The published attacks, once someone starts typing (one request; the library is under 100).
  const attacks = useQuery({
    queryKey: ["search-attacks"],
    queryFn: () => api.attacks({ limit: 100 }),
    enabled: query.trim().length > 1,
    staleTime: 5 * 60_000,
  });
  const models = useMemo(() => {
    try {
      return loadBondedIndex().entries;
    } catch {
      return [];
    }
  }, []);

  const items = useMemo<SearchItem[]>(() => {
    const rows = agents.data ?? [];
    return [
      ...SEARCH_PAGES,
      ...rows.map((a) => ({
        id: `agent:${a.agentId}`,
        kind: "agent" as const,
        title: `Agent ${a.agentId}`,
        sub: a.score
          ? `Security ${a.score.securityScore} · owner ${short(a.owner)}`
          : `Not rated · owner ${short(a.owner)}`,
        href: `/agents/${a.agentId}`,
        keywords: [`#${a.agentId}`, a.owner.toLowerCase()],
      })),
      ...rows
        .filter((a) => a.vault)
        .map((a) => ({
          id: `vault:${a.vault}`,
          kind: "vault" as const,
          title: `Vault ${short(a.vault!)}`,
          sub: `Agent ${a.agentId}`,
          href: `/vaults/${a.vault}`,
          keywords: [a.vault!.toLowerCase(), `agent ${a.agentId}`],
        })),
      ...models.map((e) => ({
        id: `model:${e.model}`,
        kind: "model" as const,
        title: e.label,
        sub: `${e.provider} · on the Index`,
        href: modelPath(e),
        keywords: [e.model, e.provider],
      })),
      ...(attacks.data?.items ?? []).map((a) => ({
        id: `attack:${a.id}`,
        kind: "attack" as const,
        title: a.title,
        sub: `${a.id} · ${a.severity}`,
        href: `/attacks/${a.id}`,
        keywords: [a.id, a.class, ...a.tags],
      })),
    ];
  }, [agents.data, attacks.data, models]);

  const groups = useMemo(
    () => searchResults(query, items, { isAddress, explorerUrl }),
    [query, items],
  );
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const open = (item: SearchItem | undefined) => {
    if (!item) return;
    onClose();
    if (item.external) window.open(item.href, "_blank", "noreferrer");
    else navigate(item.href);
  };
  const providerOf = (item: SearchItem) =>
    item.kind === "model" ? item.sub?.split(" · ")[0] : undefined;

  let index = -1;
  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-5">
        <Search aria-hidden className="size-[18px] shrink-0 text-muted" strokeWidth={2} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, flat.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              open(flat[active]);
            }
          }}
          placeholder="Search, or paste an agent number, address or tx hash"
          aria-label="Search"
          role="combobox"
          aria-expanded
          aria-controls="search-results"
          aria-activedescendant={flat[active] ? `search-${flat[active].id}` : undefined}
          spellCheck={false}
          autoComplete="off"
          className="h-16 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-dim"
        />
        <kbd className="rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted shadow-[inset_0_0_0_1px_var(--color-line-strong)]">
          esc
        </kbd>
      </div>

      <div
        ref={list}
        id="search-results"
        role="listbox"
        aria-label="Results"
        className="min-h-0 flex-1 overflow-y-auto p-2"
      >
        {groups.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-[15px] text-soft">Nothing matches “{query.trim()}”</p>
            <p className="mt-1.5 text-[13px] text-muted">
              Try a page, a model, an agent number, a vault address or a transaction hash.
            </p>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.kind} role="group" aria-label={g.label} className="pb-2">
              <p className="eyebrow px-3 pt-3 pb-2">{g.label}</p>
              {g.items.map((item) => {
                index += 1;
                const i = index;
                const on = i === active;
                return (
                  <div
                    key={item.id}
                    id={`search-${item.id}`}
                    role="option"
                    aria-selected={on}
                    data-index={i}
                    onMouseMove={() => setActive(i)}
                    onClick={() => open(item)}
                    className={`flex cursor-pointer items-center gap-3.5 rounded-xl px-3 py-2.5 transition-colors ${on ? "bg-white/[0.07]" : ""}`}
                  >
                    <Mark kind={item.kind} provider={providerOf(item)} icon={item.icon} on={on} />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[14.5px] ${on ? "text-ink" : "text-soft"}`}
                      >
                        {item.title}
                      </span>
                      {item.sub && (
                        <span className="mt-0.5 block truncate font-mono text-[11.5px] text-muted">
                          {item.sub}
                        </span>
                      )}
                    </span>
                    {on &&
                      (item.external ? (
                        <ArrowUpRight aria-hidden className="size-4 shrink-0 text-muted" />
                      ) : (
                        <CornerDownLeft aria-hidden className="size-4 shrink-0 text-muted" />
                      ))}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <div className="hidden items-center gap-5 border-t border-line px-5 py-3 font-mono text-[11px] text-muted sm:flex">
        <Hint keys={["↑", "↓"]}>to move</Hint>
        <Hint keys={["↵"]}>to open</Hint>
        <Hint keys={["esc"]}>to close</Hint>
      </div>
    </>
  );
}

function Hint({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {keys.map((k) => (
        <kbd
          key={k}
          className="grid h-5 min-w-5 place-items-center rounded px-1 shadow-[inset_0_0_0_1px_var(--color-line-strong)]"
        >
          {k}
        </kbd>
      ))}
      {children}
    </span>
  );
}

/** A result's mark: the provider's logo for a model, the sidebar's icon for a page, else an icon
 * for its kind. */
function Mark({
  kind,
  provider,
  icon,
  on,
}: {
  kind: SearchKind;
  provider?: string | undefined;
  icon?: string | undefined;
  on: boolean;
}) {
  const logo = provider ? PROVIDER_LOGOS[provider] : undefined;
  const box = `grid size-9 shrink-0 place-items-center rounded-lg transition-colors ${on ? "bg-white/[0.1] text-ink" : "bg-white/[0.05] text-muted"}`;
  if (logo)
    return (
      <span aria-hidden className={`${box} bg-white!`}>
        <img src={logo} alt="" className="size-4" />
      </span>
    );
  const path = icon && icon in ICONS ? ICONS[icon as keyof typeof ICONS] : undefined;
  return (
    <span aria-hidden className={box}>
      {path ? (
        <Icon d={path} className="size-4" />
      ) : kind === "vault" ? (
        <Vault className="size-4" strokeWidth={1.75} />
      ) : kind === "attack" ? (
        <ShieldAlert className="size-4" strokeWidth={1.75} />
      ) : kind === "agent" ? (
        <Icon d={ICONS.agents} className="size-4" />
      ) : kind === "model" ? (
        <FileText className="size-4" strokeWidth={1.75} />
      ) : (
        <Hash className="size-4" strokeWidth={1.75} />
      )}
    </span>
  );
}
