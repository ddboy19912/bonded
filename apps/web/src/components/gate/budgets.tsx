import { useQuery } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/shadcn/table";
import { short } from "../../lib/format";
import { dollars, exactDollars, gateApi, type GateAccount, type GateBudget } from "../../lib/gate";

/** Minutes until a budget ends, in a few words: "ends in 42m", "ending". */
export function endsIn(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 60_000) return "ending";
  return `ends in ${Math.ceil(ms / 60_000)}m`;
}

function Spent({ budget }: { budget: GateBudget }) {
  const share = Math.min(1, budget.budgetUsd > 0 ? budget.spentUsd / budget.budgetUsd : 0);
  return (
    <div className="flex min-w-32 flex-col gap-1">
      <span className="text-sm">
        {exactDollars(budget.spentUsd)}{" "}
        <span className="text-muted">of {dollars(budget.budgetUsd)}</span>
      </span>
      <span className="h-1 w-full overflow-hidden rounded-full bg-line" aria-hidden>
        <span className="block h-full rounded-full bg-safe" style={{ width: `${share * 100}%` }} />
      </span>
    </div>
  );
}

/**
 * The account's open budgets (many small payments to one payee, checked once), above the log.
 * Nothing shows while there are none.
 */
export function OpenBudgets({ account, session }: { account: GateAccount; session: string }) {
  const query = useQuery({
    queryKey: ["gate-budgets", account.id],
    queryFn: () => gateApi.budgets(session, account.id, true),
    refetchInterval: 30_000,
  });
  const items = query.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className="mb-6 flex flex-col gap-2" aria-labelledby="open-budgets">
      <h3 id="open-budgets" className="text-sm font-semibold">
        Open budgets
      </h3>
      <p className="text-xs text-muted">
        Each was checked once. The agent's payments to that payee count against it, to the fraction
        of a cent.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Payee</TableHead>
            <TableHead>Spent</TableHead>
            <TableHead className="hidden sm:table-cell">Payments</TableHead>
            <TableHead className="text-right">Time left</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((b) => (
            <TableRow key={b.id}>
              <TableCell>
                <span className="font-medium">{b.vendorId ?? "Not on the list"}</span>
                <span className="block font-mono text-xs text-muted">{short(b.payee, 6)}</span>
              </TableCell>
              <TableCell>
                <Spent budget={b} />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                {b.payments.toLocaleString("en-US")}
                {b.maxPayments !== null && (
                  <span className="text-muted"> of {b.maxPayments.toLocaleString("en-US")}</span>
                )}
              </TableCell>
              <TableCell className="text-right text-sm text-muted">{endsIn(b.expiresAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
