import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyBlock } from "../components/copy";
import { ago } from "../lib/format";
import { dollars, gateApi, parseUsd, type GateAccount, type GateVendor } from "../lib/gate";
import {
  Badge,
  Button,
  Callout,
  Card,
  Choice,
  ErrorText,
  Input,
  Loading,
  Note,
  Select,
  Switch,
  Table,
  Unavailable,
} from "../components/ui";

/**
 * Setting a gate account up from the rules page (/gate): a new account, its mode and limits, its
 * vendors, approved invoices, verified bank-change tickets, its agents' API keys and its link to
 * Stripe for the card route. Each form calls one owner route (apps/api/GATE.md, "Routes") and
 * refreshes what it changed.
 */

/** A form's submit: runs it, keeps its error, and says while it's busy. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (act: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await act();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** A vendor id from its name: what agents send for a bank change. */
export const vendorId = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/** A new API key, shown once. */
export function KeyOnce({ apiKey }: { apiKey: string }) {
  return (
    <Callout tone="safe" title="Your agent's API key">
      <p className="mb-3">
        Copy it now. It isn't shown again. Your agent sends it to POST /payments/check before each
        payment.
      </p>
      <CopyBlock label="API key" text={apiKey} language="sh" />
    </Callout>
  );
}

const MODES: { mode: GateAccount["mode"]; title: string; words: string }[] = [
  {
    mode: "monitor",
    title: "Monitor",
    words: "Payments that break a rule go through and are logged.",
  },
  { mode: "enforce", title: "Enforce", words: "Payments that break a rule are blocked." },
];

function ModeChoice({
  mode,
  onChange,
  disabled = false,
}: {
  mode: GateAccount["mode"];
  onChange: (mode: GateAccount["mode"]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2" aria-label="Mode">
      {MODES.map((m) => (
        <Choice
          key={m.mode}
          name="gate-mode"
          checked={mode === m.mode}
          onChange={() => onChange(m.mode)}
          title={m.title}
          disabled={disabled}
        >
          {m.words}
        </Choice>
      ))}
    </fieldset>
  );
}

/** Make a gate account: its limits and mode. Its first API key goes to `onMade`. */
export function NewAccount({
  session,
  onMade,
  onCancel,
}: {
  session: string;
  onMade: (accountId: string, apiKey: string) => void;
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [perPayment, setPerPayment] = useState("");
  const [perDay, setPerDay] = useState("");
  const [mode, setMode] = useState<GateAccount["mode"]>("monitor");
  const [freeze, setFreeze] = useState(false);
  const [touched, setTouched] = useState(false);
  const action = useAction();
  const maxPaymentUsd = parseUsd(perPayment);
  const maxDailyUsd = parseUsd(perDay);
  const submit = () => {
    setTouched(true);
    if (maxPaymentUsd === null || maxDailyUsd === null) return;
    void action.run(async () => {
      const made = await gateApi.createAccount(session, {
        ...(name.trim() ? { name: name.trim() } : {}),
        mode,
        maxPaymentUsd,
        maxDailyUsd,
        freezeOnBreach: freeze,
      });
      await queryClient.invalidateQueries({ queryKey: ["gate-accounts"] });
      onMade(made.account.id, made.apiKey.key);
    });
  };
  return (
    <Card
      title="New gate account"
      description="One per business or team. Your agents check every payment against it."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          label="Name"
          value={name}
          onChange={setName}
          placeholder="Acme payables"
          mono={false}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Most for one payment"
            value={perPayment}
            onChange={setPerPayment}
            placeholder="5000"
            inputMode="decimal"
            suffix="USD"
            error={touched && maxPaymentUsd === null ? "Enter an amount in dollars." : null}
          />
          <Input
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
        <Switch
          checked={freeze}
          onChange={() => setFreeze((f) => !f)}
          label="Freeze after a breach"
          description="Refuse every check after a rule is broken, until you lift it."
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" loading={action.busy}>
            Make the account
          </Button>
          {onCancel && (
            <Button kind="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        <ErrorText error={action.error} />
      </form>
    </Card>
  );
}

/** The account's mode, limits and freeze, each changed in place. */
export function Settings({ account, session }: { account: GateAccount; session: string }) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [perPayment, setPerPayment] = useState(String(account.maxPaymentUsd));
  const [perDay, setPerDay] = useState(String(account.maxDailyUsd));
  const maxPaymentUsd = parseUsd(perPayment);
  const maxDailyUsd = parseUsd(perDay);
  const changed = maxPaymentUsd !== account.maxPaymentUsd || maxDailyUsd !== account.maxDailyUsd;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["gate-accounts"] });
  const update = (patch: Parameters<typeof gateApi.updateAccount>[2]) =>
    void action.run(async () => {
      await gateApi.updateAccount(session, account.id, patch);
      await refresh();
    });
  return (
    <Card title="Settings" description="Each change is a new version of the rules.">
      <div className="flex flex-col gap-4">
        {account.frozen && (
          <Note tone="breach" title="Frozen" role="status">
            <p className="mb-2">
              A breach froze this account. Every check is refused until you lift it.
            </p>
            <Button
              size="sm"
              kind="secondary"
              loading={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await gateApi.unfreeze(session, account.id);
                  await refresh();
                })
              }
            >
              Lift the freeze
            </Button>
          </Note>
        )}
        <ModeChoice
          mode={account.mode}
          disabled={action.busy}
          onChange={(mode) => mode !== account.mode && update({ mode })}
        />
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (maxPaymentUsd !== null && maxDailyUsd !== null)
              update({ maxPaymentUsd, maxDailyUsd });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Most for one payment"
              value={perPayment}
              onChange={setPerPayment}
              inputMode="decimal"
              suffix="USD"
              error={maxPaymentUsd === null ? "Enter an amount in dollars." : null}
            />
            <Input
              label="Most in one day"
              value={perDay}
              onChange={setPerDay}
              inputMode="decimal"
              suffix="USD"
              error={maxDailyUsd === null ? "Enter an amount in dollars." : null}
            />
          </div>
          <div>
            <Button
              type="submit"
              size="sm"
              kind="secondary"
              loading={action.busy}
              disabled={!changed || maxPaymentUsd === null || maxDailyUsd === null}
            >
              Save limits
            </Button>
          </div>
        </form>
        <Switch
          checked={account.freezeOnBreach}
          disabled={action.busy}
          onChange={() => update({ freezeOnBreach: !account.freezeOnBreach })}
          label="Freeze after a breach"
          description="Refuse every check after a rule is broken, until you lift it."
        />
        <ErrorText error={action.error} />
      </div>
    </Card>
  );
}

