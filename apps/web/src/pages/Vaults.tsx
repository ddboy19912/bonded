import { Link, useNavigate } from "react-router";
import { useReadContracts } from "wagmi";
import { coverManagerAbi, mandateVaultAbi } from "@bondedhq/shared";
import { deployment } from "../config";
import { useAgents, useVaults } from "../lib/chain";
import { short, usd } from "../lib/format";
import {
  AddressLink,
  Badge,
  Card,
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
import { filterVaults, type VaultFilters, type VaultRow } from "../lib/lists";
import { Select } from "../components/select";
import { Pagination } from "../components/pagination";

export function Vaults() {
  const vaults = useVaults();
  const agents = useAgents();
  const navigate = useNavigate();
  const list = vaults.data ?? [];
  const reads = useReadContracts({
    contracts: list.flatMap((v) => [
      { address: v.vault, abi: mandateVaultAbi, functionName: "totalAssets" as const },
      { address: v.vault, abi: mandateVaultAbi, functionName: "frozen" as const },
      {
        address: deployment.coverManager,
        abi: coverManagerAbi,
        functionName: "activePolicyOf" as const,
        args: [v.vault] as const,
      },
    ]),
    query: { enabled: list.length > 0, refetchInterval: 30_000 },
  });
  const at = (i: number, k: number) => reads.data?.[i * 3 + k]?.result;
  const held = list.reduce((s, _, i) => s + ((at(i, 0) as bigint | undefined) ?? 0n), 0n);
  const covered = list.filter((_, i) => Boolean(at(i, 2))).length;
  const frozen = list.filter((_, i) => at(i, 1) === true).length;
  const listParams = useListParams({ state: "all", sort: "newest" });
  const filters = listParams.values as unknown as VaultFilters;
  const rows: VaultRow[] = list.map((v, i) => ({
    vault: v.vault,
    agentId: v.agentId,
    guardian: v.guardian,
    assets: at(i, 0) as bigint | undefined,
    frozen: at(i, 1) as boolean | undefined,
    covered: Boolean(at(i, 2)),
  }));
  const page = paginate(filterVaults(rows, filters), listParams.page, listParams.size);

  return (
    <Page
      title="Vaults"
      eyebrow="On-chain"
      intro="Each vault holds an agent's funds and enforces its mandate on chain. Its breach log is the record that pays claims."
      actions={<LinkButton to="/agents/new">Onboard an agent</LinkButton>}
    >
      {list.length > 0 && (
        <section
          aria-label="All vaults"
          className="grid gap-x-12 gap-y-8 border-t border-line pt-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
        >
          <div className="min-w-0">
            <p className="eyebrow">Held for depositors</p>
            <p className="mt-4 text-[clamp(56px,7.4vw,112px)] leading-[0.86] font-medium tracking-[-0.065em] tabular-nums">
              {reads.data ? `$${usd(held, 0)}` : <span className="text-dim">…</span>}
            </p>
            <p className="mt-4 max-w-sm text-[15px] text-muted">
              In test tokens, across every vault.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-x-6 self-end">
            {[
              ["Vaults", String(list.length), ""],
              ["Covered", reads.data ? String(covered) : "…", "text-accent"],
              ["Agent frozen", reads.data ? String(frozen) : "…", frozen ? "text-breach" : ""],
            ].map(([label, value, tone]) => (
              <div key={label} className="min-w-0 border-t border-line pt-4">
                <p className="eyebrow">{label}</p>
                <p className={`num-big mt-2.5 ${tone}`}>{value}</p>
              </div>
            ))}
          </div>
        </section>
      )}
      <Card
        title={vaults.data ? `${page.total} ${page.total === 1 ? "vault" : "vaults"}` : "Vaults"}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              label="Show"
              value={filters.state}
              onChange={(v) => listParams.set({ state: v })}
              options={[
                { value: "all", label: "All" },
                { value: "covered", label: "Covered" },
                { value: "uncovered", label: "No cover" },
                { value: "frozen", label: "Agent frozen" },
              ]}
            />
            <Select
              label="Sort"
              value={filters.sort}
              onChange={(v) => listParams.set({ sort: v })}
              options={[
                { value: "newest", label: "Newest" },
                { value: "assets", label: "Most assets" },
              ]}
            />
          </div>
        }
      >
        {vaults.isPending && !vaults.error && <Loading what="vaults" height="md" />}
        <ErrorText error={vaults.error} />
        {vaults.data?.length === 0 && (
          <EmptyState
            title="No vaults yet"
            action={<LinkButton to="/agents/new">Onboard an agent</LinkButton>}
          >
            Each onboarded agent gets a Mandate Vault.
          </EmptyState>
        )}
        {list.length > 0 && page.total === 0 && (
          <EmptyState title="No vaults match these filters">Try another filter.</EmptyState>
        )}
        {page.total > 0 && (
          <>
            <Table>
              <thead>
                <tr>
                  <th>Vault</th>
                  <th>Agent</th>
                  <th className="!pr-10 !text-right">Assets</th>
                  <th>
                    <Term term="cover">Cover</Term>
                  </th>
                  <th>State</th>
                  <th className="hidden lg:table-cell">
                    <Term term="guardian">Guardian</Term>
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((v) => {
                  const score = agents.data?.find((a) => a.agentId === v.agentId)?.score?.score;
                  const assets = v.assets;
                  return (
                    <tr
                      key={v.vault}
                      className="cursor-pointer"
                      onClick={() => navigate(`/vaults/${v.vault}`)}
                    >
                      <td>
                        <Link
                          to={`/vaults/${v.vault}`}
                          className={`font-mono text-[13px] ${linkClass}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {short(v.vault)}
                        </Link>
                      </td>
                      <td>
                        <span className="flex items-center gap-2">
                          <Link
                            to={`/agents/${v.agentId}`}
                            className="text-[17px] font-medium tracking-[-0.02em] whitespace-nowrap hover:text-accent"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Agent {v.agentId.toString()}
                          </Link>
                          {score !== undefined && <TierBadge score={score} />}
                        </span>
                      </td>
                      <td className="pr-10 text-right text-[clamp(19px,1.6vw,22px)] font-medium tracking-[-0.035em] tabular-nums">
                        {assets !== undefined ? `$${usd(assets, 0)}` : "…"}
                      </td>
                      <td>
                        {v.covered ? <Badge tone="brand">Covered</Badge> : <Badge>No cover</Badge>}
                      </td>
                      <td>
                        {v.frozen === true ? (
                          <Badge tone="breach" dot>
                            Frozen
                          </Badge>
                        ) : v.frozen === false ? (
                          <Badge tone="safe" dot>
                            Active
                          </Badge>
                        ) : (
                          "…"
                        )}
                      </td>
                      <td className="hidden lg:table-cell" onClick={(e) => e.stopPropagation()}>
                        <AddressLink address={v.guardian} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <Pagination
              page={page.page}
              pages={page.pages}
              total={page.total}
              size={listParams.size}
              onPage={(p) => listParams.set({ page: p })}
              onSize={(size) => listParams.set({ size })}
              noun="vaults"
            />
          </>
        )}
      </Card>
    </Page>
  );
}
