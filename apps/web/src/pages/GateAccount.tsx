import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/shadcn/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/shadcn/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/shadcn/tabs";
import { Activity } from "../components/gate/activity";
import { Cards } from "../components/gate/cards";
import { AccountStatus, ConfirmButton, limit } from "../components/gate/common";
import { Connect } from "../components/gate/connect";
import { Invoices } from "../components/gate/invoices";
import { Keys } from "../components/gate/keys";
import { SignedIn } from "../components/gate/owner";
import { EditRules, Rules } from "../components/gate/rules";
import { useChainRoot } from "../components/gate/verification";
import { Vendors } from "../components/gate/vendors";
import { Watch } from "../components/gate/watch";
import { Loading, Page, Unavailable } from "../components/ui";
import { short } from "../lib/format";
import { gateApi, type GateAccount as Account } from "../lib/gate";

const TABS = [
  { id: "activity", label: "Activity" },
  { id: "connect", label: "Connect" },
  { id: "rules", label: "Rules" },
  { id: "vendors", label: "Vendors" },
  { id: "invoices", label: "Invoices" },
  { id: "watch", label: "Watch" },
  { id: "cards", label: "Cards" },
  { id: "keys", label: "API keys" },
] as const;

const BACK = { to: "/gate", label: "Payment gate" };

/** Said at the top of the account, whichever tab is open: nothing goes through until it's lifted. */
function Frozen({ account, session }: { account: Account; session: string }) {
  const queryClient = useQueryClient();
  return (
    <Alert variant="destructive" className="flex items-center justify-between gap-4">
      <div>
        <AlertTitle>Frozen</AlertTitle>
        <AlertDescription>
          A breach froze this account. Every check is refused until you lift it.
        </AlertDescription>
      </div>
      <ConfirmButton
        label="Lift the freeze"
        variant="outline"
        title="Lift the freeze?"
        description="Checks run again at once."
        confirm="Lift the freeze"
        act={() => gateApi.unfreeze(session, account.id)}
        then={() => queryClient.invalidateQueries({ queryKey: ["gate-accounts"] })}
      />
    </Alert>
  );
}

function Detail({ account, session }: { account: Account; session: string }) {
  const [params, setParams] = useSearchParams();
  const chainRoot = useChainRoot();
  const tab = TABS.find((t) => t.id === params.get("tab"))?.id ?? "activity";
  // On a phone the strip scrolls sideways: a link to a late tab must still show it selected.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = strip.current;
    const active = list?.querySelector('[data-state="active"]');
    if (list && active)
      list.scrollLeft += Math.max(
        0,
        active.getBoundingClientRect().right - list.getBoundingClientRect().right,
      );
  }, [tab]);
  return (
    <Page
      back={BACK}
      title={account.name || short(account.id, 6)}
      intro={
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <AccountStatus account={account} />
          {limit(account.maxPaymentUsd)} a payment · {limit(account.maxDailyUsd)} a day
        </span>
      }
      actions={<EditRules account={account} session={session} />}
    >
      {account.frozen && <Frozen account={account} session={session} />}
      <Tabs
        value={tab}
        onValueChange={(t) => setParams(t === "activity" ? {} : { tab: t }, { replace: true })}
        className="gap-6"
      >
        <TabsList
          ref={strip}
          variant="line"
          className="h-auto! w-full justify-start gap-5 overflow-x-auto rounded-none border-b p-0 [scrollbar-width:none]"
        >
          {TABS.map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className="h-10 flex-none rounded-md border-0 px-0.5 after:bottom-0! focus-visible:border-0 focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
            >
              {/* With no invoices to match, these are payees rather than vendors. */}
              {t.id === "vendors" && !account.invoiceMatching ? "Payees" : t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="activity">
          <Activity account={account} session={session} chainRoot={chainRoot} />
        </TabsContent>
        <TabsContent value="connect">
          <Connect account={account} session={session} />
        </TabsContent>
        <TabsContent value="rules">
          <Rules account={account} session={session} />
        </TabsContent>
        <TabsContent value="vendors">
          <Vendors account={account} session={session} />
        </TabsContent>
        <TabsContent value="invoices">
          <Invoices account={account} session={session} />
        </TabsContent>
        <TabsContent value="watch">
          <Watch account={account} session={session} />
        </TabsContent>
        <TabsContent value="cards">
          <Cards account={account} session={session} />
        </TabsContent>
        <TabsContent value="keys">
          <Keys account={account} session={session} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function Load({ id, session }: { id: string; session: string }) {
  const accounts = useQuery({
    queryKey: ["gate-accounts", session],
    queryFn: () => gateApi.accounts(session),
    retry: false,
  });
  const account = accounts.data?.items.find((a) => a.id === id);
  if (account) return <Detail key={account.id} account={account} session={session} />;
  return (
    <Page back={BACK} title="Gate account">
      {accounts.isPending ? (
        <Loading what="the account" height="md" />
      ) : accounts.error ? (
        <Unavailable error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Account not found</EmptyTitle>
            <EmptyDescription>
              This wallet doesn't own a gate account with that link.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </Page>
  );
}

/** One gate account: its activity, rules, vendors, invoices, cards and keys, a tab each. */
export function GateAccount() {
  const { accountId = "" } = useParams();
  return (
    <SignedIn
      page={(body) => (
        <Page back={BACK} title="Gate account">
          {body}
        </Page>
      )}
    >
      {(session) => <Load id={accountId} session={session} />}
    </SignedIn>
  );
}
