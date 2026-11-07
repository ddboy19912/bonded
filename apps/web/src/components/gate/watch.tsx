import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { Badge } from "@/components/shadcn/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/shadcn/empty";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/shadcn/field";
import { Switch } from "@/components/shadcn/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/shadcn/table";
import { ago, short } from "../../lib/format";
import { gateApi, type GateAccount, type GateWatchedPayment } from "../../lib/gate";
import { ModalActions } from "../responsive-modal";
import { ErrorText, Loading, Unavailable } from "../ui";
import {
  ChainLogo,
  ConfirmButton,
  Facts,
  ModalButton,
  SelectField,
  Submit,
  TextField,
  useAction,
} from "./common";

const usd = (amount: number) =>
  `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whether a payment with no check before it raises an alert. */
function ExpectChecks({ account, session }: { account: GateAccount; session: string }) {
  const id = useId();
  const queryClient = useQueryClient();
  const action = useAction();
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={id}>Expect a check first</FieldLabel>
          <FieldDescription className="text-xs">
            Alert me when a payment shows up that Bonded never checked.
          </FieldDescription>
        </FieldContent>
        <Switch
          id={id}
          checked={account.expectChecks}
          disabled={action.busy}
          onCheckedChange={(expectChecks) =>
            void action.run(async () => {
              await gateApi.updateAccount(session, account.id, { expectChecks });
              await queryClient.invalidateQueries({ queryKey: ["gate-accounts"] });
            })
          }
        />
      </Field>
      <ErrorText error={action.error} />
    </div>
  );
}

function WalletForm({
  account,
  session,
  chains,
  close,
}: {
  account: GateAccount;
  session: string;
  chains: { chainId: number; name: string; tokens: string[] }[];
  close: () => void;
}) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [chainId, setChainId] = useState(String(chains[0]!.chainId));
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  const tokens = chains.find((c) => String(c.chainId) === chainId)?.tokens.join(" and ");
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void action.run(async () => {
          await gateApi.addWallet(session, account.id, {
            chainId: Number(chainId),
            address: address.trim(),
            ...(label.trim() ? { label: label.trim() } : {}),
          });
          await queryClient.invalidateQueries({ queryKey: ["gate-wallets", session, account.id] });
          close();
        });
      }}
    >
      <SelectField
        label="Chain"
        value={chainId}
        onChange={setChainId}
        options={chains.map((c) => ({
          value: String(c.chainId),
          label: c.name,
          icon: <ChainLogo chainId={c.chainId} />,
        }))}
      />
      <TextField
        label="Wallet address"
        value={address}
        onChange={setAddress}
        placeholder="0x…"
        hint={`Public address only. Bonded reads ${tokens ?? "stablecoin"} payments from now on.`}
        error={address.trim() && !valid ? "Enter a 0x address." : null}
      />
      <TextField label="Label" value={label} onChange={setLabel} mono={false} />
      <ErrorText error={action.error} />
      <ModalActions>
        <Submit busy={action.busy} disabled={!valid}>
          Watch wallet
        </Submit>
      </ModalActions>
    </form>
  );
}

function Wallets({ account, session }: { account: GateAccount; session: string }) {
  const queryClient = useQueryClient();
  const chains = useQuery({
    queryKey: ["gate-watch-chains"],
    queryFn: () => gateApi.watchChains(),
    retry: false,
  });
  const wallets = useQuery({
    queryKey: ["gate-wallets", session, account.id],
    queryFn: () => gateApi.wallets(session, account.id),
    retry: false,
  });
  if (wallets.error)
    return <Unavailable error={wallets.error} onRetry={() => void wallets.refetch()} />;
  if (!wallets.data || !chains.data) return <Loading what="your wallets" />;
  const available = chains.data.items;
  return (
    <section aria-label="Wallets" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Wallets</h2>
        {available.length > 0 && (
          <ModalButton
            label={
              <>
                <PlusIcon aria-hidden />
                Watch a wallet
              </>
            }
            size="sm"
            title="Watch a wallet"
            description="Bonded needs no key. It reads what's public on chain."
          >
            {(close) => (
              <WalletForm account={account} session={session} chains={available} close={close} />
            )}
          </ModalButton>
        )}
      </div>
      {wallets.data.items.length === 0 ? (
        <Empty className="border border-dashed border-line">
          <EmptyHeader>
            <EmptyTitle>No wallets yet</EmptyTitle>
            <EmptyDescription>
              {available.length > 0
                ? "Add a public address to see what leaves it."
                : "Wallet watching isn't on yet."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {wallets.data.items.map((w) => (
            <li key={w.id} className="flex items-center gap-3 p-3">
              <ChainLogo chainId={w.chainId} className="size-8" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{w.label || short(w.address, 6)}</p>
                <p className="truncate text-xs text-muted">
                  {w.chain}
                  {w.label && (
                    <>
                      {" · "}
                      <span className="font-mono">{short(w.address, 6)}</span>
                    </>
                  )}
                </p>
              </div>
              <span className="hidden text-xs text-muted sm:block">
                {w.lastReadAt ? `Read ${ago(w.lastReadAt)}` : "Not read yet"}
              </span>
              <ConfirmButton
                label="Stop"
                title="Stop watching this wallet?"
                description="What Bonded already saw stays in the list."
                confirm="Stop watching"
                act={() => gateApi.deleteWallet(session, account.id, w.id)}
                then={() =>
                  queryClient.invalidateQueries({
                    queryKey: ["gate-wallets", session, account.id],
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What Bonded found: never "allowed", since it decided nothing before the money left. */
function Outcome({ payment }: { payment: GateWatchedPayment }) {
  if (payment.checkedFirst) return <Badge variant="safe">Checked first</Badge>;
  if (payment.reasons.length === 0) return <Badge variant="outline">No rule broken</Badge>;
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant="breach">Broke a rule</Badge>
      <span className="text-xs text-muted">{payment.reasons.map((r) => r.words).join("; ")}</span>
    </div>
  );
}

function Seen({ account, session }: { account: GateAccount; session: string }) {
  const seen = useQuery({
    queryKey: ["gate-watched", session, account.id],
    queryFn: () => gateApi.watched(session, account.id),
    retry: false,
  });
  if (seen.error) return <Unavailable error={seen.error} onRetry={() => void seen.refetch()} />;
  if (!seen.data) return <Loading what="the payments" />;
  return (
    <section aria-label="Payments seen" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Seen after they were paid</h2>
      {seen.data.items.length === 0 ? (
        <p className="text-sm text-muted">Nothing seen yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Paid</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead className="hidden xl:table-cell">To</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {seen.data.items.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-muted">{ago(p.paidAt)}</TableCell>
                <TableCell>{usd(p.amountUsd)}</TableCell>
                <TableCell className="hidden font-mono text-xs xl:table-cell">
                  {short(p.payee, 6)}
                </TableCell>
                <TableCell>
                  <Outcome payment={p} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** Payments Bonded reads after they're made. It can alert here, but it can't stop them. */
export function Watch({ account, session }: { account: GateAccount; session: string }) {
  return (
    <div className="grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-8">
        <Wallets account={account} session={session} />
        <Seen account={account} session={session} />
      </div>
      <aside aria-label="About Watch" className="flex flex-col gap-4">
        <ExpectChecks account={account} session={session} />
        <Facts
          items={[
            ["Can stop a payment", "No, it alerts you"],
            ["Needs a key", "No"],
            ["Sees", "USDC and USDT only"],
          ]}
        />
      </aside>
    </div>
  );
}
