import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
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
import { Badge as Tag, ErrorText, buttonClass } from "../ui";
import { short } from "../../lib/format";
import { gateApi, type GateAccount, type GateVendor } from "../../lib/gate";

/** What the gate page's tabs share: its forms' plumbing and the pieces they're built from. */

type Variant = "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
type Size = "default" | "sm" | "lg" | "icon-sm";

const KIND = {
  default: "primary",
  outline: "secondary",
  secondary: "secondary",
  ghost: "ghost",
  destructive: "danger",
} as const;

/** The classes for a gate button: the landing page's pills, or an underlined link. */
export function pillClass(variant: Variant = "default", size: Size = "default") {
  if (variant === "link") return "more-link text-sm disabled:opacity-50";
  const kind = KIND[variant];
  if (size === "icon-sm") return `btn btn-${kind} size-8 shrink-0`;
  return buttonClass(kind, size === "default" ? "md" : size);
}

/**
 * A button in the gate's pages, in the landing page's style. It takes shadcn's variant and size
 * names, so a form reads the same as before; `ref` passes through for popover triggers.
 */
export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      {...props}
      className={cn(
        pillClass(variant, size),
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
    />
  );
}

const TONE = {
  safe: "safe",
  breach: "breach",
  warn: "warn",
  brand: "brand",
  secondary: "neutral",
  outline: "neutral",
} as const;

/** A status tag: an outlined mono label, coloured by what it says. */
export function Badge({
  variant = "outline",
  children,
}: {
  variant?: keyof typeof TONE;
  children: ReactNode;
}) {
  return <Tag tone={TONE[variant]}>{children}</Tag>;
}

/** The gate's tables: mono column heads, rows split by hairlines, nothing boxed. */
export const TABLE =
  "[&_th]:font-mono [&_th]:text-[12px] [&_th]:font-normal [&_th]:text-muted [&_td]:py-4";

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
    <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <p className="max-w-xl min-w-0 flex-1 basis-64 text-[15px] leading-relaxed text-soft">
        {children}
      </p>
      {action}
    </div>
  );
}

/** Labels and values, one to a line. */
export function Facts({ items }: { items: [label: ReactNode, value: ReactNode][] }) {
  return (
    <dl className="flex flex-col divide-y divide-line border-y border-line text-sm">
      {items.map(([label, value], i) => (
        <div key={i} className="flex items-baseline justify-between gap-6 py-3">
          <dt className="eyebrow shrink-0">{label}</dt>
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
  inputMode?: "text" | "decimal" | "numeric";
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
          aria-describedby={error || hint ? `${id}-note` : undefined}
          autoComplete="off"
          spellCheck={false}
          className={cn("h-12 rounded-xl", mono && "font-mono", suffix && "pr-14")}
        />
        {suffix && (
          <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs font-semibold text-muted">
            {suffix}
          </span>
        )}
      </div>
      {error ? (
        <FieldError id={`${id}-note`}>{error}</FieldError>
      ) : (
        hint && (
          <FieldDescription id={`${id}-note`} className="text-xs">
            {hint}
          </FieldDescription>
        )
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
  options: { value: string; label: string; icon?: ReactNode }[];
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full rounded-xl data-[size=default]:h-12">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.icon}
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

const CHAIN_LOGOS: Record<number, string> = {
  1: "/brand/chains/ethereum.svg",
  8453: "/brand/chains/base-chain.svg",
  84532: "/brand/chains/base-chain.svg",
  42161: "/brand/chains/arbitrum.svg",
};

/** A chain's logo. Decorative: the chain's name is always written next to it. */
export function ChainLogo({ chainId, className }: { chainId: unknown; className?: string }) {
  const src = CHAIN_LOGOS[Number(chainId)];
  if (!src) return null;
  return <img src={src} alt="" className={cn("size-5 shrink-0 rounded-full", className)} />;
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
  variant?: Variant;
  size?: Size;
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
  size = "sm",
  className,
  ariaLabel,
}: {
  label: ReactNode;
  title: ReactNode;
  description: ReactNode;
  confirm: string;
  act: () => Promise<unknown>;
  then?: () => Promise<unknown>;
  variant?: Variant;
  size?: Size;
  className?: string;
  /** The button's name when its label is only an icon. */
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const action = useAction();
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <ResponsiveModal
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        locked={action.busy}
      >
        <ErrorText error={action.error} />
        <ModalActions>
          <Button variant="ghost" disabled={action.busy} onClick={() => setOpen(false)}>
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
