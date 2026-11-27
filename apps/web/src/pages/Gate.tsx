import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/shadcn/table";
import {
  AccountStatus,
  Button,
  KeyOnce,
  limit,
  Submit,
  TABLE,
  TextField,
  useAction,
} from "../components/gate/common";
import { SignedIn } from "../components/gate/owner";
import { FreezeSwitch, ModeChoice } from "../components/gate/rules";
import { useMediaQuery } from "../components/overlay";
import { ModalActions, ResponsiveModal } from "../components/responsive-modal";
import {
  EmptyState,
  ErrorText,
  Grid,
  Loading,
  Page,
  Section,
  Stat,
  Unavailable,
  MoreLink,
} from "../components/ui";
import { ago, short } from "../lib/format";
import { gateApi, parseUsd, type GateAccount } from "../lib/gate";
import { DOCS_GATE } from "../lib/routes";

/** A new account's limits and mode. It sits inside the modal, so closing it clears the form. */
function NewAccountForm({
  session,
  onMade,
  onCancel,
}: {
  session: string;
  onMade: (made: { accountId: string; key: string }) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [name, setName] = useState("");
  const [perPayment, setPerPayment] = useState("");
  const [perDay, setPerDay] = useState("");
  const [mode, setMode] = useState<GateAccount["mode"]>("monitor");
  const [freeze, setFreeze] = useState(false);
  const [touched, setTouched] = useState(false);
  const maxPaymentUsd = parseUsd(perPayment);
  const maxDailyUsd = parseUsd(perDay);
  const submit = () => {
    setTouched(true);
    if (maxPaymentUsd === null || maxDailyUsd === null) return;
    void action.run(async () => {
      const account = await gateApi.createAccount(session, {
        ...(name.trim() ? { name: name.trim() } : {}),
        mode,
        maxPaymentUsd,
        maxDailyUsd,
        freezeOnBreach: freeze,
      });
      await queryClient.invalidateQueries({ queryKey: ["gate-accounts"] });
      onMade({ accountId: account.account.id, key: account.apiKey.key });
    });
  };
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <TextField
        label="Name"
        value={name}
        onChange={setName}
        placeholder="Acme payables"
        mono={false}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Most for one payment"
          value={perPayment}
          onChange={setPerPayment}
          placeholder="5000"
          inputMode="decimal"
          suffix="USD"
          error={touched && maxPaymentUsd === null ? "Enter an amount in dollars." : null}
        />
        <TextField
          label="Most in one day"
          value={perDay}
          onChange={setPerDay}
          placeholder="20000"
          inputMode="decimal"
          suffix="USD"
          error={touched && maxDailyUsd === null ? "Enter an amount in dollars." : null}
        />
      </div>
      <ModeChoice mode={mode} onChange={setMode} />
      <FreezeSwitch checked={freeze} onChange={setFreeze} />
      <ErrorText error={action.error} />
      <ModalActions>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Submit busy={action.busy}>Make the account</Submit>
      </ModalActions>
    </form>
  );
}