/** A collapsed form: a button that opens it. */
function Adder({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <div className="mt-4 rounded-2xl border border-line p-4">{children(() => setOpen(false))}</div>
  ) : (
    <div className="mt-4">
      <Button size="sm" kind="secondary" onClick={() => setOpen(true)}>
        {label}
      </Button>
    </div>
  );
}

/** Add a vendor and its verified bank account to the vendor master. */
export function AddVendor({ account, session }: { account: GateAccount; session: string }) {
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
  return (
    <Adder label="Add a vendor">
      {(close) => (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!id || !bank.trim() || !merchantOk) return;
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
              setName("");
              setBank("");
              setMerchant("");
              setNetworkId("");
              close();
            });
          }}
        >
          <Input
            label="Vendor"
            value={name}
            onChange={setName}
            placeholder="Nimbus Cloud"
            mono={false}
            hint={id ? `Its id is ${id}. Agents name it for a bank change.` : undefined}
          />
          <Input
            label="Verified bank account"
            value={bank}
            onChange={setBank}
            placeholder="GB29 NWBK 6016 1331 9268 19"
            hint="The account you know is theirs. Payments to any other account break a rule."
          />
          <Input
            label="Card merchant (optional)"
            value={merchant}
            onChange={setMerchant}
            placeholder="NIMBUS CLOUD"
            mono={false}
            hint="Only for paying this vendor by card: its name on card charges."
          />
          <Input
            label="Card merchant id"
            value={networkId}
            onChange={setNetworkId}
            placeholder="123456789012"
            hint="The merchant's network id. A charge from any other merchant breaks a rule."
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              loading={action.busy}
              disabled={!id || !bank.trim() || !merchantOk}
            >
              Add vendor
            </Button>
            <Button size="sm" kind="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
          <ErrorText error={action.error} />
        </form>
      )}
    </Adder>
  );
}

