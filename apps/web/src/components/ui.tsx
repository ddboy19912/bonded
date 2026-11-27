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

/**
 * A block of a page: a hairline across the top, its title in large tight type, and its content in
 * the open. No box: the founder's rule is open layout, with rules only where they separate things.
 */
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
    <section className={`min-w-0 border-t border-line pt-6 ${className}`}>
      {(title || actions) && (
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="h-section">{title}</h2>}
            {description && (
              <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">{description}</p>
            )}
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
    <div className="min-w-0 border-t border-line pt-4">
      <div className="eyebrow">{label}</div>
      <div className={`mt-2.5 truncate tabular-nums ${size === "lg" ? "num-giant" : "num-big"}`}>
        {value}
      </div>
      {hint && (
        <div className="mt-2 text-[13px] text-muted">
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
  safe: "border-safe/35 text-safe",
  breach: "border-breach/40 text-breach",
  neutral: "border-line-strong text-soft",
  brand: "border-accent/40 text-accent",
  warn: "border-warn/40 text-warn",
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
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-px font-mono text-[11.5px] leading-[18px] whitespace-nowrap ${BADGE[tone]}`}
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
export function ScoreRing({
  score,
  size = 150,
  stroke,
}: {
  score: number;
  size?: number;
  /** The ring's colour; the insurance tier's by default. */
  stroke?: string;
}) {
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
          stroke={stroke ?? tierStroke(score)}
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

export type ButtonKind = "primary" | "secondary" | "ghost" | "danger" | "light";
export type ButtonSize = "sm" | "md" | "lg";

/** The look of each kind of button: the classes in index.css (`.btn-*`) hold the hover fill. */
const BUTTON_KIND: Record<ButtonKind, string> = {
  primary: "btn-primary",
  light: "btn-light",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  danger: "btn-danger",
};
const BUTTON_SIZE: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-[15px]",
  lg: "h-12 px-6 text-[15px]",
};

/** The classes for a button, for links that should look like one. */
export function buttonClass(kind: ButtonKind = "primary", size: ButtonSize = "md") {
  return `btn ${BUTTON_KIND[kind]} ${BUTTON_SIZE[size]}`;
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
  "h-12 w-full rounded-xl border bg-white/[0.02] px-4 text-[15px] text-ink outline-none transition placeholder:text-dim hover:border-white/30 focus:border-brand-bright focus:bg-transparent";

export function Input(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "email";
  label: ReactNode;
  hint?: ReactNode;
  /** Shown under the field, and marks it invalid. */
  error?: string | null;
  /** Monospace for addresses, amounts and keys; off for prose. */
  mono?: boolean;
  inputMode?: "text" | "decimal" | "numeric" | "email";
  suffix?: ReactNode;
  /** The browser's autofill hint ("email", "one-time-code", "username webauthn"); off by default. */
  autoComplete?: string;
}) {
  const id = useId();
  const mono = props.mono ?? true;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      <label htmlFor={id} className="eyebrow">
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
          autoComplete={props.autoComplete ?? "off"}
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

/** A dropdown with a label above it, styled like `Input`. */
export function Select(props: {
  value: string;
  onChange: (value: string) => void;
  label: ReactNode;
  options: { value: string; label: string }[];
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      <label htmlFor={id} className="eyebrow">
        {props.label}
      </label>
      <select
        id={id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={`${FIELD} border-line-strong`}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
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
  icon,
}: {
  checked: boolean;
  onChange: () => void;
  title: ReactNode;
  children?: ReactNode;
  name?: string;
  /** A logo or icon for the option: the tile then stacks it on top, with the mark at its right. */
  icon?: ReactNode;
  type?: "radio" | "checkbox";
  /** Not available here; `children` should say why. */
  disabled?: boolean;
  /** A row in a plain list, for places where a tile per option is too much. */
  flat?: boolean;
}) {
  const input = (
    <input
      type={type}
      name={name}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      className="peer sr-only"
    />
  );
  const text = (
    <span className="min-w-0">
      <span
        className={`block text-[15px] font-medium tracking-[-0.01em] transition-colors ${checked ? "text-ink" : "text-soft"}`}
      >
        {title}
      </span>
      {children && (
        <span className="mt-1 block text-[13.5px] leading-relaxed text-muted">{children}</span>
      )}
    </span>
  );
  if (flat)
    return (
      <label
        className={`group flex items-start gap-3.5 py-3.5 transition ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
      >
        {input}
        <ChoiceMark checked={checked} type={type} className="mt-0.5" />
        {text}
      </label>
    );
  return (
    <label
      className={`group relative flex h-full gap-4 rounded-2xl p-5 transition duration-200 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-paper ${icon ? "items-start sm:flex-col" : "items-start"} ${disabled ? "cursor-not-allowed opacity-50 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : checked ? "cursor-pointer bg-brand-bright/[0.07] shadow-[inset_0_0_0_1.5px_var(--color-brand-bright)]" : "cursor-pointer shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)] hover:bg-white/[0.025] hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.22)]"}`}
    >
      {input}
      {icon ? (
        <>
          {/* A row on a phone (icon, text, mark); stacked from tablet up, the mark top right. */}
          <span className="flex shrink-0 items-start justify-between sm:w-full">
            <span
              aria-hidden
              className={`flex size-9 items-center justify-center rounded-xl transition [&_svg]:size-5 [&_img]:size-5 ${checked ? "bg-brand-bright/15 text-ink" : "bg-white/[0.05] text-muted group-hover:text-soft"}`}
            >
              {icon}
            </span>
            <span className="hidden sm:block">
              <ChoiceMark checked={checked} type={type} />
            </span>
          </span>
          <span className="min-w-0 flex-1">{text}</span>
          <span className="mt-0.5 sm:hidden">
            <ChoiceMark checked={checked} type={type} />
          </span>
        </>
      ) : (
        <>
          <ChoiceMark checked={checked} type={type} className="mt-0.5" />
          {text}
        </>
      )}
    </label>
  );
}

/** A choice's mark: a ring that fills blue with a dot (radio), or a box with a tick (checkbox). */
function ChoiceMark({
  checked,
  type,
  className = "",
}: {
  checked: boolean;
  type: "radio" | "checkbox";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`grid size-[18px] shrink-0 place-items-center transition duration-200 ${type === "radio" ? "rounded-full" : "rounded-[5px]"} ${checked ? "bg-brand-bright shadow-[0_0_0_4px_rgb(60_107_255/0.18)]" : "shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.28)] group-hover:shadow-[inset_0_0_0_1.5px_rgb(255_255_255/0.5)]"} ${className}`}
    >
      {type === "radio" ? (
        <span
          className={`size-1.5 rounded-full bg-white transition duration-200 ${checked ? "scale-100" : "scale-0"}`}
        />
      ) : (
        <svg
          viewBox="0 0 12 12"
          className={`size-3 text-white transition duration-200 ${checked ? "opacity-100" : "opacity-0"}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m2.5 6.2 2.3 2.3 4.7-5" />
        </svg>
      )}
    </span>
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
  divider = true,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** The hairline above it. Off when a line already sits right above (a tab bar). */
  divider?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-start gap-2 py-10 ${divider ? "border-t border-line" : ""}`}
    >
      <p className="text-[clamp(22px,2.2vw,30px)] leading-tight font-medium tracking-[-0.04em] text-soft">
        {title}
      </p>
      {children && <p className="max-w-md text-[15px] text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
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
    <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-breach-solid py-1 pl-4">
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
            className={`tip pointer-events-none fixed z-50 w-max max-w-72 -translate-x-1/2 text-left font-normal tracking-normal normal-case ${at.below ? "" : "-translate-y-full"}`}
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
    <div className="overflow-x-auto">
      <table className="w-full text-sm [&_tbody_tr]:border-t [&_tbody_tr]:border-line [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-white/[0.025] [&_td]:px-3 [&_td]:py-4 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th]:px-3 [&_th]:pb-3 [&_th:not(.text-right)]:text-left [&_th]:font-mono [&_th]:text-[12px] [&_th]:font-normal [&_th]:text-muted [&_th:first-child]:pl-0 [&_th:last-child]:pr-0 [&_thead]:border-b [&_thead]:border-line">
        {children}
      </table>
    </div>
  );
}

/**
 * A part of a page in the Overview's layout: its mono label in a narrow column at the left (sticky
 * on wide screens), then a large title, a line under it, and the content. A hairline sits above.
 */
export function Section({
  label,
  title,
  intro,
  actions,
  id,
  children,
  className = "",
}: {
  /** The mono label at the left. Left out, the content takes the full width. */
  label?: ReactNode;
  title?: ReactNode;
  intro?: ReactNode;
  actions?: ReactNode;
  id?: string;
  children?: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      className={`app-sec ${className}`}
      aria-labelledby={title ? headingId : undefined}
    >
      {label && <p className="eyebrow app-sec-lab">{label}</p>}
      <div className={`min-w-0 ${label ? "" : "lg:col-span-2"}`}>
        {(title || intro || actions) && (
          <div className="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <div className="min-w-0">
              {title && (
                <h2 id={headingId} className="h-section-lg">
                  {title}
                </h2>
              )}
              {intro && (
                <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">{intro}</p>
              )}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

/** An underlined text link with an arrow that moves on hover, as at the foot of an Overview section. */
export function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="more-link">
      {children} <span aria-hidden>→</span>
    </Link>
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
    <div className="flex flex-col gap-10 sm:gap-14">
      <header className="page-head flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
        <div className="min-w-0">
          {back && (
            <Link
              to={back.to}
              data-print-hide
              className="eyebrow group mb-6 inline-flex items-center gap-2 transition hover:text-ink"
            >
              <span aria-hidden className="transition group-hover:-translate-x-1">
                ←
              </span>{" "}
              {back.label}
            </Link>
          )}
          {/* The back link already names where the page sits; the same words again would stutter. */}
          {eyebrow && eyebrow !== back?.label && <p className="eyebrow mb-5">{eyebrow}</p>}
          <h1 className="h-display">{title}</h1>
          {intro && <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted">{intro}</p>}
        </div>
        {actions && (
          <div data-print-hide className="flex flex-wrap gap-2.5">
            {actions}
          </div>
        )}
      </header>
      {children}
    </div>
  );
}
