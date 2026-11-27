import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { useAccount } from "wagmi";
import { isAddress } from "viem";
import { AppLink } from "./components/app-link";
import { HeaderSignIn } from "./components/sign-in";
import { APP_ORIGIN, onAppHost, onSiteHost } from "./lib/hosts";
import { InboxBell } from "./components/inbox-bell";
import { StatusIndicator } from "./components/status-indicator";
import { Logo, buttonClass } from "./components/ui";
import { explorerUrl, networkName } from "./config";
import { useAgents, useClaims } from "./lib/chain";
import { searchTarget } from "./lib/search";
import { isNavActive, isOnChainPath } from "./lib/nav";
import { useOwnCounts } from "./lib/own-counts";
import {
  APP_HOME,
  BLOG_HOME,
  CONTACT_EMAIL,
  DOCS_HOME,
  DOCS_SECURITY,
  PRIVACY,
  TEST_AGENT,
} from "./lib/routes";

/** Stroke icons for the sidebar, drawn on a 24-unit grid. */
const ICONS = {
  overview: "M3 3h8v10H3zM13 3h8v6h-8zM13 11h8v10h-8zM3 15h8v6H3z",
  agents: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  leaderboard: "M4 21h16M7 21V12M12 21V6M17 21v-5",
  index: "M4 19l5-6 4 3 7-9M4 4v15h16",
  arena: "M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0M12 2v5M12 17v5M2 12h5M17 12h5",
  vaults: "M4 5h16v14H4zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M4 9h2M4 15h2",
  mine: "M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8M4 21c0-4 4-6 8-6s8 2 8 6",
  deposits: "M3 7h18v12H3zM16 13h2M6 7l3-3h9l1 3",
  pool: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  claims: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  bounties: "M5 21V4h11l-2 4 2 4H5",
  redteam: "M12 3l8 3v6c0 5-3.5 8-8 9c-4.5-1-8-4-8-9V6zM9 10l6 6M15 10l-6 6",
  sentinel: "M12 3l8 3v6c0 5-3.5 8-8 9c-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5",
  docs: "M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM8 7h8M8 11h6",
  gate: "M3 10l9-6 9 6M5 10v9M19 10v9M9.5 10v9M14.5 10v9M3 20h18",
  test: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7.5 15h9",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 9l2 2 4-4M9 15h6",
  chevron: "M9 6l6 6-6 6",
} as const;

