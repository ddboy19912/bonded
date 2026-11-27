import { Link, useNavigate } from "react-router";
import { useAccount } from "wagmi";
import { useAgents } from "../lib/chain";
import { bps, short } from "../lib/format";
import {
  AddressLink,
  Badge,
  EmptyState,
  ErrorText,
  LinkButton,
  Loading,
  Page,
  Table,
  Term,
  TierBadge,
  linkClass,
} from "../components/ui";
import { paginate, useListParams } from "../lib/pages";
import { filterAgents, type AgentFilters } from "../lib/lists";
import { Select } from "../components/select";
import { Pagination } from "../components/pagination";
import { TIER_RULES } from "@bondedhq/shared";
import { TEST_AGENT } from "../lib/routes";

type Show = "all" | "rated" | "mine";

export function Agents() {
  const agents = useAgents();
  const navigate = useNavigate();
  const { address } = useAccount();
  // The tab and filters live in the address, so the sidebar's "Agents" and "Your agents" stay
  // in step and a filtered view can be shared.
  const list = useListParams({ mine: "", show: "all", tier: "all", vault: "any", sort: "newest" });
  const show: Show =
    list.values.mine === "1" ? "mine" : list.values.show === "rated" ? "rated" : "all";
  const setShow = (s: Show) =>
    list.set({ mine: s === "mine" ? "1" : "", show: s === "rated" ? "rated" : "all" });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const isMine = (owner: string) =>
    Boolean(address) && owner.toLowerCase() === address!.toLowerCase();
  const all = agents.data ?? [];
  const counts = {
    all: all.length,
    rated: all.filter((a) => a.score).length,
    mine: all.filter((a) => isMine(a.owner)).length,
  };
  const filters: AgentFilters = {
    show,
    tier: list.values.tier,
    vault: list.values.vault as AgentFilters["vault"],
    sort: list.values.sort as AgentFilters["sort"],
  };
  const rows = filterAgents(all, filters, address);
  const page = paginate(rows, list.page, list.size);
  const narrowed = filters.tier !== "all" || filters.vault !== "any";
  const tabs: [Show, string][] = [
    ["all", "All"],
    ["rated", "Rated"],
    ...(address ? ([["mine", "Yours"]] as [Show, string][]) : []),
  ];

  return (
    <Page
      title="Agents"
      eyebrow="Registry"
      intro="Every agent registered on Bonded. Open one to see its scores, attack report, vault and cover."
      actions={
        <>
          <LinkButton to={TEST_AGENT} kind="secondary">
            Test your agent, free
          </LinkButton>
          <LinkButton to="/agents/new">Onboard an agent</LinkButton>
        </>
      }
    >
      <div className="flex flex-col gap-8">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 border-b border-line">
          <div className="-mb-px flex gap-7" role="tablist">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={show === key}
                onClick={() => setShow(key)}
                className={`flex items-baseline gap-2 border-b-2 pb-3.5 text-[17px] font-medium tracking-[-0.02em] transition ${show === key ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
              >
                {label}
                <span className="font-mono text-[12px] font-normal tracking-normal text-muted">
                  {counts[key]}
                </span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 pb-3">
            {narrowed && (
              <button
                type="button"
                onClick={() => list.set({ tier: "all", vault: "any" })}
                className="px-2 font-mono text-xs text-muted hover:text-ink"
              >
                Clear filters
              </button>
            )}
            <Select
              label="Tier"
              value={filters.tier}
              onChange={(v) => list.set({ tier: v })}
              options={[
                { value: "all", label: "All" },
                ...TIER_RULES.map((t) => ({ value: t.tier, label: t.tier })),
                { value: "unrated", label: "Not rated" },
              ]}
            />
            <Select
              label="Vault"
              value={filters.vault}
              onChange={(v) => list.set({ vault: v })}
              options={[
                { value: "any", label: "Any" },
                { value: "with", label: "Has a vault or account" },
                { value: "without", label: "Neither" },
              ]}
            />
            <Select
              label="Sort"
              value={filters.sort}
              onChange={(v) => list.set({ sort: v })}
              options={[
                { value: "newest", label: "Newest" },
                { value: "score", label: "Highest score" },
              ]}
            />
          </div>
        </div>
        {agents.isPending && !agents.error && <Loading what="agents" height="lg" />}
        <ErrorText error={agents.error} />
        {agents.data && rows.length === 0 && (
          <EmptyState
            title={
              narrowed
                ? "No agents match these filters"
                : show === "mine"
                  ? "You haven't onboarded an agent"
                  : "No agents here yet"
            }
            action={
              <div className="flex flex-wrap gap-2.5">
                <LinkButton to={TEST_AGENT} kind="secondary">
                  Test your agent first
                </LinkButton>
                <LinkButton to="/agents/new">Onboard an agent</LinkButton>
              </div>
            }
          >
            Register an agent, give it a vault and a bond, and get it rated. Or see how your own
            agent scores first, with nothing to commit.
          </EmptyState>
        )}
        {rows.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>Agent</th>
                <th className="text-right">Security</th>
                <th>
                  <span>Insurance tier</span>
                </th>
                <th className="hidden md:table-cell">
                  <Term term="expectedLoss">Expected loss</Term>
                </th>
                <th className="hidden sm:table-cell">
                  <Term term="vault">Vault</Term>
                </th>
                <th className="hidden lg:table-cell">Owner</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((a) => (
                <tr
                  key={a.agentId.toString()}
                  className="group cursor-pointer"
                  onClick={() => navigate(`/agents/${a.agentId}`)}
                >
                  <td className="!py-5">
                    <Link
                      to={`/agents/${a.agentId}`}
                      className="text-[clamp(19px,1.8vw,24px)] leading-tight font-medium tracking-[-0.035em] transition group-hover:text-accent"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Agent {a.agentId.toString()}
                    </Link>
                    {isMine(a.owner) && (
                      <span className="ml-3 align-[0.2em]">
                        <Badge tone="brand">yours</Badge>
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    {a.score ? (
                      <span className="text-[clamp(22px,2vw,30px)] leading-none font-medium tracking-[-0.045em] tabular-nums">
                        {a.score.securityScore}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td>
                    {a.score ? (
                      <span className="flex items-center gap-2">
                        <TierBadge score={a.score.score} />
                        {a.score.expiresAt <= now && <Badge tone="warn">expired</Badge>}
                      </span>
                    ) : (
                      <span className="text-muted">Not rated</span>
                    )}
                  </td>
                  <td className="hidden font-mono text-[13px] tabular-nums md:table-cell">
                    {a.score ? bps(a.score.expectedLossBps) : <span className="text-muted">—</span>}
                  </td>
                  <td className="hidden sm:table-cell">
                    {a.vault ? (
                      <Link
                        to={`/vaults/${a.vault}`}
                        className={`font-mono text-[13px] ${linkClass}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {short(a.vault)}
                      </Link>
                    ) : a.protected ? (
                      <span className="text-[13px]">
                        <span className="text-muted">account </span>
                        <span className="font-mono">{short(a.protected.account)}</span>
                      </span>
                    ) : (
                      <span className="text-muted">none</span>
                    )}
                  </td>
                  <td className="hidden lg:table-cell" onClick={(e) => e.stopPropagation()}>
                    <AddressLink address={a.owner} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination
          page={page.page}
          pages={page.pages}
          total={page.total}
          size={list.size}
          onPage={(p) => list.set({ page: p })}
          onSize={(size) => list.set({ size })}
          noun="agents"
        />
      </div>
    </Page>
  );
}
