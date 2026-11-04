import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/shadcn/badge";
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
import { apiUrl } from "../../config";
import { ago } from "../../lib/format";
import { dollars, gateApi, type GateAccount } from "../../lib/gate";
import { CopyButton } from "../copy";
import { ModalActions } from "../responsive-modal";
import { ErrorText, Loading, Unavailable, linkClass } from "../ui";
import { ConfirmButton, ModalButton, Submit, TabBar, TextField, useAction } from "./common";

const STRIPE_KEY = /^(rk|sk)_test_[A-Za-z0-9]{10,247}$/;
const CARDHOLDER = /^ich_[A-Za-z0-9]{1,64}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_-]{10,200}$/;

/** Where each step happens in the Stripe dashboard. */
const STRIPE = {
  cardholders: "https://dashboard.stripe.com/issuing/cardholders",
  settings: "https://dashboard.stripe.com/account/issuing",
  webhooks: "https://dashboard.stripe.com/webhooks",
  keys: "https://dashboard.stripe.com/apikeys",
};

/** What's wrong with a value typed so far, or null while it's empty or right. */
const wrong = (value: string, shape: RegExp, message: string) =>
  value.trim() && !shape.test(value.trim()) ? message : null;

/** One numbered step of the setup, with a link to where it happens. */
function Step({
  n,
  title,
  link,
  linkText,
  children,
}: {
  n: number;
  title: string;
  link: string;
  linkText: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4 text-sm text-soft first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-semibold text-ink">
          {n}. {title}
        </h3>
        <a className={linkClass} href={link} target="_blank" rel="noreferrer">
          Open {linkText} in Stripe <span aria-hidden>↗</span>
        </a>
      </div>
      {children}
    </section>
  );
}

/** An address to paste into Stripe, with a button to copy it. */
function Address({ url }: { url: string }) {
  return (
    <span className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2">
      <span className="min-w-0 flex-1 font-mono text-xs break-all text-ink">{url}</span>
      <CopyButton text={url} variant="icon" />
    </span>
  );
}

/** The key goes straight to the API, which stores it encrypted; only a hint of it ever comes back. */
function StripeForm({
  account,
  session,
  close,
}: {
  account: GateAccount;
  session: string;
  close: () => void;
}) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [key, setKey] = useState("");
  const [cardholder, setCardholder] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [events, setEvents] = useState("");
  const ready =
    STRIPE_KEY.test(key.trim()) &&
    CARDHOLDER.test(cardholder.trim()) &&
    WEBHOOK_SECRET.test(authorization.trim()) &&
    WEBHOOK_SECRET.test(events.trim());
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void action.run(async () => {
          await gateApi.linkStripe(session, account.id, {
            secretKey: key.trim(),
            cardholderId: cardholder.trim(),
            authorizationWebhookSecret: authorization.trim(),
            eventsWebhookSecret: events.trim(),
          });
          // Closed first: the refresh swaps this form's branch of the tab for the linked view.
          close();
          await queryClient.invalidateQueries({
            queryKey: ["gate-stripe", session, account.id],
          });
        });
      }}
    >
      <Step n={1} title="Make a cardholder" link={STRIPE.cardholders} linkText="Cardholders">
        <p>
          Create a cardholder: it's who your agent's cards are issued to. Add some test funds to
          your Issuing balance too, or Stripe declines every charge.
        </p>
        <TextField
          label="Cardholder ID"
          value={cardholder}
          onChange={setCardholder}
          placeholder="ich_..."
          error={wrong(cardholder, CARDHOLDER, "A cardholder ID starts with ich_.")}
          hint="Shown on the cardholder's page."
        />
      </Step>
      <Step
        n={2}
        title="Let Stripe ask the gate before each charge"
        link={STRIPE.settings}
        linkText="Issuing settings"
      >
        <p>
          Under real-time authorizations, paste this address. If it asks what to do on a timeout,
          choose <b>decline</b>.
        </p>
        <Address url={`${apiUrl}/stripe/issuing/authorization`} />
        <TextField
          label="Signing secret for this address"
          type="password"
          value={authorization}
          onChange={setAuthorization}
          placeholder="whsec_..."
          error={wrong(authorization, WEBHOOK_SECRET, "A signing secret starts with whsec_.")}
          hint="Stripe shows it once the address is saved."
        />
      </Step>
      <Step
        n={3}
        title="Tell the gate how each charge ended"
        link={STRIPE.webhooks}
        linkText="Webhooks"
      >
        <p>Add a destination with this address, and tick these three events:</p>
        <Address url={`${apiUrl}/stripe/issuing/events`} />
        <ul className="list-disc pl-5 font-mono text-xs">
          <li>issuing_authorization.created</li>
          <li>issuing_authorization.updated</li>
          <li>issuing_transaction.created</li>
        </ul>
        <TextField
          label="Signing secret for this destination"
          type="password"
          value={events}
          onChange={setEvents}
          placeholder="whsec_..."
          error={wrong(events, WEBHOOK_SECRET, "A signing secret starts with whsec_.")}
          hint="On the destination's page, after you save it."
        />
      </Step>
      <Step n={4} title="Give the gate a key" link={STRIPE.keys} linkText="API keys">
        <p>
          Create a restricted key. Set Issuing Cards to <b>Write</b>, and Issuing Authorizations and
          Issuing Transactions to <b>Read</b>. Leave the rest as None.
        </p>
        <TextField
          label="Restricted key"
          type="password"
          value={key}
          onChange={setKey}
          placeholder="rk_test_..."
          error={wrong(key, STRIPE_KEY, "Use a test key: it starts with rk_test_.")}
          hint="Stored encrypted and never shown again."
        />
      </Step>
      <ErrorText error={action.error} />
      <ModalActions>
        <Button variant="ghost" type="button" onClick={close}>
          Cancel
        </Button>
        <Submit busy={action.busy} disabled={!ready}>
          Link Stripe
        </Submit>
      </ModalActions>
    </form>
  );
}

