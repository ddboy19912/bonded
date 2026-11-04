import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/shadcn/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/shadcn/empty";
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
  KeyOnce,
  Submit,
  TextField,
  limit,
  useAction,
} from "../components/gate/common";
import { SignedIn } from "../components/gate/owner";
import { FreezeSwitch, ModeChoice } from "../components/gate/rules";
import { ModalActions, ResponsiveModal } from "../components/responsive-modal";
import { ErrorText, Loading, Page, Unavailable, linkClass } from "../components/ui";
import { ago, short } from "../lib/format";
import { gateApi, parseUsd, type GateAccount } from "../lib/gate";
import { DOCS_GATE } from "../lib/routes";

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
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const action = useAction();
  const [name, setName] = useState("");
  const [perPayment, setPerPayment] = useState("");
  const [perDay, setPerDay] = useState("");
  const [mode, setMode] = useState<GateAccount["mode"]>("monitor");
  const [freeze, setFreeze] = useState(false);
  const [touched, setTouched] = useState(false);
  const [made, setMade] = useState<{ accountId: string; key: string }>();
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
      setMade({ accountId: account.account.id, key: account.apiKey.key });
    });
  };
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
        <form
          className="flex flex-col gap-5"
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
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Submit busy={action.busy}>Make the account</Submit>
          </ModalActions>
        </form>
      )}
    </ResponsiveModal>
  );
}

/** When the account last checked a payment, from the same log its Activity tab shows. */
function LastCheck({ account, session }: { account: GateAccount; session: string }) {
  const decisions = useQuery({
    queryKey: ["gate-decisions", session, account.id],
    queryFn: () => gateApi.decisions(session, account.id),
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
          <span className="block truncate text-[15px] font-medium">
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

function Accounts({
  session,
  page,
}: {
  session: string;
  page: (body: ReactNode, actions?: ReactNode) => ReactNode;
}) {
  const accounts = useQuery({
    queryKey: ["gate-accounts", session],
    queryFn: () => gateApi.accounts(session),
    retry: false,
  });
  const [creating, setCreating] = useState(false);
  const list = accounts.data?.items ?? [];
  return page(
    <>
      {accounts.isPending ? (
        <Loading what="your gate accounts" height="md" />
      ) : accounts.error ? (
        <Unavailable error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : !list.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No gate accounts yet</EmptyTitle>
            <EmptyDescription>
              Make one, and your agents check every payment against its rules.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setCreating(true)}>New account</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Table aria-label="Gate accounts" className="table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Account</TableHead>
              <TableHead className="hidden w-32 md:table-cell">Status</TableHead>
              <TableHead className="hidden w-32 text-right md:table-cell">Per payment</TableHead>
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
      )}
      <NewAccount session={session} open={creating} onOpenChange={setCreating} />
    </>,
    list.length > 0 && (
      <Button onClick={() => setCreating(true)}>
        <PlusIcon aria-hidden />
        New account
      </Button>
    ),
  );
}

/** The payment gate: every account the owner has. Each opens on its own page (GateAccount). */
export function Gate() {
  const page = (body: ReactNode, actions?: ReactNode) => (
    <Page
      title="Payment gate"
      actions={actions}
      intro={
        <>
          Set the rules your agents' payments must follow.{" "}
          <a className={linkClass} href={DOCS_GATE} target="_blank" rel="noreferrer">
            How to connect an agent
          </a>
          {" · "}
          <Link className={linkClass} to="/gate/verify">
            Check a receipt
          </Link>
        </>
      }
    >
      {body}
    </Page>
  );
  return <SignedIn page={page}>{(session) => <Accounts session={session} page={page} />}</SignedIn>;
}
