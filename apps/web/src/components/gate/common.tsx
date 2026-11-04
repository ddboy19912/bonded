import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/shadcn/badge";
import { Button } from "@/components/shadcn/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/shadcn/select";
import { Spinner } from "@/components/shadcn/spinner";
import { cn } from "@/lib/utils";
import { SecretOnce, CopyButton } from "../copy";
import { ModalActions, ResponsiveModal } from "../responsive-modal";
import { ErrorText } from "../ui";
import { short } from "../../lib/format";
import { gateApi, type GateAccount, type GateVendor } from "../../lib/gate";

/** What the gate page's tabs share: its forms' plumbing and the pieces they're built from. */

/** A form's submit: runs it, keeps its error, and says while it's busy. */
export function useAction() {
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
  return { busy, error, run, reset: () => setError(null) };
}

/** The vendor master, shared by the tabs through the query cache. */
export function useVendors(account: GateAccount, session: string) {
  return useQuery({
    queryKey: ["gate-vendors", session, account.id],
    queryFn: () => gateApi.vendors(session, account.id),
    retry: false,
  });
}

export const vendorName = (vendors: GateVendor[], id: string) =>
  vendors.find((v) => v.id === id)?.name ?? id;

/** A limit: $5,000, with cents only when it has them. */
export const limit = (usd: number) =>
  `$${usd.toLocaleString("en-US", { minimumFractionDigits: usd % 1 ? 2 : 0 })}`;

/** Is the account stopped, blocking, or only watching? */
export function AccountStatus({ account }: { account: GateAccount }) {
  if (account.frozen) return <Badge variant="breach">Frozen</Badge>;
  return account.mode === "enforce" ? (
    <Badge variant="brand">Enforcing</Badge>
  ) : (
    <Badge variant="warn">Monitoring</Badge>
  );
}

/** A hash in short form, with a button to copy it whole. */
export function HashText({ hash }: { hash: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-[0.92em]" title={hash}>
        {short(hash, 6)}
      </span>
      <CopyButton text={hash} variant="icon" />
    </span>
  );
}

/** A tab's first line: what it's for, and its main action. */
export function TabBar({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <p className="min-w-0 flex-1 basis-64 text-sm text-muted">{children}</p>
      {action}
    </div>
  );
}

/** Labels and values, one to a line. */
export function Facts({ items }: { items: [label: ReactNode, value: ReactNode][] }) {
  return (
    <dl className="flex flex-col divide-y divide-line text-sm">
      {items.map(([label, value], i) => (
        <div key={i} className="flex items-baseline justify-between gap-6 py-2.5">
          <dt className="shrink-0 text-muted">{label}</dt>
          <dd className="min-w-0 text-right break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A labelled text field. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
  type = "text",
  mono = true,
  inputMode,
  suffix,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: ReactNode;
  /** Shown under the field, and marks it invalid. */
  error?: string | null;
  type?: "text" | "password";
  /** Monospace for addresses, amounts and keys; off for prose. */
  mono?: boolean;
  inputMode?: "text" | "decimal";
  suffix?: ReactNode;
}) {
  const id = useId();
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative">
        <Input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          inputMode={inputMode}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          className={cn("h-11 rounded-xl", mono && "font-mono", suffix && "pr-14")}
        />
        {suffix && (
          <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs font-semibold text-muted">
            {suffix}
          </span>
        )}
      </div>
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        hint && <FieldDescription className="text-xs">{hint}</FieldDescription>
      )}
    </Field>
  );
}

/** A labelled dropdown. */
export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full rounded-xl data-[size=default]:h-11">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** A form's submit button, with a spinner while it runs. */
export function Submit({
  busy,
  disabled,
  children,
}: {
  busy: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button type="submit" disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy && <Spinner aria-hidden />}
      {children}
    </Button>
  );
}

/** A button that opens a modal. The modal's content gets a way to close it. */
export function ModalButton({
  label,
  title,
  description,
  variant,
  size = "default",
  className,
  wide,
  children,
}: {
  label: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  className?: string;
  wide?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} className={className} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ResponsiveModal
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        wide={wide}
      >
        {children(() => setOpen(false))}
      </ResponsiveModal>
    </>
  );
}

/**
 * A button that asks before it acts. `act` makes the change; `then` runs once the modal has closed,
 * so a refresh that takes this row away doesn't take an open modal with it.
 */
export function ConfirmButton({
  label,
  title,
  description,
  confirm,
  act,
  then,
  variant = "ghost",
}: {
  label: ReactNode;
  title: ReactNode;
  description: ReactNode;
  confirm: string;
  act: () => Promise<unknown>;
  then?: () => Promise<unknown>;
  variant?: ComponentProps<typeof Button>["variant"];
}) {
  const [open, setOpen] = useState(false);
  const action = useAction();
  return (
    <>
      <Button
        variant={variant}
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <ResponsiveModal open={open} onOpenChange={setOpen} title={title} description={description}>
        <ErrorText error={action.error} />
        <ModalActions>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await act();
                setOpen(false);
                await then?.();
              })
            }
          >
            {action.busy && <Spinner aria-hidden />}
            {confirm}
          </Button>
        </ModalActions>
      </ResponsiveModal>
    </>
  );
}

/** A new API key, shown once. */
export function KeyOnce({ apiKey }: { apiKey: string }) {
  return (
    <SecretOnce label="Your agent's API key" value={apiKey}>
      Your agent sends it to POST /payments/check before each payment.
    </SecretOnce>
  );
}
