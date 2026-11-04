import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
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
import { dollars, gateApi, parseUsd, type GateAccount, type GateVendor } from "../../lib/gate";
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
  useVendors,
  vendorName,
} from "./common";

/** Approve an invoice for payment. */
function InvoiceForm({
  account,
  session,
  vendors,
  close,
}: {
  account: GateAccount;
  session: string;
  vendors: GateVendor[];
  close: () => void;
}) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [vendor, setVendor] = useState(vendors[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const amountUsd = parseUsd(amount);
  const ready = Boolean(vendor && reference.trim()) && amountUsd !== null;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void action.run(async () => {
          await gateApi.addInvoice(session, account.id, {
            vendorId: vendor,
            reference: reference.trim(),
            amountUsd,
          });
          await queryClient.invalidateQueries({
            queryKey: ["gate-invoices", session, account.id],
          });
          close();
        });
      }}
    >
      <SelectField
        label="Vendor"
        value={vendor}
        onChange={setVendor}
        options={vendors.map((v) => ({ value: v.id, label: v.name }))}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Invoice number"
          value={reference}
          onChange={setReference}
          placeholder="NIM-88412"
        />
        <TextField
          label="Amount"
          value={amount}
          onChange={setAmount}
          placeholder="612.40"
          inputMode="decimal"
          suffix="USD"
          error={amount && amountUsd === null ? "Enter an amount in dollars." : null}
        />
      </div>
      <ErrorText error={action.error} />
      <ModalActions>
        <Button variant="ghost" type="button" onClick={close}>
          Cancel
        </Button>
        <Submit busy={action.busy} disabled={!ready}>
          Approve
        </Submit>
      </ModalActions>
    </form>
  );
}

/** Invoices approved for payment: a payment needs one with its reference and amount. */
export function Invoices({ account, session }: { account: GateAccount; session: string }) {
  const queryClient = useQueryClient();
  const vendors = useVendors(account, session);
  const invoices = useQuery({
    queryKey: ["gate-invoices", session, account.id],
    queryFn: () => gateApi.invoices(session, account.id),
    retry: false,
  });
  const list = vendors.data?.items ?? [];
  const approve = list.length > 0 && (
    <ModalButton
      label={
        <>
          <PlusIcon aria-hidden />
          Approve an invoice
        </>
      }
      title="Approve an invoice"
      description="Your agent can then pay it, at this amount."
    >
      {(close) => <InvoiceForm account={account} session={session} vendors={list} close={close} />}
    </ModalButton>
  );
  return (
    <div className="flex flex-col gap-5">
      <TabBar action={approve}>
        A payment goes through only for an invoice approved here, at its amount.
      </TabBar>
      {invoices.error ? (
        <Unavailable error={invoices.error} onRetry={() => void invoices.refetch()} />
      ) : !invoices.data ? (
        <Loading what="invoices" />
      ) : !invoices.data.items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No invoices approved yet</EmptyTitle>
            {vendors.data && !list.length && (
              <EmptyDescription>Add a vendor first.</EmptyDescription>
            )}
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Vendor</TableHead>
              <TableHead className="hidden md:table-cell">Invoice</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>
                <span className="sr-only">Remove</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.data.items.map((i) => (
              <TableRow key={i.id}>
                <TableCell>
                  {vendorName(list, i.vendorId)}
                  <span className="block font-mono text-[0.92em] text-muted md:hidden">
                    {i.reference}
                  </span>
                </TableCell>
                <TableCell className="hidden font-mono text-[0.92em] md:table-cell">
                  {i.reference}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {dollars(i.amountCents / 100)}
                </TableCell>
                <TableCell className="w-24 text-right">
                  <ConfirmButton
                    label="Remove"
                    title={`Remove invoice ${i.reference}?`}
                    description="Your agent can't pay it any more."
                    confirm="Remove invoice"
                    act={() => gateApi.deleteInvoice(session, account.id, i.id)}
                    then={() =>
                      queryClient.invalidateQueries({
                        queryKey: ["gate-invoices", session, account.id],
                      })
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