/** The vendor master, shared with the Rules card through the query cache. */
function useVendors(account: GateAccount, session: string) {
  return useQuery({
    queryKey: ["gate-vendors", session, account.id],
    queryFn: () => gateApi.vendors(session, account.id),
    retry: false,
  });
}

const vendorOptions = (vendors: GateVendor[]) =>
  vendors.map((v) => ({ value: v.id, label: v.name }));
const vendorName = (vendors: GateVendor[], id: string) =>
  vendors.find((v) => v.id === id)?.name ?? id;

/** Invoices approved for payment: a payment needs one with its reference and amount. */
export function Invoices({ account, session }: { account: GateAccount; session: string }) {
  const queryClient = useQueryClient();
  const vendors = useVendors(account, session);
  const invoices = useQuery({
    queryKey: ["gate-invoices", session, account.id],
    queryFn: () => gateApi.invoices(session, account.id),
    retry: false,
  });
  const action = useAction();
  const [vendor, setVendor] = useState("");
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState("");
  const amountUsd = parseUsd(amount);
  const list = vendors.data?.items ?? [];
  const chosen = vendor || list[0]?.id || "";
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["gate-invoices", session, account.id] });
  return (
    <Card
      title="Approved invoices"
      description="A payment goes through only for an invoice approved here, at its amount."
    >
      {invoices.error ? (
        <Unavailable error={invoices.error} onRetry={() => void invoices.refetch()} />
      ) : !invoices.data ? (
        <Loading what="invoices" />
      ) : !invoices.data.items.length ? (
        <p className="text-sm text-muted">No invoices approved yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Reference</th>
              <th>Amount</th>
              <th>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invoices.data.items.map((i) => (
              <tr key={i.id}>
                <td>{vendorName(list, i.vendorId)}</td>
                <td className="font-mono text-[0.92em]">{i.reference}</td>
                <td>{dollars(i.amountCents / 100)}</td>
                <td className="text-right">
                  <Button
                    size="sm"
                    kind="ghost"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await gateApi.deleteInvoice(session, account.id, i.id);
                        await refresh();
                      })
                    }
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {vendors.data && !list.length ? (
        <p className="mt-4 text-sm text-muted">Add a vendor first.</p>
      ) : (
        list.length > 0 && (
          <Adder label="Approve an invoice">
            {(close) => (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!chosen || !reference.trim() || amountUsd === null) return;
                  void action.run(async () => {
                    await gateApi.addInvoice(session, account.id, {
                      vendorId: chosen,
                      reference: reference.trim(),
                      amountUsd,
                    });
                    await refresh();
                    setReference("");
                    setAmount("");
                    close();
                  });
                }}
              >
                <Select
                  label="Vendor"
                  value={chosen}
                  onChange={setVendor}
                  options={vendorOptions(list)}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="Invoice number"
                    value={reference}
                    onChange={setReference}
                    placeholder="NIM-88412"
                  />
                  <Input
                    label="Amount"
                    value={amount}
                    onChange={setAmount}
                    placeholder="612.40"
                    inputMode="decimal"
                    suffix="USD"
                    error={amount && amountUsd === null ? "Enter an amount in dollars." : null}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    loading={action.busy}
                    disabled={!reference.trim() || amountUsd === null}
                  >
                    Approve
                  </Button>
                  <Button size="sm" kind="ghost" onClick={close}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </Adder>
        )
      )}
      <div className="mt-3">
        <ErrorText error={action.error} />
      </div>
    </Card>
  );
}

