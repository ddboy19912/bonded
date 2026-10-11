import { Rich } from "./code-block";
import { useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { tierForScore } from "@bondedhq/shared";
import { addressUrl, short, txUrl } from "../lib/format";
import { explorerUrl } from "../config";
import { describeError } from "../lib/errors";
import { errorCode, troubleshootingUrl } from "../lib/troubleshooting";
import { GLOSSARY, tierMeaning, type GlossaryTerm } from "../lib/glossary";

/** The class for an inline text link, so every link in the app looks the same. */
export const linkClass = "text-accent underline-offset-4 decoration-accent/40 hover:underline";

type Tone = "safe" | "breach" | "neutral" | "brand" | "warn";

/**
 * The Bonded logo for dark backgrounds: the lockup (mark and name) or the mark alone. The brand
 * rules ask for a lockup at least 160 px wide where there is room; smaller spots use the symbol.
 */
export function Logo({
  variant = "lockup",
  className = "h-7",
}: {
  variant?: "lockup" | "symbol";
  className?: string;
}) {
  const src =
    variant === "symbol" ? "/brand/bonded-symbol-blue.svg" : "/brand/bonded-lockup-on-dark.svg";
  return <img src={src} alt="Bonded" className={`${className} w-auto`} />;
}

export function Card({
  title,
  description,
  children,
  actions,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel min-w-0 p-5 sm:p-6 ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-lg font-bold">{title}</h2>}
            {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  size = "md",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  size?: "md" | "lg";
}) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div
        className={`mt-2 truncate tabular-nums ${size === "lg" ? "font-serif text-5xl leading-none" : "text-2xl font-bold tracking-tight"}`}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-xs text-muted">
          {typeof hint === "string" ? <Rich>{hint}</Rich> : hint}
        </div>
      )}
    </div>
  );
}

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">{children}</div>;
}

const BADGE: Record<Tone, string> = {
  safe: "bg-safe-soft text-safe",
  breach: "bg-breach-soft text-breach",
  neutral: "bg-white/[0.07] text-soft",
  brand: "bg-accent-soft text-accent",
  warn: "bg-warn-soft text-warn",
};

