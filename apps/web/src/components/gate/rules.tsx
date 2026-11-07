import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/shadcn/field";
import { RadioGroup, RadioGroupItem } from "@/components/shadcn/radio-group";
import { Switch } from "@/components/shadcn/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/shadcn/table";
import { deployment, explorerUrl } from "../../config";
import { ago, txUrl } from "../../lib/format";
import { gateApi, parseUsd, type AnchorPost, type GateAccount } from "../../lib/gate";
import { ModalActions } from "../responsive-modal";
import { ErrorText, Loading, Unavailable, linkClass } from "../ui";
import { Facts, HashText, ModalButton, Submit, TextField, limit, useAction } from "./common";

const MODES: { mode: GateAccount["mode"]; title: string; words: string }[] = [
  {
    mode: "monitor",
    title: "Monitor",
    words: "Payments that break a rule go through and are logged.",
  },
  { mode: "enforce", title: "Enforce", words: "Payments that break a rule are blocked." },
];

/** Monitor or enforce, as two options with what each does. */
export function ModeChoice({
  mode,
  onChange,
}: {
  mode: GateAccount["mode"];
  onChange: (mode: GateAccount["mode"]) => void;
}) {
  const id = useId();
  return (
    <RadioGroup
      aria-label="Mode"
      value={mode}
      onValueChange={(m) => onChange(m as GateAccount["mode"])}
      className="grid gap-2 sm:grid-cols-2"
    >
      {MODES.map((m) => (
        <FieldLabel
          key={m.mode}
          htmlFor={`${id}-${m.mode}`}
          className="rounded-xl! has-data-[state=checked]:border-accent/60! has-data-[state=checked]:bg-accent-soft!"
        >
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>{m.title}</FieldTitle>
              <FieldDescription className="text-xs">{m.words}</FieldDescription>
            </FieldContent>
            <RadioGroupItem id={`${id}-${m.mode}`} value={m.mode} />
          </Field>
        </FieldLabel>
      ))}
    </RadioGroup>
  );
}

/** The freeze setting, on or off. */
export function FreezeSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>Freeze after a breach</FieldLabel>
        <FieldDescription className="text-xs">
          Refuse every check after a rule is broken, until you lift it.
        </FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Field>
  );
}

/** Whether every payment needs an approved invoice, on or off. */
function InvoiceSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>Match invoices</FieldLabel>
        <FieldDescription className="text-xs">
          Every payment needs an approved invoice. Turn off if yours have none.
        </FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Field>
  );
}

/** A whole number above zero, or null; empty is "no limit". */
const parseCount = (value: string) => (/^[1-9]\d{0,6}$/.test(value.trim()) ? Number(value) : null);

/** Change the mode, limits and freeze together: one save is one new version of the rules. */
function RulesForm({
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
  const [mode, setMode] = useState(account.mode);
  const [perPayment, setPerPayment] = useState(String(account.maxPaymentUsd));
  const [perDay, setPerDay] = useState(String(account.maxDailyUsd));
  const [freeze, setFreeze] = useState(account.freezeOnBreach);
  const [matching, setMatching] = useState(account.invoiceMatching);
  const [perHour, setPerHour] = useState(account.maxPaymentsPerHour?.toString() ?? "");
  const maxPaymentUsd = parseUsd(perPayment);
  const maxDailyUsd = parseUsd(perDay);
  const noHourLimit = perHour.trim() === "";
  const maxPaymentsPerHour = noHourLimit ? null : parseCount(perHour);
  const hourOk = noHourLimit || maxPaymentsPerHour !== null;
  const patch = {
    ...(mode !== account.mode ? { mode } : {}),
    ...(maxPaymentUsd !== null && maxPaymentUsd !== account.maxPaymentUsd ? { maxPaymentUsd } : {}),
    ...(maxDailyUsd !== null && maxDailyUsd !== account.maxDailyUsd ? { maxDailyUsd } : {}),
    ...(freeze !== account.freezeOnBreach ? { freezeOnBreach: freeze } : {}),
    ...(matching !== account.invoiceMatching ? { invoiceMatching: matching } : {}),
    ...(hourOk && maxPaymentsPerHour !== account.maxPaymentsPerHour ? { maxPaymentsPerHour } : {}),
  };
  const ready =
    maxPaymentUsd !== null && maxDailyUsd !== null && hourOk && Object.keys(patch).length > 0;
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void action.run(async () => {
          await gateApi.updateAccount(session, account.id, patch);
          await queryClient.invalidateQueries({ queryKey: ["gate-accounts"] });
          close();
        });
      }}
    >
      <ModeChoice mode={mode} onChange={setMode} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Most for one payment"
          value={perPayment}
          onChange={setPerPayment}
          inputMode="decimal"
          suffix="USD"
          error={maxPaymentUsd === null ? "Enter an amount in dollars." : null}
        />
        <TextField
          label="Most in one day"
          value={perDay}
          onChange={setPerDay}
          inputMode="decimal"
          suffix="USD"
          error={maxDailyUsd === null ? "Enter an amount in dollars." : null}
        />
      </div>
      <InvoiceSwitch checked={matching} onChange={setMatching} />
      {!matching && (
        <TextField
          label="Most payments in one hour"
          value={perHour}
          onChange={setPerHour}
          inputMode="numeric"
          hint="Leave empty for no limit."
          error={hourOk ? null : "Enter a whole number."}
        />
      )}
      <FreezeSwitch checked={freeze} onChange={setFreeze} />
      <ErrorText error={action.error} />
      <ModalActions>
        <Button variant="ghost" onClick={close} type="button">
          Cancel
        </Button>
        <Submit busy={action.busy} disabled={!ready}>
          Save changes
        </Submit>
      </ModalActions>
    </form>
  );
}

