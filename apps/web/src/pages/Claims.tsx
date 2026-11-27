import type { ReactNode } from "react";
import { Link } from "react-router";
import { claimPayee, totalPaid, useClaims, useModules, waterfall } from "../lib/chain";
import { short, usd } from "../lib/format";
import { EmptyState, ErrorText, Loading, Page, Term, TxLink, linkClass } from "../components/ui";
import { paginate, useListParams } from "../lib/pages";
import { filterClaims, type ClaimFilters } from "../lib/lists";
import { Select } from "../components/select";
import { Pagination } from "../components/pagination";

export function Claims() {
  const claims = useClaims();
  const modules = useModules().data ?? [];
  const all = claims.data ?? [];
  const listParams = useListParams({ vault: "all", sort: "newest" });
  const filters = listParams.values as ClaimFilters;
  const page = paginate(filterClaims(all, filters), listParams.page, listParams.size);
  const vaults = [...new Set(all.map((c) => c.vault.toLowerCase()))];
  const sum = (f: (w: ReturnType<typeof waterfall>) => bigint) =>
    all.reduce((s, c) => s + f(waterfall(c)), 0n);
  const stat = (label: ReactNode, value: string, hint: string, swatch: string) => (
    <div className="min-w-0 border-t border-line pt-4">
      <p className="eyebrow flex items-center gap-2">
        <span className={`h-2 w-3 shrink-0 rounded-[1px] ${swatch}`} aria-hidden />
        {label}
      </p>
      <p className="num-big mt-2.5">{value}</p>
      <p className="mt-2 text-[13px] text-muted">{hint}</p>
    </div>
  );
  const totals = {
    bond: sum((w) => w.fromBond),
    pool: sum((w) => w.fromPool),
    unpaid: sum((w) => w.unpaid),
  };
  return (
    <Page
      eyebrow="Automatic payouts"
      title="Claims"
      intro="Every payout here was filed and paid by the contracts, with no one filing a form. The operator's bond pays first, then the pool; the first 10% of each loss isn't covered. Payouts go back into the vault, or into the smart account a module protects."
    >
      {claims.data && all.length > 0 && (
        <section aria-label="All claims" className="border-t border-line pt-8">
          <p className="eyebrow">Paid out</p>
          <p className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-2">
            <span className="text-[clamp(56px,7.4vw,112px)] leading-[0.86] font-medium tracking-[-0.065em] tabular-nums">
              ${usd(totalPaid(all), 0)}
            </span>
            <span className="text-[15px] text-muted">
              across {all.length} {all.length === 1 ? "claim" : "claims"}, none filed by hand
            </span>
          </p>
          <FallBar bond={totals.bond} pool={totals.pool} unpaid={totals.unpaid} className="mt-8" />
          <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-3">
            {stat(
              <Term term="bond">From bonds</Term>,
              `$${usd(totals.bond, 0)}`,
              "operators pay first",
              "bg-brand-bright",
            )}
            {stat(
              "From the pool",
              `$${usd(totals.pool, 0)}`,
              "underwriters pay the rest",
              "bg-accent",
            )}
            {stat(
              <Term term="deductible">Not covered</Term>,
              `$${usd(totals.unpaid, 0)}`,
              "deductible and above cover",
              "bg-white/15",
            )}
          </div>
        </section>
      )}
      {claims.isPending && !claims.error && <Loading what="claims" height="md" />}
      <ErrorText error={claims.error} />
      {claims.data?.length === 0 && (
        <EmptyState title="No claims paid yet">
          When a covered vault or smart account records a breach, the claim is filed and paid here
          automatically.
        </EmptyState>
      )}
      <div className="flex flex-col gap-6">
        {all.length > 0 && (
          <div className="flex flex-wrap items-end justify-between gap-4 border-t border-line pt-8">
            <h2 className="h-section">
              {page.total} {page.total === 1 ? "claim" : "claims"}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                label="Vault or account"
                value={filters.vault.toLowerCase()}
                onChange={(v) => listParams.set({ vault: v })}
                options={[
                  { value: "all", label: "All" },
                  ...vaults.map((v) => {
                    const payee = claimPayee({ vault: v as `0x${string}` }, modules);
                    return {
                      value: v,
                      label:
                        payee.kind === "account" ? `Account ${short(payee.address)}` : short(v),
                    };
                  }),
                ]}
              />
              <Select
                label="Sort"
                value={filters.sort}
                onChange={(v) => listParams.set({ sort: v })}
                options={[
                  { value: "newest", label: "Newest" },
                  { value: "amount", label: "Largest payout" },
                ]}
              />
            </div>
          </div>
        )}
        <ul className="flex flex-col">
          {page.items.map((c) => {
            const w = waterfall(c);
            const payee = claimPayee(c, modules);
            const to = payee.kind === "account" ? "the account" : "the vault";
            return (
              <li key={c.txHash} className="border-b border-line py-8 first:pt-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                  <p className="font-mono text-[12px] text-muted">
                    Policy {c.policyId.toString()} ·{" "}
                    {payee.kind === "account" ? (
                      <>
                        smart account{" "}
                        <Link to={`/agents/${payee.agentId}`} className={linkClass}>
                          {short(payee.address)}
                        </Link>
                      </>
                    ) : (
                      <>
                        vault{" "}
                        <Link to={`/vaults/${c.vault}`} className={linkClass}>
                          {short(c.vault)}
                        </Link>
                      </>
                    )}{" "}
                    · breach {c.breachIds.map(String).join(", ")}
                  </p>
                  <span className="font-mono text-[12px] text-muted">
                    Transaction <TxLink hash={c.txHash} />
                  </span>
                </div>
                <p className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-[clamp(40px,5vw,72px)] leading-[0.9] font-medium tracking-[-0.06em] tabular-nums">
                    ${usd(w.toVault)}
                  </span>
                  <span className="text-[15px] text-muted">paid to {to}</span>
                </p>
                <FallBar bond={w.fromBond} pool={w.fromPool} unpaid={w.unpaid} className="mt-6" />
                <dl className="mt-3 flex flex-wrap justify-between gap-x-6 gap-y-2 font-mono text-[12px] text-muted">
                  <div className="flex gap-2">
                    <dt>Loss</dt>
                    <dd className="text-ink tabular-nums">${usd(w.loss)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt>From the bond</dt>
                    <dd className="text-ink tabular-nums">${usd(w.fromBond)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt>From the pool</dt>
                    <dd className="text-ink tabular-nums">${usd(w.fromPool)}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt>Not covered</dt>
                    <dd className="text-ink tabular-nums">${usd(w.unpaid)}</dd>
                  </div>
                </dl>
                {w.premiumNetted > 0n && (
                  <p className="mt-3 text-[13px] text-muted">
                    After ${usd(w.premiumNetted)} of premium {to} still owed.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <Pagination
          page={page.page}
          pages={page.pages}
          total={page.total}
          size={listParams.size}
          onPage={(p) => listParams.set({ page: p })}
          onSize={(size) => listParams.set({ size })}
          noun="claims"
        />
      </div>
    </Page>
  );
}

/**
 * A loss split as one thin bar, as on the landing page: the operator's bond (blue), the cover pool
 * (light blue) and the part not covered (grey). It rises in once.
 */
function FallBar({
  bond,
  pool,
  unpaid,
  className = "",
}: {
  bond: bigint;
  pool: bigint;
  unpaid: bigint;
  className?: string;
}) {
  const part = (v: bigint) => ({ flex: Number(v) || 0.0001 });
  return (
    <div
      className={`flex h-2 animate-[rise-in_0.9s_cubic-bezier(0.19,1,0.22,1)_both] gap-[3px] ${className}`}
      aria-hidden
    >
      <i className="block rounded-[1px] bg-brand-bright" style={part(bond)} />
      <i className="block rounded-[1px] bg-accent" style={part(pool)} />
      <i className="block rounded-[1px] bg-white/15" style={part(unpaid)} />
    </div>
  );
}