/** Bank changes finance verified out of band: the only way a vendor's account may change. */
export function Tickets({ account, session }: { account: GateAccount; session: string }) {
  const queryClient = useQueryClient();
  const vendors = useVendors(account, session);
  const tickets = useQuery({
    queryKey: ["gate-tickets", session, account.id],
    queryFn: () => gateApi.tickets(session, account.id),
    retry: false,
  });
  const action = useAction();
  const [ticket, setTicket] = useState("");
  const [vendor, setVendor] = useState("");
  const [bank, setBank] = useState("");
  const [verifiedBy, setVerifiedBy] = useState("");
  const list = vendors.data?.items ?? [];
  const chosen = vendor || list[0]?.id || "";
  const ready = /^[A-Za-z0-9._:-]{1,64}$/.test(ticket.trim()) && bank.trim() && verifiedBy.trim();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["gate-tickets", session, account.id] });
  return (
    <Card
      title="Bank changes"
      description="A vendor's account changes only with a ticket finance verified, say by calling the vendor on a number you already had. Each ticket covers one change."
    >
      {tickets.error ? (
        <Unavailable error={tickets.error} onRetry={() => void tickets.refetch()} />
      ) : !tickets.data ? (
        <Loading what="tickets" />
      ) : !tickets.data.items.length ? (
        <p className="text-sm text-muted">No verified bank changes.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Ticket</th>
              <th>Vendor</th>
              <th>New account</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tickets.data.items.map((t) => (
              <tr key={t.id}>
                <td className="font-mono text-[0.92em]">{t.id}</td>
                <td>{vendorName(list, t.vendorId)}</td>
                <td className="font-mono text-[0.92em]">{t.account}</td>
                <td>{t.usedBy ? <Badge>Used</Badge> : <Badge tone="safe">Ready</Badge>}</td>
                <td className="text-right">
                  {!t.usedBy && (
                    <Button
                      size="sm"
                      kind="ghost"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await gateApi.deleteTicket(session, account.id, t.id);
                          await refresh();
                        })
                      }
                    >
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {vendors.data && !list.length ? (
        <p className="mt-4 text-sm text-muted">Add a vendor first.</p>
      ) : (
        list.length > 0 && (
          <Adder label="Add a verified change">
            {(close) => (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!chosen || !ready) return;
                  void action.run(async () => {
                    await gateApi.addTicket(session, account.id, {
                      id: ticket.trim(),
                      vendorId: chosen,
                      account: bank.trim(),
                      verifiedBy: verifiedBy.trim(),
                    });
                    await refresh();
                    setTicket("");
                    setBank("");
                    setVerifiedBy("");
                    close();
                  });
                }}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input label="Ticket" value={ticket} onChange={setTicket} placeholder="FIN-1" />
                  <Select
                    label="Vendor"
                    value={chosen}
                    onChange={setVendor}
                    options={vendorOptions(list)}
                  />
                </div>
                <Input
                  label="New bank account"
                  value={bank}
                  onChange={setBank}
                  placeholder="GB33 BUKB 2020 1555 5555 55"
                />
                <Input
                  label="Verified by"
                  value={verifiedBy}
                  onChange={setVerifiedBy}
                  placeholder="Dana, called the number on file"
                  mono={false}
                />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" loading={action.busy} disabled={!ready}>
                    Add ticket
                  </Button>
                  <Button size="sm" kind="ghost" onClick={close}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </Adder>
        )
      )}
      <div className="mt-3">
        <ErrorText error={action.error} />
      </div>
    </Card>
  );
}

/** The agents' API keys: make one (shown once) or revoke one. */
export function Keys({ account, session }: { account: GateAccount; session: string }) {
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: ["gate-keys", session, account.id],
    queryFn: () => gateApi.keys(session, account.id),
    retry: false,
  });
  const action = useAction();
  const [label, setLabel] = useState("");
  const [made, setMade] = useState<string>();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["gate-keys", session, account.id] });
  return (
    <Card
      title="API keys"
      description="Your agents check payments with these. Revoking one stops it at once."
    >
      {made && (
        <div className="mb-4">
          <KeyOnce apiKey={made} />
        </div>
      )}
      {keys.error ? (
        <Unavailable error={keys.error} onRetry={() => void keys.refetch()} />
      ) : !keys.data ? (
        <Loading what="API keys" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Label</th>
              <th>Last used</th>
              <th>
                <span className="sr-only">Revoke</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.data.items.map((k) => (
              <tr key={k.id}>
                <td className="font-mono text-[0.92em]">{k.prefix}…</td>
                <td>{k.label || <span className="text-muted">None</span>}</td>
                <td className="whitespace-nowrap text-muted">
                  {k.lastUsedAt ? ago(k.lastUsedAt) : "Never"}
                </td>
                <td className="text-right">
                  {k.revokedAt ? (
                    <Badge>Revoked</Badge>
                  ) : (
                    <Button
                      size="sm"
                      kind="danger"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await gateApi.revokeKey(session, account.id, k.id);
                          await refresh();
                        })
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Adder label="New key">
        {(close) => (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const key = await gateApi.createKey(session, account.id, label.trim());
                setMade(key.key);
                await refresh();
                setLabel("");
                close();
              });
            }}
          >
            <Input
              label="Label"
              value={label}
              onChange={setLabel}
              placeholder="Payables agent"
              mono={false}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" loading={action.busy}>
                Make key
              </Button>
              <Button size="sm" kind="ghost" onClick={close}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Adder>
      <div className="mt-3">
        <ErrorText error={action.error} />
      </div>
    </Card>
  );
}

const STRIPE_KEY = /^(rk|sk)_test_[A-Za-z0-9]{10,247}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=_-]{10,200}$/;

