import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCardIcon, PlusIcon } from "lucide-react";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/shadcn/empty";
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
import {
  dollars,
  gateApi,
  type GateAccount,
  type GateCardHook,
  type GateCardProvider,
} from "../../lib/gate";
import { CopyButton } from "../copy";
import { ModalActions } from "../responsive-modal";
import { ErrorText, Loading, Unavailable } from "../ui";
import {
  ConfirmButton,
  Facts,
  ModalButton,
  SelectField,
  Submit,
  TextField,
  useAction,
} from "./common";

const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_-]{10,200}$/;

export const CARD_PROVIDERS: Record<GateCardProvider, string> = {
  stripe: "Stripe Issuing",
  lithic: "Lithic",
  marqeta: "Marqeta",
};

/** Where each program's setting lives, in plain words. */
const WHERE: Record<GateCardProvider, ReactNode> = {
  stripe: (
    <>
      In Stripe, add a webhook endpoint at this address for the{" "}
      <span className="font-mono text-xs">issuing_authorization.request</span> event, then pick it
      for real-time authorizations in your Issuing settings. If Stripe asks what to do when there's
      no answer, choose <b>decline</b>.
    </>
  ),
  lithic: (
    <>
      Enroll this address for Auth Stream Access in Lithic. Your ASA signing secret is on your
      Lithic account page.
    </>
  ),
  marqeta: (
    <>
      Set this address as your program's Gateway JIT Funding address in Marqeta, with the username
      and password below.
    </>
  ),
};

const hookUrl = (hook: GateCardHook) => `${apiUrl}${hook.path}`;
const hooksKey = (session: string, id: string) => ["gate-card-hooks", session, id];

/** Something to paste into the card program, with a button to copy it. */
function Copyable({ label, text, secret }: { label: string; text: string; secret?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2">
        <span className="min-w-0 flex-1 font-mono text-xs break-all text-ink">{text}</span>
        <CopyButton text={text} variant="icon" label={`Copy ${label.toLowerCase()}`} />
      </span>
      {secret && <span className="text-xs text-warn">Shown once. Save it in Marqeta now.</span>}
    </div>
  );
}

/** Paste the signing secret Stripe or Lithic shows. */
function SecretForm({
  account,
  session,
  hook,
  close,
}: {
  account: GateAccount;
  session: string;
  hook: GateCardHook;
  close: () => void;
}) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [secret, setSecret] = useState("");
  const valid = WEBHOOK_SECRET.test(secret.trim());
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void action.run(async () => {
          await gateApi.setCardHookSecret(session, account.id, hook.id, secret.trim());
          await queryClient.invalidateQueries({ queryKey: hooksKey(session, account.id) });
          close();
        });
      }}
    >
      <TextField
        label="Signing secret"
        type="password"
        value={secret}
        onChange={setSecret}
        placeholder="whsec_..."
        hint="Stored encrypted. It can only check requests: it can't make or fund a card."
        error={secret.trim() && !valid ? "A signing secret starts with whsec_." : null}
      />
      <ErrorText error={action.error} />
      <ModalActions>
        <Button variant="ghost" type="button" onClick={close}>
          Later
        </Button>
        <Submit busy={action.busy} disabled={!valid}>
          Save secret
        </Submit>
      </ModalActions>
    </form>
  );
}

/** Pick the program, get the address, then finish in the program. */
function HookForm({
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
  const [provider, setProvider] = useState<GateCardProvider>("stripe");
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<(GateCardHook & { password?: string }) | null>(null);
  if (made)
    return (
      <div className="flex flex-col gap-4 text-sm text-soft">
        <p>{WHERE[made.provider]}</p>
        <Copyable label="Address" text={hookUrl(made)} />
        {made.provider === "marqeta" ? (
          <>
            <Copyable label="Username" text={made.username ?? ""} />
            {made.password && <Copyable label="Password" text={made.password} secret />}
            <ModalActions>
              <Button type="button" onClick={close}>
                Done
              </Button>
            </ModalActions>
          </>
        ) : (
          <SecretForm account={account} session={session} hook={made} close={close} />
        )}
      </div>
    );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          const hook = await gateApi.addCardHook(session, account.id, {
            provider,
            ...(label.trim() ? { label: label.trim() } : {}),
          });
          await queryClient.invalidateQueries({ queryKey: hooksKey(session, account.id) });
          setMade(hook);
        });
      }}
    >
      <SelectField
        label="Card provider"
        value={provider}
        onChange={(v) => setProvider(v as GateCardProvider)}
        options={(Object.keys(CARD_PROVIDERS) as GateCardProvider[]).map((p) => ({
          value: p,
          label: CARD_PROVIDERS[p],
        }))}
      />
      <TextField label="Label" value={label} onChange={setLabel} mono={false} />
      <ErrorText error={action.error} />
      <ModalActions>
        <Submit busy={action.busy}>Get the address</Submit>
      </ModalActions>
    </form>
  );
}

/** The line under a provider's name: the provider when it has a label, and how it signs. */
function details(h: GateCardHook): ReactNode {
  const parts: ReactNode[] = [];
  if (h.label) parts.push(CARD_PROVIDERS[h.provider]);
  const proof = h.secretHint ?? h.username;
  if (proof)
    parts.push(
      <span key="proof" className="font-mono">
        {proof}
      </span>,
    );
  if (!parts.length) return "No signing secret yet";
  return parts.map((p, i) => (
    <span key={i}>
      {i > 0 && " · "}
      {p}
    </span>
  ));
}

