import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
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
import { gateApi, type GateAccount, type GateTicket, type GateVendor } from "../../lib/gate";
import { ModalActions, ResponsiveModal } from "../responsive-modal";
import { ErrorText, Loading, Unavailable } from "../ui";
import {
  ConfirmButton,
  Facts,
  ModalButton,
  Submit,
  TabBar,
  TextField,
  useAction,
  useVendors,
} from "./common";

/** A vendor id from its name: what agents send for a bank change. */
export const vendorId = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/** Add a vendor and its verified bank account to the vendor master. */
function VendorForm({
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
  const [name, setName] = useState("");
  const [bank, setBank] = useState("");
  const [merchant, setMerchant] = useState("");
  const [networkId, setNetworkId] = useState("");
  const id = vendorId(name);
  // A card merchant needs both its name and its id, or neither.
  const merchantOk =
    (!merchant.trim() && !networkId.trim()) ||
    (Boolean(merchant.trim()) && /^[A-Za-z0-9._-]{1,64}$/.test(networkId.trim()));
  const ready = Boolean(id && bank.trim() && merchantOk);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void action.run(async () => {
          await gateApi.addVendor(session, account.id, {
            id,
            name: name.trim(),
            account: bank.trim(),
            ...(merchant.trim()
              ? { cardMerchant: { name: merchant.trim(), networkId: networkId.trim() } }
              : {}),
          });
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["gate-vendors", session, account.id] }),
            queryClient.invalidateQueries({ queryKey: ["gate-accounts"] }),
          ]);
          close();
        });
      }}
    >
      <TextField
        label="Vendor"
        value={name}
        onChange={setName}
        placeholder="Nimbus Cloud"
        mono={false}
        hint={id ? `Its id is ${id}. Agents name it for a bank change.` : undefined}
      />
      <TextField
        label="Verified bank account"
        value={bank}
        onChange={setBank}
        placeholder="GB29 NWBK 6016 1331 9268 19"
        hint="The account you know is theirs. Payments to any other account break a rule."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Card merchant (optional)"
          value={merchant}
          onChange={setMerchant}
          placeholder="NIMBUS CLOUD"
          mono={false}
          hint="Its name on card charges."
        />
        <TextField
          label="Card merchant id"
          value={networkId}
          onChange={setNetworkId}
          placeholder="123456789012"
          hint="Any other merchant breaks a rule."
        />
      </div>
      <ErrorText error={action.error} />
      <ModalActions>
        <Button variant="ghost" type="button" onClick={close}>
          Cancel
        </Button>
        <Submit busy={action.busy} disabled={!ready}>
          Add vendor
        </Submit>
      </ModalActions>
    </form>
  );
}

/** A bank change finance verified out of band, for this vendor. */
function TicketForm({
  account,
  session,
  vendor,
  close,
}: {
  account: GateAccount;
  session: string;
  vendor: GateVendor;
  close: () => void;
}) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [ticket, setTicket] = useState("");
  const [bank, setBank] = useState("");
  const [verifiedBy, setVerifiedBy] = useState("");
  const ready = /^[A-Za-z0-9._:-]{1,64}$/.test(ticket.trim()) && bank.trim() && verifiedBy.trim();
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void action.run(async () => {
          await gateApi.addTicket(session, account.id, {
            id: ticket.trim(),
            vendorId: vendor.id,
            account: bank.trim(),
            verifiedBy: verifiedBy.trim(),
          });
          await queryClient.invalidateQueries({
            queryKey: ["gate-tickets", session, account.id],
          });
          close();
        });
      }}
    >
      <TextField label="Ticket" value={ticket} onChange={setTicket} placeholder="FIN-1" />
      <TextField
        label="New bank account"
        value={bank}
        onChange={setBank}
        placeholder="GB33 BUKB 2020 1555 5555 55"
      />
      <TextField
        label="Verified by"
        value={verifiedBy}
        onChange={setVerifiedBy}
        placeholder="Dana, called the number on file"
        mono={false}
      />
      <ErrorText error={action.error} />
      <ModalActions>
        <Button variant="ghost" type="button" onClick={close}>
          Cancel
        </Button>
        <Submit busy={action.busy} disabled={!ready}>
          Add ticket
        </Submit>
      </ModalActions>
    </form>
  );
}

