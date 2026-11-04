import { useState } from "react";
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
import { ago } from "../../lib/format";
import { dollars, gateApi, type GateAccount } from "../../lib/gate";
import { ModalActions } from "../responsive-modal";
import { ErrorText, Loading, Unavailable } from "../ui";
import { ConfirmButton, ModalButton, Submit, TabBar, TextField, useAction } from "./common";

const STRIPE_KEY = /^(rk|sk)_test_[A-Za-z0-9]{10,247}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_-]{10,200}$/;

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
    /^ich_[A-Za-z0-9]{1,64}$/.test(cardholder.trim()) &&
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
      <TextField
        label="Restricted key"
        type="password"
        value={key}
        onChange={setKey}
        placeholder="rk_test_..."
        hint="Test mode. Stored encrypted and never shown again."
      />
      <TextField
        label="Cardholder"
        value={cardholder}
        onChange={setCardholder}
        placeholder="ich_..."
        hint="The Stripe cardholder the cards are issued to."
      />
      <TextField
        label="Authorization webhook secret"
        type="password"
        value={authorization}
        onChange={setAuthorization}
        placeholder="whsec_..."
        hint="From Stripe's real-time authorizations endpoint."
      />
      <TextField
        label="Events webhook secret"
        type="password"
        value={events}
        onChange={setEvents}
        placeholder="whsec_..."
        hint="From the webhook endpoint for Issuing events."
      />
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
  const cards = useQuery({
    queryKey: ["gate-cards", session, account.id],
    queryFn: () => gateApi.cardIntents(session, account.id),
    enabled: Boolean(link.data),
    retry: false,
    refetchInterval: 10_000,
  });
  if (link.error) return <Unavailable error={link.error} onRetry={() => void link.refetch()} />;
  if (link.data === undefined) return <Loading what="the Stripe link" />;
  if (!link.data)
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
          <ModalButton
            label="Link Stripe"
            title="Link Stripe"
            description="Your agent then pays approved invoices with single-use cards."
          >
            {(close) => <StripeForm account={account} session={session} close={close} />}
          </ModalButton>
        </EmptyContent>
      </Empty>
    );
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
          <Badge variant="safe">Linked</Badge>
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