/** The button in the account's header that opens the rules form. */
export function EditRules({ account, session }: { account: GateAccount; session: string }) {
  return (
    <ModalButton
      label="Edit rules"
      variant="outline"
      title="Edit rules"
      description="Each save is a new version of the rules."
    >
      {(close) => <RulesForm account={account} session={session} close={close} />}
    </ModalButton>
  );
}

/** Where a hash is on chain: its transaction, "Posted", or "Not yet". */
function OnChain({ posted }: { posted: AnchorPost | null }) {
  if (!posted) return <span className="text-muted">Not yet</span>;
  if (posted.txHash && posted.chainId === deployment.chainId && explorerUrl)
    return (
      <a className={linkClass} href={txUrl(posted.txHash)} target="_blank" rel="noreferrer">
        Posted
      </a>
    );
  return <Badge variant="safe">Posted</Badge>;
}

/** Each version of the rules, with its hash and where it's posted. */
function Versions({ account, session }: { account: GateAccount; session: string }) {
  const versions = useQuery({
    queryKey: ["gate-mandates", session, account.id, account.mandate.version],
    queryFn: () => gateApi.mandates(session, account.id),
    retry: false,
  });
  if (versions.error)
    return <Unavailable error={versions.error} onRetry={() => void versions.refetch()} />;
  if (!versions.data) return <Loading what="the history" />;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Version</TableHead>
          <TableHead className="hidden sm:table-cell">When</TableHead>
          <TableHead>Hash</TableHead>
          <TableHead>On chain</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.data.items.map((v) => (
          <TableRow key={v.version}>
            <TableCell>{v.version}</TableCell>
            <TableCell className="hidden text-muted sm:table-cell">{ago(v.createdAt)}</TableCell>
            <TableCell>
              <HashText hash={v.hash} />
            </TableCell>
            <TableCell>
              <OnChain posted={v.posted} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The rules in plain words, then the setup they come from. */
export function Rules({ account, session }: { account: GateAccount; session: string }) {
  const hourly: [string, number | string][] = account.invoiceMatching
    ? []
    : [["Most payments in one hour", account.maxPaymentsPerHour ?? "No limit"]];
  return (
    <div className="grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-label="Rules">
        <p className="text-sm text-muted">Every payment is checked against these.</p>
        <ul className="mt-4 flex flex-col gap-3 text-[15px]">
          {account.rules.map((r) => (
            <li key={r} className="flex items-start gap-3">
              <CheckIcon className="mt-1 size-4 shrink-0 text-accent" aria-hidden />
              {r}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Setup" className="flex flex-col gap-3">
        <Facts
          items={[
            ["Mode", account.mode === "enforce" ? "Enforce" : "Monitor"],
            ["Most for one payment", limit(account.maxPaymentUsd)],
            ["Most in one day", limit(account.maxDailyUsd)],
            ["Match invoices", account.invoiceMatching ? "On" : "Off"],
            ...hourly,
            ["Freeze after a breach", account.freezeOnBreach ? "On" : "Off"],
            ["Version", account.mandate.version],
            ["Hash", <HashText hash={account.mandate.hash} />],
          ]}
        />
        <div>
          <ModalButton
            label="Version history"
            variant="link"
            size="sm"
            className="px-0"
            title="Version history"
            description="Each version of the rules, with its hash."
            wide
          >
            {() => <Versions account={account} session={session} />}
          </ModalButton>
        </div>
      </section>
    </div>
  );
}