export function Badge({
  tone = "neutral",
  dot = false,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${BADGE[tone]}`}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/** A tier's colour: blue for A and above, amber for BBB and BB, orange below. */
export function tierTone(score: number): Tone {
  return score >= 70 ? "brand" : score >= 45 ? "warn" : "breach";
}

/** The stroke colour for a score ring of this tier. */
export function tierStroke(score: number): string {
  const tone = tierTone(score);
  return tone === "brand" ? "#7fa0ff" : tone === "warn" ? "#ffb347" : "#ff7a45";
}

/** The tier for a score, with what it means for cover on hover. */
export function TierBadge({ score }: { score: number }) {
  const { tier } = tierForScore(score);
  return (
    <Tooltip content={`Tier ${tier}. ${tierMeaning(tier)}`}>
      <Badge tone={tierTone(score)}>{tier}</Badge>
    </Tooltip>
  );
}

/** A score as a ring that fills to it, coloured by tier. */
export function ScoreRing({ score, size = 150 }: { score: number; size?: number }) {
  const c = 2 * Math.PI * 46;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 110 110" className="size-full -rotate-90" aria-hidden>
        <circle
          cx="55"
          cy="55"
          r="46"
          fill="none"
          strokeWidth="8"
          stroke="rgb(255 255 255 / 0.08)"
        />
        <circle
          cx="55"
          cy="55"
          r="46"
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          stroke={tierStroke(score)}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-serif leading-none" style={{ fontSize: size * 0.42 }}>
          {score}
        </span>
        {size >= 110 && <span className="font-mono text-[11px] text-muted">of 100</span>}
      </span>
    </div>
  );
}

export function AddressLink({ address }: { address: string }) {
  if (!explorerUrl) return <span className="font-mono text-[0.92em]">{short(address)}</span>;
  return (
    <a
      className="font-mono text-[0.92em] text-accent hover:underline"
      href={addressUrl(address)}
      target="_blank"
      rel="noreferrer"
    >
      {short(address)}
    </a>
  );
}

export function TxLink({ hash }: { hash: string }) {
  if (!explorerUrl) return <span className="font-mono text-[0.92em]">{short(hash, 6)}</span>;
  return (
    <a
      className="font-mono text-[0.92em] text-accent hover:underline"
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
    >
      {short(hash, 6)}
    </a>
  );
}

type ButtonKind = "primary" | "secondary" | "ghost" | "danger" | "light";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_KIND: Record<ButtonKind, string> = {
  primary: "btn-brand text-on-brand hover:brightness-110",
  light: "bg-ink text-paper hover:bg-white",
  secondary: "border border-line-strong text-ink hover:bg-white/[0.06]",
  ghost: "text-soft hover:bg-white/[0.06] hover:text-ink",
  danger: "border border-breach/40 text-breach hover:bg-breach-soft",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-12 px-6 text-base",
};

/** The classes for a button, for links that should look like one. */
export function buttonClass(kind: ButtonKind = "primary", size: ButtonSize = "md") {
  return `inline-flex items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_KIND[kind]} ${BUTTON_SIZE[size]}`;
}

export function Button({
  children,
  onClick,
  disabled,
  kind = "primary",
  size = "md",
  type = "button",
  loading = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: ButtonKind;
  size?: ButtonSize;
  type?: "button" | "submit";
  loading?: boolean;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(kind, size)}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

/** A router link that looks like a button. */
export function LinkButton({
  to,
  children,
  kind = "primary",
  size = "md",
}: {
  to: string;
  children: ReactNode;
  kind?: ButtonKind;
  size?: ButtonSize;
}) {
  return (
    <Link to={to} className={buttonClass(kind, size)}>
      {children}
    </Link>
  );
}

export function Spinner({ large = false }: { large?: boolean }) {
  return (
    <span
      className={`animate-spin rounded-full ${large ? "size-7 border-[3px] border-white/10 border-t-accent" : "size-3.5 border-2 border-current border-r-transparent"}`}
      aria-hidden
    />
  );
}

const FIELD =
  "h-11 w-full rounded-xl border bg-white/[0.03] px-3.5 text-sm text-ink outline-none transition placeholder:text-muted/70 focus:border-accent focus:ring-3 focus:ring-accent/15";

export function Input(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password";
  label: ReactNode;
  hint?: ReactNode;
  /** Shown under the field, and marks it invalid. */
  error?: string | null;
  /** Monospace for addresses, amounts and keys; off for prose. */
  mono?: boolean;
  inputMode?: "text" | "decimal" | "numeric";
  suffix?: ReactNode;
}) {
  const id = useId();
  const mono = props.mono ?? true;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm">
      <label htmlFor={id} className="font-medium text-soft">
        {props.label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={props.type ?? "text"}
          value={props.value}
          placeholder={props.placeholder}
          inputMode={props.inputMode}
          onChange={(e) => props.onChange(e.target.value)}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={props.error || props.hint ? `${id}-note` : undefined}
          className={`${FIELD} ${mono ? "font-mono" : ""} ${props.suffix ? "pr-20" : ""} ${props.error ? "border-breach" : "border-line-strong"}`}
          autoComplete="off"
          spellCheck={false}
        />
        {props.suffix && (
          <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-xs font-semibold text-muted">
            {props.suffix}
          </span>
        )}
      </div>
      {(props.error || props.hint) && (
        <span id={`${id}-note`} className={`text-xs ${props.error ? "text-breach" : "text-muted"}`}>
          {props.error || (typeof props.hint === "string" ? <Rich>{props.hint}</Rich> : props.hint)}
        </span>
      )}
    </div>
  );
}

/** A choice card for radio groups: a label, an optional line under it, and the selected ring. */
export function Choice({
  checked,
  onChange,
  title,
  children,
  name,
  type = "radio",
  disabled = false,
  flat = false,
}: {
  checked: boolean;
  onChange: () => void;
  title: ReactNode;
  children?: ReactNode;
  name?: string;
  type?: "radio" | "checkbox";
  /** Not available here; `children` should say why. */
  disabled?: boolean;
  /** A row in a plain list, for places where a box per option is too much. */
  flat?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-3 text-sm transition ${flat ? `py-3 ${disabled ? "cursor-not-allowed opacity-60" : checked ? "cursor-pointer" : "cursor-pointer text-muted hover:text-ink"}` : `rounded-2xl border p-4 ${disabled ? "cursor-not-allowed border-line-strong opacity-60" : checked ? "cursor-pointer border-accent/60 bg-accent-soft" : "cursor-pointer border-line-strong hover:bg-white/[0.03]"}`}`}
    >
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className={`mt-0.5 ${flat ? "accent-brand-bright" : ""}`}
      />
      <span>
        <span className={`font-semibold ${flat && checked ? "text-ink" : ""}`}>{title}</span>
        {children && <span className="mt-0.5 block text-muted">{children}</span>}
      </span>
    </label>
  );
}