/** Make a gate account, then show its first API key once. */
function NewAccount({
  session,
  open,
  onOpenChange,
}: {
  session: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [made, setMade] = useState<{ accountId: string; key: string }>();
  return (
    <ResponsiveModal
      open={open}
      onOpenChange={onOpenChange}
      title={made ? "Copy your key" : "New gate account"}
      description={
        made ? undefined : "One per business or team. Your agents check every payment against it."
      }
      locked={Boolean(made)}
    >
      {made ? (
        <>
          <KeyOnce apiKey={made.key} />
          <ModalActions>
            <Button onClick={() => void navigate(`/gate/${encodeURIComponent(made.accountId)}`)}>
              Open the account
            </Button>
          </ModalActions>
        </>
      ) : (
        <NewAccountForm session={session} onMade={setMade} onCancel={() => onOpenChange(false)} />
      )}
    </ResponsiveModal>
  );
}

/** When the account last checked a payment. Its column only shows on wide screens. */
function LastCheck({ account, session }: { account: GateAccount; session: string }) {
  const shown = useMediaQuery("(min-width: 1024px)");
  const decisions = useQuery({
    queryKey: ["gate-last-check", session, account.id],
    queryFn: () => gateApi.lastDecision(session, account.id),
    enabled: shown,
    retry: false,
  });
  const last = decisions.data?.items[0];
  return last ? (
    <time dateTime={last.createdAt}>{ago(last.createdAt)}</time>
  ) : decisions.data ? (
    "Never"
  ) : (
    "—"
  );
}

/** One account in the list. The whole row opens it. */
function AccountRow({ account, session }: { account: GateAccount; session: string }) {
  return (
    <TableRow className="relative">
      <TableCell className="max-w-0">
        <Link
          to={`/gate/${encodeURIComponent(account.id)}`}
          className="block outline-none after:absolute after:inset-0 focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          <span className="block truncate text-[17px] font-medium tracking-[-0.01em]">
            {account.name || short(account.id, 6)}
          </span>
          <span className="mt-1 flex items-center gap-2 text-muted md:hidden">
            <AccountStatus account={account} />
            <span className="truncate">
              {limit(account.maxPaymentUsd)} · {limit(account.maxDailyUsd)} a day
            </span>
          </span>
        </Link>
      </TableCell>
      <TableCell className="hidden w-32 md:table-cell">
        <AccountStatus account={account} />
      </TableCell>
      <TableCell className="hidden w-32 text-right tabular-nums md:table-cell">
        {limit(account.maxPaymentUsd)}
      </TableCell>
      <TableCell className="hidden w-32 text-right tabular-nums md:table-cell">
        {limit(account.maxDailyUsd)}
      </TableCell>
      <TableCell className="hidden w-32 text-right text-muted lg:table-cell">
        <LastCheck account={account} session={session} />
      </TableCell>
      <TableCell className="w-8 text-muted">
        <ChevronRightIcon className="size-4" aria-hidden />
      </TableCell>
    </TableRow>
  );
}

function Accounts({ session, page }: { session: string; page: (body: ReactNode) => ReactNode }) {
  const accounts = useQuery({
    queryKey: ["gate-accounts", session],
    queryFn: () => gateApi.accounts(session),
    retry: false,
  });
  const [creating, setCreating] = useState(false);
  const list = accounts.data?.items ?? [];
  const enforcing = list.filter((a) => !a.frozen && a.mode === "enforce").length;
  const frozen = list.filter((a) => a.frozen).length;
  return page(
    <>
      {accounts.isPending ? (
        <Loading what="your gate accounts" height="md" />
      ) : accounts.error ? (
        <Unavailable error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : !list.length ? (
        <EmptyState
          title="No gate accounts yet"
          action={
            <Button size="lg" onClick={() => setCreating(true)}>
              New account
            </Button>
          }
        >
          Make one, and your agents check every payment against its rules.
        </EmptyState>
      ) : (
        <Section
          label="Accounts"
          title="Your accounts"
          intro="One per business or team. Open one to see its checks, rules and keys."
          actions={
            <Button onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden />
              New account
            </Button>
          }
        >
          <Grid>
            <Stat label="Accounts" value={list.length} />
            <Stat label="Enforcing" value={enforcing} />
            <Stat label="Monitoring" value={list.length - enforcing - frozen} />
            <Stat label="Frozen" value={frozen} />
          </Grid>
          <div className="mt-12">
            <Table aria-label="Gate accounts" className={`table-fixed ${TABLE}`}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Account</TableHead>
                  <TableHead className="hidden w-32 md:table-cell">Status</TableHead>
                  <TableHead className="hidden w-32 text-right md:table-cell">
                    Per payment
                  </TableHead>
                  <TableHead className="hidden w-32 text-right md:table-cell">Per day</TableHead>
                  <TableHead className="hidden w-32 text-right lg:table-cell">Last check</TableHead>
                  <TableHead className="w-8">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((a) => (
                  <AccountRow key={a.id} account={a} session={session} />
                ))}
              </TableBody>
            </Table>
          </div>
        </Section>
      )}
      <NewAccount session={session} open={creating} onOpenChange={setCreating} />
    </>,
  );
}

/** The payment gate: every account the owner has. Each opens on its own page (GateAccount). */
export function Gate() {
  const page = (body: ReactNode) => (
    <Page
      eyebrow="Protect"
      title="Payment gate"
      intro="Set the rules your agents' payments must follow."
      actions={
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <a className="more-link" href={DOCS_GATE} target="_blank" rel="noreferrer">
            How to connect an agent <span aria-hidden>↗</span>
          </a>
          <MoreLink to="/gate/verify">Check a receipt</MoreLink>
        </div>
      }
    >
      {body}
    </Page>
  );
  return <SignedIn page={page}>{(session) => <Accounts session={session} page={page} />}</SignedIn>;
}