function Icon({ d, className = "size-[18px]" }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

function Count({ n, label }: { n?: number; label?: string }) {
  if (n === undefined) return null;
  return (
    <span
      className="font-mono text-[11px] text-dim"
      aria-label={label ? `${n} ${label}` : undefined}
    >
      {n}
    </span>
  );
}

function Item({
  to,
  icon,
  label,
  extra,
  end,
  except,
}: {
  to: string;
  icon: string;
  label: string;
  extra?: ReactNode;
  end?: boolean;
  /** Child pages with their own link, where this one stays quiet. */
  except?: readonly string[];
}) {
  const { pathname, search } = useLocation();
  const isActive = isNavActive(to, pathname, search, end, except);
  return (
    <Link
      to={to}
      aria-current={isActive ? "page" : undefined}
      className={`relative flex items-center gap-3 px-3 py-2 text-[14px] tracking-[-0.01em] transition ${
        isActive
          ? "text-ink before:absolute before:top-1/2 before:left-0 before:h-4 before:w-[2px] before:-translate-y-1/2 before:bg-brand-bright"
          : "text-muted hover:text-ink"
      }`}
    >
      <Icon d={icon} className={`size-4 ${isActive ? "text-ink" : "text-dim"}`} />
      <span className="flex-1">{label}</span>
      {extra}
    </Link>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <p className="eyebrow mb-1 px-3">{label}</p>
      {children}
    </div>
  );
}

/** The on-chain pages, folded away unless you are on one of them. */
function OnChainGroup({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const here = isOnChainPath(pathname);
  const [open, setOpen] = useState(here);
  useEffect(() => {
    if (here) setOpen(true);
  }, [here]);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="nav-onchain"
        onClick={() => setOpen(!open)}
        className="eyebrow mb-1 flex items-center gap-1.5 px-3 text-left hover:text-ink"
      >
        On-chain
        <Icon
          d={ICONS.chevron}
          className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      <div id="nav-onchain" hidden={!open} className="flex flex-col">
        {children}
      </div>
    </div>
  );
}

/** A wallet's on-chain roles. Signed in by email or passkey, there is nothing here to show. */
function YoursGroup() {
  const { isConnected } = useAccount();
  if (!isConnected) return null;
  return (
    <Group label="Yours">
      <Item to="/agents?mine=1" icon={ICONS.mine} label="Your agents" />
      <Item to="/underwrite?mine=1" icon={ICONS.deposits} label="Your underwriting" />
    </Group>
  );
}

/**
 * The app's sidebar, grouped by what you came to do: protect an agent first, then what is yours,
 * the public benchmarks, and the on-chain pages folded at the bottom. The TESTNET badge shows only
 * on the on-chain pages.
 */
export function Sidebar() {
  const { pathname } = useLocation();
  const agents = useAgents();
  const claims = useClaims();
  const own = useOwnCounts();
  return (
    <div className="flex h-full flex-col gap-7 px-3 py-5">
      <Link to="/" className="flex items-center justify-between px-3" aria-label="Bonded home">
        <Logo className="h-[24px]" />
        {isOnChainPath(pathname) && (
          <span className="font-mono text-[11px] text-muted">Testnet</span>
        )}
      </Link>
      <nav aria-label="App" className="flex flex-col gap-6">
        <div className="flex flex-col">
          <Item to="/overview" icon={ICONS.overview} label="Overview" />
        </div>
        <Group label="Protect">
          <Item
            to={TEST_AGENT}
            icon={ICONS.test}
            label="Test your agent"
            extra={<Count n={own.tests || undefined} label="your tests" />}
          />
          <Item
            to="/gate"
            icon={ICONS.gate}
            label="Payment gate"
            except={["/gate/verify"]}
            extra={<Count n={own.accounts || undefined} label="your gate accounts" />}
          />
          <Item to="/gate/verify" icon={ICONS.receipt} label="Verify a receipt" />
        </Group>
        <YoursGroup />
        <Group label="Benchmarks">
          <Item to="/index" icon={ICONS.index} label="Index" />
          <Item to="/leaderboard" icon={ICONS.leaderboard} label="Leaderboard" />
          <Item
            to="/arena"
            icon={ICONS.arena}
            label="Arena"
            extra={
              <span
                className="size-[6px] rounded-full bg-breach-solid [animation:blink_1.4s_infinite]"
                aria-label="live"
              />
            }
          />
          <Item to="/attacks" icon={ICONS.redteam} label="Red team" />
          <Item to="/sentinel" icon={ICONS.sentinel} label="Sentinel" />
        </Group>
        <OnChainGroup>
          <Item
            to="/agents"
            icon={ICONS.agents}
            label="Agents"
            except={[TEST_AGENT]}
            extra={<Count n={agents.data?.length} />}
          />
          <Item to="/vaults" icon={ICONS.vaults} label="Vaults" />
          <Item
            to="/claims"
            icon={ICONS.claims}
            label="Claims"
            extra={<Count n={claims.data?.length} />}
          />
          <Item to="/underwrite" icon={ICONS.pool} label="Cover pool" />
          <Item to="/bounties" icon={ICONS.bounties} label="Bounties" />
        </OnChainGroup>
      </nav>
      <div className="mt-auto flex flex-col">
        <a
          href={DOCS_HOME}
          className="flex items-center gap-3 px-3 py-2 text-[14px] text-muted hover:text-ink"
        >
          <Icon d={ICONS.docs} className="size-4 text-dim" />
          Docs
        </a>
      </div>
    </div>
  );
}

/** Jump to an agent by ID, a vault by address, or a transaction on the explorer. */
function Search() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [miss, setMiss] = useState(false);
  function go(e: FormEvent) {
    e.preventDefault();
    const target = searchTarget(q, { isAddress, explorerUrl });
    if (!target) return setMiss(true);
    setMiss(false);
    setQ("");
    if (target.external) window.open(target.href, "_blank", "noreferrer");
    else navigate(target.href);
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.getElementById("app-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <form onSubmit={go} role="search" className="min-w-0 flex-1 sm:max-w-md">
      <label className="flex h-11 items-center gap-2.5 rounded-full border border-line bg-white/[0.03] px-4 text-sm text-muted focus-within:border-accent">
        <Icon d="M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0M20 20l-4-4" className="size-4" />
        <input
          id="app-search"
          value={q}
          onChange={(e) => (setQ(e.target.value), setMiss(false))}
          placeholder={
            miss
              ? "Try an agent ID, vault address or tx hash"
              : "Search an agent, vault or transaction"
          }
          aria-label="Search an agent ID, vault address or transaction hash"
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-muted"
          spellCheck={false}
        />
        <kbd className="hidden rounded-md border border-line-strong px-1.5 py-0.5 font-mono text-[11px] sm:block">
          ⌘K
        </kbd>
      </label>
    </form>
  );
}

/** The signed-in app: a sidebar on wide screens, a drawer on phones, and a top bar with the wallet. */
export function AppLayout() {
  const [open, setOpen] = useState(false);
  const { pathname, search, hash } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  // The app lives on app.bondedhq.xyz: a link followed inside the public site lands here.
  if (onSiteHost()) {
    window.location.replace(`${APP_ORIGIN}${pathname}${search}${hash}`);
    return null;
  }
  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-raised focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-screen w-[240px] shrink-0 overflow-y-auto border-r border-line lg:block">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-[280px] overflow-y-auto border-r border-line bg-paper">
            <Sidebar />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-paper/80 backdrop-blur-md">
          <div className="mx-auto flex h-[68px] max-w-[1180px] items-center gap-3 px-4 sm:px-8">
            <button
              type="button"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-line-strong lg:hidden"
              aria-label="Open menu"
              onClick={() => setOpen(true)}
            >
              <Icon d="M3 6h18M3 12h18M3 18h18" className="size-5" />
            </button>
            <Search />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <InboxBell />
              <HeaderSignIn />
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-4 py-8 sm:px-8 sm:py-10">
          <Outlet />
        </main>
        <footer className="border-t border-line px-4 py-5 text-xs text-muted sm:px-8">
          <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3">
            <span>
              {isOnChainPath(pathname) &&
                `${networkName} · test tokens only, nothing here has real value.`}
            </span>
            <div className="flex items-center gap-4">
              <a className="hover:text-ink" href={PRIVACY}>
                Privacy
              </a>
              <a className="hover:text-ink" href={`mailto:${CONTACT_EMAIL}`}>
                Contact
              </a>
              <StatusIndicator />
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** The public site (the landing page): a floating pill nav and a simple footer. */
export function SiteLayout() {
  const { pathname } = useLocation();
  // On app.bondedhq.xyz the home page is the Overview, not the landing page.
  if (onAppHost() && pathname === "/") return <Navigate to="/overview" replace />;
  return (
    <div className="flex min-h-screen flex-col overflow-x-clip">
      <header className="sticky top-0 z-30 border-b border-line bg-paper/75 backdrop-blur-md">
        <div className="flex h-[68px] items-center gap-6 px-[clamp(18px,2.6vw,40px)]">
          <Link to="/" aria-label="Bonded home">
            <Logo className="h-[26px]" />
          </Link>
          <nav
            className="mx-auto hidden items-center gap-7 font-mono text-[13px] text-muted md:flex"
            aria-label="Site"
          >
            <a href="/#try" className="hover:text-ink">
              Try it
            </a>
            <a href="/#how" className="hover:text-ink">
              How it works
            </a>
            <a href="/#index" className="hover:text-ink">
              Index
            </a>
            <a href="/#sentinel" className="hover:text-ink">
              Sentinel
            </a>
            <a href="/#gate" className="hover:text-ink">
              Payment gate
            </a>
          </nav>
          <AppLink to={APP_HOME} className={`${buttonClass("light")} ml-auto md:ml-0`}>
            Launch app <span aria-hidden>→</span>
          </AppLink>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-line px-[clamp(18px,2.6vw,40px)] py-10">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex flex-col items-start gap-3">
            <Logo className="h-9" />
            <p className="max-w-sm text-sm text-muted">
              Don't cage your agent. Bond it. Running on {networkName}, with test tokens only.
            </p>
          </div>
          <div className="flex gap-5 text-sm text-muted">
            <a className="hover:text-ink" href={DOCS_HOME}>
              Docs
            </a>
            <a className="hover:text-ink" href={DOCS_SECURITY}>
              Security
            </a>
            <a className="hover:text-ink" href={BLOG_HOME}>
              Blog
            </a>
            <a className="hover:text-ink" href={PRIVACY}>
              Privacy
            </a>
            <a className="hover:text-ink" href={`mailto:${CONTACT_EMAIL}`}>
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
