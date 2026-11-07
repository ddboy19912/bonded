import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ChevronRightIcon, ListFilterIcon } from "lucide-react";
import { GATE_RULES, GATE_RULE_WORDS } from "@bondedhq/shared";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/shadcn/empty";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/shadcn/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/shadcn/table";
import { Spinner } from "@/components/shadcn/spinner";
import { ago, short } from "../../lib/format";
import {
  dollars,
  gateApi,
  type GateAccount,
  type GateActivityEntry,
  type GateActivityFilters,
  type GateDecision,
  type GateWatchedPayment,
} from "../../lib/gate";
import { ResponsiveModal } from "../responsive-modal";
import { ErrorText, Loading, Unavailable, linkClass } from "../ui";
import { ChainLogo, Facts, HashText, SelectField } from "./common";
import { VerifyPanel, type ChainRoot } from "./verification";

export const RESULT: Record<
  GateDecision["result"],
  { label: string; tone: "safe" | "breach" | "warn" }
> = {
  allowed: { label: "Allowed", tone: "safe" },
  blocked: { label: "Blocked", tone: "breach" },
  refused: { label: "Refused", tone: "warn" },
};

const headline = (d: GateDecision) =>
  d.kind === "bank_change"
    ? `Bank change for ${d.vendorId}`
    : `${d.kind === "refund" ? "Refund" : "Payment"} of ${dollars(d.amountUsd)}`;