/** One vendor: its verified account and its bank changes. */
function VendorDetail({
  account,
  session,
  vendor,
  tickets,
}: {
  account: GateAccount;
  session: string;
  vendor: GateVendor;
  tickets: GateTicket[];
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  if (adding)
    return (
      <TicketForm
        account={account}
        session={session}
        vendor={vendor}
        close={() => setAdding(false)}
      />
    );
  return (
    <div className="flex flex-col gap-6">
      <Facts
        items={[
          ["Verified account", <span className="font-mono text-[0.92em]">{vendor.account}</span>],
          ["Vendor id", <span className="font-mono text-[0.92em]">{vendor.id}</span>],
        ]}
      />
      <section aria-label="Bank changes" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold">Bank changes</h3>
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add a verified change
          </Button>
        </div>
        <p className="text-sm text-muted">
          Their account changes only with a ticket finance verified, say by calling a number you
          already had. Each ticket covers one change.
        </p>
        {tickets.length > 0 && (
          <ul className="flex flex-col divide-y divide-line">
            {tickets.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[0.92em]">{t.id}</span>
                  <span className="block truncate font-mono text-[0.92em] text-muted">
                    {t.account}
                  </span>
                </span>
                {t.usedBy ? (
                  <Badge variant="secondary">Used</Badge>
                ) : (
                  <>
                    <Badge variant="safe">Ready</Badge>
                    <ConfirmButton
                      label="Remove"
                      title={`Remove ticket ${t.id}?`}
                      description="The vendor's account can't change on this ticket any more."
                      confirm="Remove ticket"
                      act={() => gateApi.deleteTicket(session, account.id, t.id)}
                      then={() =>
                        queryClient.invalidateQueries({
                          queryKey: ["gate-tickets", session, account.id],
                        })
                      }
                    />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One vendor in the list. Pressing it opens the vendor. */
function VendorRow({
  account,
  session,
  vendor,
  tickets,
}: {
  account: GateAccount;
  session: string;
  vendor: GateVendor;
  tickets: GateTicket[];
}) {
  const [open, setOpen] = useState(false);
  const ready = tickets.filter((t) => !t.usedBy).length;
  return (
    <TableRow className="relative">
      <TableCell className="max-w-0">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="block w-full text-left outline-none after:absolute after:inset-0 focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          <span className="block truncate font-medium">{vendor.name}</span>
          <span className="block truncate font-mono text-[0.92em] text-muted md:hidden">
            {vendor.account}
          </span>
        </button>
        <ResponsiveModal open={open} onOpenChange={setOpen} title={vendor.name}>
          <VendorDetail account={account} session={session} vendor={vendor} tickets={tickets} />
        </ResponsiveModal>
      </TableCell>
      <TableCell className="hidden font-mono text-[0.92em] md:table-cell">
        {vendor.account}
      </TableCell>
      <TableCell className="hidden w-44 text-right md:table-cell">
        {ready > 0 && (
          <Badge variant="safe">
            {ready} bank {ready === 1 ? "change" : "changes"} ready
          </Badge>
        )}
      </TableCell>
      <TableCell className="w-8 text-muted">
        <ChevronRightIcon className="size-4" aria-hidden />
      </TableCell>
    </TableRow>
  );
}

/** The vendors an agent may pay. */
export function Vendors({ account, session }: { account: GateAccount; session: string }) {
  const vendors = useVendors(account, session);
  const tickets = useQuery({
    queryKey: ["gate-tickets", session, account.id],
    queryFn: () => gateApi.tickets(session, account.id),
    retry: false,
  });
  const add = (
    <ModalButton
      label={
        <>
          <PlusIcon aria-hidden />
          Add a vendor
        </>
      }
      title="Add a vendor"
      description="Payments to anyone not listed here break a rule."
    >
      {(close) => <VendorForm account={account} session={session} close={close} />}
    </ModalButton>
  );
  if (vendors.error) return <ErrorText error={vendors.error} />;
  if (!vendors.data) return <Loading what="vendors" />;
  return (
    <div className="flex flex-col gap-5">
      <TabBar action={add}>Who your agents may pay, and the account you know is theirs.</TabBar>
      {tickets.error && (
        <Unavailable error={tickets.error} onRetry={() => void tickets.refetch()} />
      )}
      {!vendors.data.items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No vendors yet</EmptyTitle>
            <EmptyDescription>Until you add one, every payee is unknown.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Vendor</TableHead>
              <TableHead className="hidden md:table-cell">Verified account</TableHead>
              <TableHead className="hidden w-44 md:table-cell">
                <span className="sr-only">Bank changes</span>
              </TableHead>
              <TableHead className="w-8">
                <span className="sr-only">Open</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vendors.data.items.map((v) => (
              <VendorRow
                key={v.id}
                account={account}
                session={session}
                vendor={v}
                tickets={(tickets.data?.items ?? []).filter((t) => t.vendorId === v.id)}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