/** An on/off setting: its name (and what it does) on the left, the switch on the right. */
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-6 py-3.5 ${disabled ? "cursor-wait" : "cursor-pointer"}`}
    >
      <span className="min-w-0">
        <span className={`block text-sm font-medium ${checked ? "" : "text-muted"}`}>{label}</span>
        {description && <span className="mt-0.5 block text-sm text-muted">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span
        aria-hidden
        className="relative h-6 w-10 shrink-0 rounded-full bg-white/[0.14] transition peer-checked:bg-brand-bright peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-disabled:opacity-60 after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4"
      />
    </label>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return (
    <span className={`block animate-pulse rounded-lg bg-white/[0.06] ${className}`} aria-hidden />
  );
}

/** Roughly how much room the loaded content takes, so the page doesn't jump when it arrives. */
const LOADING_HEIGHT = { sm: "min-h-24", md: "min-h-40", lg: "min-h-64" } as const;

/**
 * A loading state: a spinner and what's loading, centred where the content will be. Grey bars
 * shaped like nothing in particular looked like broken content, so this says what it's doing.
 */
export function Loading({
  what,
  height = "sm",
}: {
  what: string;
  height?: keyof typeof LOADING_HEIGHT;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 text-sm text-muted ${LOADING_HEIGHT[height]}`}
      role="status"
    >
      <Spinner large />
      <span>Loading {what}…</span>
    </div>
  );
}