/** One check in the log. Pressing it opens the decision, its receipt and the checks to run on it. */
function DecisionRow({
  decision,
  rail,
  account,
  session,
  chainRoot,
}: {
  decision: GateDecision;
  rail: string;
  account: GateAccount;
  session: string;
  chainRoot?: ChainRoot | undefined;
}) {
  const [open, setOpen] = useState(false);
  const result = RESULT[decision.result];
  return (
    <TableRow className="relative">
      <TableCell className="hidden w-24 md:table-cell">
        <Badge variant={result.tone}>{result.label}</Badge>
      </TableCell>
      <TableCell className="max-w-0 pl-0 whitespace-normal md:pl-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="block w-full text-left outline-none after:absolute after:inset-0 focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          <span className="block truncate font-medium">{headline(decision)}</span>
          <span className="hidden truncate text-muted md:block">{decision.message}</span>
          <span className="mt-1 flex items-center gap-2 text-muted md:hidden">
            <Badge variant={result.tone}>{result.label}</Badge>
            <time dateTime={decision.createdAt}>{ago(decision.createdAt)}</time>
          </span>
        </button>
        <ResponsiveModal
          open={open}
          onOpenChange={setOpen}
          title={headline(decision)}
          description={decision.message}
        >
          <div className="flex flex-col gap-6">
            <Facts
              items={[
                ["Result", <Badge variant={result.tone}>{result.label}</Badge>],
                ["Source", `Checked first · ${rail}`],
                ...(decision.reasons.length
                  ? [
                      [
                        "Why",
                        <ul className="flex flex-col gap-1">
                          {decision.reasons.map((r) => (
                            <li key={r.rule}>{r.words}</li>
                          ))}
                        </ul>,
                      ] as [string, ReactNode],
                    ]
                  : []),
                ["Payee", <span className="font-mono text-[0.92em]">{decision.payee}</span>],
                ...(decision.reference
                  ? [
                      [
                        "Reference",
                        <span className="font-mono text-[0.92em]">{decision.reference}</span>,
                      ] as [string, ReactNode],
                    ]
                  : []),
                ["Rules version", decision.mandate.version],
                ["Input hash", <HashText hash={decision.inputHash} />],
                [
                  "When",
                  <time dateTime={decision.createdAt}>
                    {new Date(decision.createdAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>,
                ],
              ]}
            />
            <VerifyPanel
              decision={decision}
              session={session}
              accountId={account.id}
              chainRoot={chainRoot}
            />
          </div>
        </ResponsiveModal>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <SourceCell how="Checked first" rail={rail} />
      </TableCell>
      <TableCell className="hidden font-mono text-[0.92em] text-muted xl:table-cell">
        {short(decision.payee, 6)}
      </TableCell>
      <TableCell className="hidden text-right text-muted md:table-cell">
        <time dateTime={decision.createdAt}>{ago(decision.createdAt)}</time>
      </TableCell>
      <TableCell className="w-8 text-muted">
        <ChevronRightIcon className="size-4" aria-hidden />
      </TableCell>
    </TableRow>
  );
}

/** The Source column: how Bonded saw the payment, then where it came from. */
function SourceCell({ how, rail, chainId }: { how: string; rail: string; chainId?: unknown }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{how}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-muted">
        <ChainLogo chainId={chainId} className="size-3.5" />
        <span className="truncate">{rail}</span>
      </span>
    </span>
  );
}

/** How a watched payment turned out. Never "Allowed": Bonded decided nothing before it left. */
const seenResult = (p: GateWatchedPayment) =>
  p.checkedFirst
    ? { label: "Checked first", tone: "safe" as const }
    : p.reasons.length
      ? { label: "Broke a rule", tone: "breach" as const }
      : { label: "Seen", tone: "warn" as const };

/** A payment seen after it was made. It has no receipt, so there is nothing to verify. */
function WatchedRow({ payment, rail }: { payment: GateWatchedPayment; rail: string }) {
  const [open, setOpen] = useState(false);
  const result = seenResult(payment);
  const title = `Payment of ${dollars(payment.amountUsd)}`;
  const why = payment.reasons.map((r) => r.words).join("; ");
  const note = why || "Seen after it was paid.";
  const txHash = payment.details?.txHash;
  return (
    <TableRow className="relative">
      <TableCell className="hidden w-24 md:table-cell">
        <Badge variant={result.tone}>{result.label}</Badge>
      </TableCell>
      <TableCell className="max-w-0 pl-0 whitespace-normal md:pl-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="block w-full text-left outline-none after:absolute after:inset-0 focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          <span className="block truncate font-medium">{title}</span>
          <span className="hidden truncate text-muted md:block">{note}</span>
          <span className="mt-1 flex items-center gap-2 text-muted md:hidden">
            <Badge variant={result.tone}>{result.label}</Badge>
            <time dateTime={payment.paidAt}>{ago(payment.paidAt)}</time>
          </span>
        </button>
        <ResponsiveModal
          open={open}
          onOpenChange={setOpen}
          title={title}
          description="Bonded saw this after it was paid, so it has no receipt."
        >
          <Facts
            items={[
              ["Result", <Badge variant={result.tone}>{result.label}</Badge>],
              ["Source", `Seen after · ${rail}`],
              ...(why ? [["Why", why] as [string, ReactNode]] : []),
              ["Payee", <span className="font-mono text-[0.92em]">{payment.payee}</span>],
              ...(payment.reference
                ? [["Reference", payment.reference] as [string, ReactNode]]
                : []),
              ...(txHash
                ? [["Transaction", <HashText hash={String(txHash)} />] as [string, ReactNode]]
                : []),
              [
                "Paid",
                <time dateTime={payment.paidAt}>
                  {new Date(payment.paidAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>,
              ],
            ]}
          />
        </ResponsiveModal>
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <SourceCell how="Seen after" rail={rail} chainId={payment.details?.chainId} />
      </TableCell>
      <TableCell className="hidden font-mono text-[0.92em] text-muted xl:table-cell">
        {short(payment.payee, 6)}
      </TableCell>
      <TableCell className="hidden text-right text-muted md:table-cell">
        <time dateTime={payment.paidAt}>{ago(payment.paidAt)}</time>
      </TableCell>
      <TableCell className="w-8 text-muted">
        <ChevronRightIcon className="size-4" aria-hidden />
      </TableCell>
    </TableRow>
  );
}

const ALL = "all";
const SOURCES = [
  { value: ALL, label: "All sources" },
  { value: "check", label: "API" },
  { value: "card", label: "Card" },
  { value: "wallet", label: "Wallet" },
  { value: "log", label: "Payment log" },
];
const RESULTS = [
  { value: ALL, label: "All results" },
  { value: "allowed", label: "Allowed" },
  { value: "blocked", label: "Blocked" },
  { value: "refused", label: "Refused" },
  { value: "seen", label: "Seen after" },
];
const RULES = [
  { value: ALL, label: "All rules" },
  ...GATE_RULES.map((r) => ({ value: r, label: GATE_RULE_WORDS[r] })),
];

/** A filter's value, or nothing when it's on "all". */
const chosen = (name: keyof GateActivityFilters, value: string) =>
  value === ALL ? {} : { [name]: value };

/** Every check and every payment seen after it was made, newest first. */
export function Activity({
  account,
  session,
  chainRoot,
}: {
  account: GateAccount;
  session: string;
  chainRoot?: ChainRoot | undefined;
}) {
  const [older, setOlder] = useState<{ items: GateActivityEntry[]; next: string | null }>();
  const [source, setSource] = useState(ALL);
  const [result, setResult] = useState(ALL);
  const [rule, setRule] = useState(ALL);
  const filters: GateActivityFilters = {
    ...chosen("source", source),
    ...chosen("result", result),
    ...chosen("rule", rule),
  };
  const filtered = Object.keys(filters).length;
  /** A change of filter starts the list again. */
  const filter = (set: (value: string) => void) => (value: string) => {
    setOlder(undefined);
    set(value);
  };
  const clear = () => {
    setOlder(undefined);
    setSource(ALL);
    setResult(ALL);
    setRule(ALL);
  };
  const first = useQuery({
    queryKey: ["gate-activity", session, account.id, filters],
    queryFn: () => gateApi.activity(session, account.id, filters),
    retry: false,
    // Agents check payments from elsewhere: new decisions show without a reload. Not once older
    // pages are loaded, whose cursor a refreshed first page would leave a gap before.
    refetchInterval: older ? false : 10_000,
  });
  const [loading, setLoading] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const items = [...(first.data?.items ?? []), ...(older?.items ?? [])];
  const next = older ? older.next : (first.data?.next ?? null);
  const loadMore = async () => {
    if (!next) return;
    setLoading(true);
    setMoreError(null);
    try {
      const page = await gateApi.activity(session, account.id, filters, next);
      setOlder((o) => ({ items: [...(o?.items ?? []), ...page.items], next: page.next }));
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoading(false);
    }
  };
  if (first.error) return <Unavailable error={first.error} onRetry={() => void first.refetch()} />;
  if (!first.data) return <Loading what="decisions" />;
  if (!items.length && !filtered)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No checks yet</EmptyTitle>
          <EmptyDescription>
            Your agent's checks show here.{" "}
            <Link className={linkClass} to="?tab=connect">
              Connect your agent
            </Link>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="flex flex-col items-start gap-4">
      <div className="flex w-full justify-end">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <ListFilterIcon aria-hidden />
              Filters
              {filtered > 0 && <Badge variant="brand">{filtered}</Badge>}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="flex flex-col gap-4">
            <SelectField
              label="Source"
              value={source}
              onChange={filter(setSource)}
              options={SOURCES}
            />
            <SelectField
              label="Result"
              value={result}
              onChange={filter(setResult)}
              options={RESULTS}
            />
            <SelectField label="Rule" value={rule} onChange={filter(setRule)} options={RULES} />
            {filtered > 0 && (
              <Button variant="ghost" size="sm" onClick={clear}>
                Clear filters
              </Button>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {!items.length && <p className="text-sm text-muted">Nothing matches these filters.</p>}
      <Table aria-label="Decisions" className={items.length ? "table-fixed" : "hidden"}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="hidden w-24 md:table-cell">Result</TableHead>
            <TableHead className="pl-0 md:pl-3">Check</TableHead>
            <TableHead className="hidden w-48 lg:table-cell">Source</TableHead>
            <TableHead className="hidden w-52 xl:table-cell">Payee</TableHead>
            <TableHead className="hidden w-20 text-right md:table-cell">When</TableHead>
            <TableHead className="w-8">
              <span className="sr-only">Open</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((i) =>
            i.entry === "decision" ? (
              <DecisionRow
                key={i.decision.id}
                decision={i.decision}
                rail={i.rail}
                account={account}
                session={session}
                chainRoot={chainRoot}
              />
            ) : (
              <WatchedRow key={`w${i.watched.id}`} payment={i.watched} rail={i.rail} />
            ),
          )}
        </TableBody>
      </Table>
      {next && (
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadMore()}>
          {loading && <Spinner aria-hidden />}
          Load more
        </Button>
      )}
      <ErrorText error={moreError} />
    </div>
  );
}