/**
 * The card route: link a Stripe test account and the gate decides every charge on the single-use
 * cards it issues (apps/api/GATE.md, "The card route"). The key goes straight to the API, which
 * stores it encrypted; only a hint of it ever comes back.
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
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["gate-stripe", session, account.id] });
  return (
    <Card
      title="Card payments"
      description="Link Stripe and your agent pays approved invoices with single-use cards. Stripe asks the gate before every charge, so a charge that breaks a rule is declined. Test mode only."
    >
      {link.error ? (
        <Unavailable error={link.error} onRetry={() => void link.refetch()} />
      ) : link.data === undefined ? (
        <Loading what="the Stripe link" />
      ) : link.data ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <Badge tone="safe">Linked</Badge>
            <span className="font-mono text-[0.92em]">{link.data.keyHint}</span>
            <span className="font-mono text-[0.92em] text-muted">{link.data.cardholderId}</span>
            <Button
              size="sm"
              kind="ghost"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await gateApi.unlinkStripe(session, account.id);
                  await refresh();
                })
              }
            >
              Unlink
            </Button>
          </div>
          {cards.error ? (
            <Unavailable error={cards.error} onRetry={() => void cards.refetch()} />
          ) : !cards.data ? (
            <Loading what="cards" />
          ) : !cards.data.items.length ? (
            <p className="text-sm text-muted">
              No cards yet. Your agent asks for one with POST /payments/intents.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Amount</th>
                  <th>Card</th>
                  <th>Status</th>
                  <th>Issued</th>
                </tr>
              </thead>
              <tbody>
                {cards.data.items.map((c) => (
                  <tr key={c.id}>
                    <td className="font-mono text-[0.92em]">{c.invoiceReference}</td>
                    <td>{dollars(c.amountUsd)}</td>
                    <td className="font-mono text-[0.92em]">
                      {c.card ? `•••• ${c.card.last4}` : "—"}
                    </td>
                    <td>
                      <Badge>{c.status}</Badge>
                    </td>
                    <td className="text-muted">{ago(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
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
              await refresh();
              setKey("");
              setCardholder("");
              setAuthorization("");
              setEvents("");
            });
          }}
        >
          <Input
            label="Restricted key"
            type="password"
            value={key}
            onChange={setKey}
            placeholder="rk_test_..."
            hint="Test mode. Stored encrypted and never shown again."
          />
          <Input
            label="Cardholder"
            value={cardholder}
            onChange={setCardholder}
            placeholder="ich_..."
            hint="The Stripe cardholder the cards are issued to."
          />
          <Input
            label="Authorization webhook secret"
            type="password"
            value={authorization}
            onChange={setAuthorization}
            placeholder="whsec_..."
            hint="From Stripe's real-time authorizations endpoint."
          />
          <Input
            label="Events webhook secret"
            type="password"
            value={events}
            onChange={setEvents}
            placeholder="whsec_..."
            hint="From the webhook endpoint for Issuing events."
          />
          <div>
            <Button type="submit" size="sm" loading={action.busy} disabled={!ready}>
              Link Stripe
            </Button>
          </div>
        </form>
      )}
      <ErrorText error={action.error} />
    </Card>
  );
}