function Status({ hook }: { hook: GateCardHook }) {
  if (!hook.ready) return <Badge variant="warn">Needs its secret</Badge>;
  return (
    <span className="text-xs text-muted">
      {hook.lastRequestAt ? `Asked ${ago(hook.lastRequestAt)}` : "Not asked yet"}
    </span>
  );
}

function Hooks({ account, session }: { account: GateAccount; session: string }) {
  const queryClient = useQueryClient();
  const hooks = useQuery({
    queryKey: hooksKey(session, account.id),
    queryFn: () => gateApi.cardHooks(session, account.id),
    retry: false,
    refetchInterval: 30_000,
  });
  if (hooks.error) return <Unavailable error={hooks.error} onRetry={() => void hooks.refetch()} />;
  if (!hooks.data) return <Loading what="your card providers" />;
  return (
    <section aria-label="Card providers" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Card providers</h2>
        <ModalButton
          label={
            <>
              <PlusIcon aria-hidden />
              Connect a provider
            </>
          }
          size="sm"
          title="Connect a card provider"
          description="Your provider asks Bonded before each charge. Bonded holds no key: it can't make, fund or charge a card."
        >
          {(close) => <HookForm account={account} session={session} close={close} />}
        </ModalButton>
      </div>
      {hooks.data.items.length === 0 ? (
        <Empty className="border border-dashed border-line">
          <EmptyHeader>
            <EmptyTitle>No card provider yet</EmptyTitle>
            <EmptyDescription>
              Connect Stripe Issuing, Lithic or Marqeta, and each charge on your agent's cards is
              checked against your rules.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {hooks.data.items.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-3 p-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-muted">
                <CreditCardIcon className="size-4" aria-hidden />
              </span>
              <div className="min-w-[10rem] flex-1">
                <p className="truncate text-sm font-medium">
                  {h.label || CARD_PROVIDERS[h.provider]}
                </p>
                <p className="truncate text-xs text-muted">{details(h)}</p>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <span className="mr-2">
                  <Status hook={h} />
                </span>
                <CopyButton text={hookUrl(h)} variant="icon" label="Copy address" />
                {!h.ready && (
                  <ModalButton
                    label="Add secret"
                    size="sm"
                    variant="outline"
                    title={`Add ${CARD_PROVIDERS[h.provider]}'s signing secret`}
                    description={WHERE[h.provider]}
                  >
                    {(close) => (
                      <div className="flex flex-col gap-4">
                        <Copyable label="Address" text={hookUrl(h)} />
                        <SecretForm account={account} session={session} hook={h} close={close} />
                      </div>
                    )}
                  </ModalButton>
                )}
                <ConfirmButton
                  label="Remove"
                  title="Remove this card provider?"
                  description="Bonded stops answering it. Set your provider to decline when there's no answer, or remove the address there too."
                  confirm="Remove"
                  act={() => gateApi.deleteCardHook(session, account.id, h.id)}
                  then={() =>
                    queryClient.invalidateQueries({ queryKey: hooksKey(session, account.id) })
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The older card route, where Bonded held a Stripe key and issued the cards. It's no longer set
 * up from here; an account already linked still sees its cards.
 */
function OlderStripeCards({ account, session }: { account: GateAccount; session: string }) {
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
  });
  if (!link.data) return null;
  return (
    <section aria-label="Cards Bonded issued" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Cards Bonded issued</h2>
          <p className="text-xs text-muted">
            The older Stripe route, with your Stripe key ({link.data.keyHint}). Unlink it to stop
            Bonded holding the key.
          </p>
        </div>
        <ConfirmButton
          label="Unlink"
          variant="outline"
          title="Unlink Stripe?"
          description="Bonded drops the key. Cards already issued are still checked on every charge."
          confirm="Unlink Stripe"
          act={() => gateApi.unlinkStripe(session, account.id)}
          then={() =>
            queryClient.invalidateQueries({ queryKey: ["gate-stripe", session, account.id] })
          }
        />
      </div>
      {cards.data && cards.data.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Invoice</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="hidden sm:table-cell">Card</TableHead>
              <TableHead>Status</TableHead>
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/**
 * Cards your agent pays with, in your own card program. The program asks Bonded before each
 * charge and Bonded answers approve or decline (apps/api/GATE.md, "Card hooks").
 */
export function Cards({ account, session }: { account: GateAccount; session: string }) {
  return (
    <div className="grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-8">
        <Hooks account={account} session={session} />
        <OlderStripeCards account={account} session={session} />
      </div>
      <aside aria-label="About cards" className="flex flex-col gap-4">
        <Facts
          items={[
            ["Can stop a charge", "Yes, it declines it"],
            ["Needs a key", "No"],
            ["Works with", "Stripe, Lithic, Marqeta"],
            ["Merchants allowed", "Vendors on file"],
          ]}
        />
        <p className="text-xs text-muted">
          Give a vendor its card merchant ID on the Vendors tab. Cash, money orders and gambling are
          always declined.
        </p>
      </aside>
    </div>
  );
}
