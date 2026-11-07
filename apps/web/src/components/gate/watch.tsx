import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { Badge } from "@/components/shadcn/badge";
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
  ConfirmButton,
  ModalButton,
  SelectField,
  Submit,
  TabBar,
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
    <div className="flex flex-col gap-2">
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
        options={chains.map((c) => ({ value: String(c.chainId), label: c.name }))}
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
      <TabBar
        action={
          available.length > 0 && (
            <ModalButton
              label={
                <>
                  <PlusIcon aria-hidden />
                  Watch a wallet
                </>
              }
              title="Watch a wallet"
              description="Bonded needs no key. It reads what's public on chain."
            >
              {(close) => (
                <WalletForm account={account} session={session} chains={available} close={close} />
              )}
            </ModalButton>
          )
        }
      >
        <h2 className="text-sm font-semibold">Wallets</h2>
      </TabBar>
      {available.length === 0 && (
        <p className="text-xs text-muted">Wallet watching isn't on yet.</p>
      )}
      {wallets.data.items.length === 0 ? (
        <p className="text-sm text-muted">No wallets yet.</p>
      ) : (
        <Table>
          <TableBody>
            {wallets.data.items.map((w) => (
              <TableRow key={w.id}>
                <TableCell>
                  <span className="font-mono text-xs">{short(w.address, 6)}</span>
                  {w.label && <span className="ml-2 text-muted">{w.label}</span>}
                </TableCell>
                <TableCell className="text-muted">{w.chain}</TableCell>
                <TableCell className="hidden text-muted sm:table-cell">
                  {w.lastReadAt ? `Read ${ago(w.lastReadAt)}` : "Not read yet"}
                </TableCell>
                <TableCell className="text-right">
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
              <TableHead className="hidden sm:table-cell">To</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {seen.data.items.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="text-muted">{ago(p.paidAt)}</TableCell>
                <TableCell>{usd(p.amountUsd)}</TableCell>
                <TableCell className="hidden font-mono text-xs sm:table-cell">
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
    <div className="flex flex-col gap-8">
      <p className="text-sm text-muted">
        Bonded sees these after they're paid. It can alert you, but it can't stop them.
      </p>
      <ExpectChecks account={account} session={session} />
      <Wallets account={account} session={session} />
      <Seen account={account} session={session} />
    </div>
  );
}