/**
 * The card route: link a Stripe test account and the gate decides every charge on the single-use
 * cards it issues (apps/api/GATE.md, "The card route").
 */
export function Cards({ account, session }: { account: GateAccount; session: string }) {
  const queryClient = useQueryClient();
  const link = useQuery({
    queryKey: ["gate-stripe", session, account.id],
    queryFn: () => gateApi.stripeLink(session, account.id),
    retry: false,
  });
  const connect = useQuery({
    queryKey: ["gate-stripe-connect", session, account.id],
    queryFn: () => gateApi.stripeConnect(session, account.id),
    enabled: link.data === null,
    retry: false,
    // Its link carries a state that expires, so it's read fresh.
    staleTime: 0,
  });
  const cards = useQuery({
    queryKey: ["gate-cards", session, account.id],
    queryFn: () => gateApi.cardIntents(session, account.id),
    enabled: Boolean(link.data),
    retry: false,
    refetchInterval: 10_000,
  });
  if (link.error) return <Unavailable error={link.error} onRetry={() => void link.refetch()} />;
  if (link.data === undefined || (link.data === null && connect.isPending))
    return <Loading what="the Stripe link" />;
  if (!link.data) {
    const url = connect.data?.url;
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Pay approved invoices by card</EmptyTitle>
          <EmptyDescription>
            Stripe asks the gate before every charge, so a charge that breaks a rule is declined.
            Test mode only.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {url && (
            <>
              <Button asChild>
                <a href={url}>Connect with Stripe</a>
              </Button>
              <p className="text-xs text-muted">
                You approve Bonded on Stripe's page. No keys to copy.
              </p>
            </>
          )}
          <ModalButton
            label={url ? "Set it up by hand instead" : "Link Stripe"}
            variant={url ? "ghost" : undefined}
            title="Link Stripe"
            description="About ten minutes in your Stripe dashboard. Turn on Test mode there first: no real money moves."
            wide
          >
            {(close) => <StripeForm account={account} session={session} close={close} />}
          </ModalButton>
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <TabBar
        action={
          <ConfirmButton
            label="Unlink"
            variant="outline"
            title="Unlink Stripe?"
            description="No new cards. Cards already issued are still checked on every charge."
            confirm="Unlink Stripe"
            act={() => gateApi.unlinkStripe(session, account.id)}
            then={() =>
              queryClient.invalidateQueries({ queryKey: ["gate-stripe", session, account.id] })
            }
          />
        }
      >
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge variant="safe">{link.data.connected ? "Connected" : "Linked"}</Badge>
          <span className="font-mono text-[0.92em] text-ink">{link.data.keyHint}</span>
          <span className="font-mono text-[0.92em]">{link.data.cardholderId}</span>
        </span>
      </TabBar>
      {cards.error ? (
        <Unavailable error={cards.error} onRetry={() => void cards.refetch()} />
      ) : !cards.data ? (
        <Loading what="cards" />
      ) : !cards.data.items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No cards yet</EmptyTitle>
            <EmptyDescription>
              Your agent asks for one with POST /payments/intents.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Invoice</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="hidden sm:table-cell">Card</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Issued</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cards.data.items.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-[0.92em]">{c.invoiceReference}</TableCell>
                <TableCell className="text-right tabular-nums">{dollars(c.amountUsd)}</TableCell>
                <TableCell className="hidden font-mono text-[0.92em] sm:table-cell">
                  {c.card ? `•••• ${c.card.last4}` : "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{c.status}</Badge>
                </TableCell>
                <TableCell className="hidden text-muted sm:table-cell">
                  {ago(c.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