/** Nothing to show yet: one line on why, and the next thing to do. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line-strong px-6 py-10 text-center">
      <img src="/brand/bonded-symbol-blue.svg" alt="" className="mb-1 h-7 opacity-40" />
      <p className="font-semibold">{title}</p>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

const CALLOUT: Record<Exclude<Tone, "neutral">, string> = {
  brand: "border-accent/30 bg-accent-soft",
  warn: "border-warn/30 bg-warn-soft",
  breach: "border-breach/35 bg-breach-soft",
  safe: "border-safe/30 bg-safe-soft",
};

export function Callout({
  tone = "brand",
  title,
  children,
}: {
  tone?: Exclude<Tone, "neutral">;
  title?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-2xl border p-4 text-sm ${CALLOUT[tone]}`}>
      {title && <p className="mb-1 font-semibold">{title}</p>}
      <div className="text-soft">{children}</div>
    </div>
  );
}

const NOTE_BAR: Record<Exclude<Tone, "neutral">, string> = {
  brand: "border-accent/60",
  warn: "border-warn/60",
  breach: "border-breach/70",
  safe: "border-safe/60",
};

/** A status or warning in the page's own flow: a coloured bar at its left, no box around it. */
export function Note({
  tone = "brand",
  title,
  role,
  children,
}: {
  tone?: Exclude<Tone, "neutral">;
  title?: ReactNode;
  role?: "alert" | "status";
  children?: ReactNode;
}) {
  return (
    <div role={role} className={`border-l-2 pl-4 text-sm ${NOTE_BAR[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={`text-soft ${title ? "mt-1" : ""}`}>{children}</div>}
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const code = errorCode(error);
  return (
    <p role="alert" className="text-sm text-breach">
      {describeError(error)}
      {code && (
        <>
          {" "}
          <a className={`${linkClass} text-xs whitespace-nowrap`} href={troubleshootingUrl(code)}>
            How to fix this<span className="sr-only"> (troubleshooting: {code})</span>
          </a>
        </>
      )}
    </p>
  );
}

/** A section whose data couldn't be loaded: what went wrong, and a way to try again. */
export function Unavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-breach/30 bg-breach-soft p-4">
      <ErrorText error={error} />
      <Button kind="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * A hover and focus tooltip. The trigger is focusable so keyboard users can read it too. The tip
 * is drawn in a portal with fixed position, so tables that scroll sideways don't clip it.
 */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const id = useId();
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const below = r.top < 96;
    setAt({ x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
  };
  const hide = () => setAt(null);
  return (
    <span
      tabIndex={0}
      aria-describedby={at ? id : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      className="inline-flex rounded outline-offset-2"
    >
      {children}
      {at &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            style={{
              left: Math.min(Math.max(at.x, 140), window.innerWidth - 140),
              top: at.y,
            }}
            className={`pointer-events-none fixed z-50 w-max max-w-64 -translate-x-1/2 rounded-xl border border-line-strong bg-raised px-3 py-2 text-left text-xs leading-relaxed font-normal tracking-normal text-soft normal-case shadow-(--shadow-raised) ${at.below ? "" : "-translate-y-full"}`}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** A word from the glossary, underlined with dots, explained on hover or focus. */
export function Term({ term, children }: { term: GlossaryTerm; children: ReactNode }) {
  return (
    <Tooltip content={GLOSSARY[term]}>
      <span className="cursor-help underline decoration-muted/60 decoration-dotted underline-offset-4">
        {children}
      </span>
    </Tooltip>
  );
}

/** Wraps a plain <table> with the app's table styles, and scrolls sideways on small screens. */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto sm:-mx-6">
      <table className="w-full text-sm [&_tbody_tr]:border-t [&_tbody_tr]:border-line [&_tbody_tr:hover]:bg-white/[0.025] [&_td]:py-3.5 [&_td:first-child]:pl-5 sm:[&_td:first-child]:pl-6 [&_td:last-child]:pr-5 sm:[&_td:last-child]:pr-6 [&_th]:pb-3 [&_th]:text-left [&_th]:text-[10.5px] [&_th]:font-medium [&_th]:tracking-[0.14em] [&_th]:text-muted [&_th]:uppercase [&_th:first-child]:pl-5 sm:[&_th:first-child]:pl-6 [&_th:last-child]:pr-5 sm:[&_th:last-child]:pr-6">
        {children}
      </table>
    </div>
  );
}

/** A label and value list, e.g. hashes and addresses under a card's stats. */
export function Details({ children }: { children: ReactNode }) {
  return (
    <dl className="mt-5 grid gap-x-6 gap-y-2.5 border-t border-line pt-5 text-sm sm:grid-cols-[11rem_1fr] [&_dd]:min-w-0 [&_dt]:text-muted">
      {children}
    </dl>
  );
}

export function Page({
  title,
  eyebrow,
  intro,
  actions,
  back,
  children,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  intro?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-5">
        <div className="min-w-0">
          {back && (
            <Link
              to={back.to}
              className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
            >
              <span aria-hidden>←</span> {back.label}
            </Link>
          )}
          {eyebrow && <p className="eyebrow mb-2.5">{eyebrow}</p>}
          <h1 className="font-serif text-5xl leading-none sm:text-[56px]">{title}</h1>
          {intro && <p className="mt-3 max-w-2xl text-[15px] text-muted">{intro}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2.5">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
