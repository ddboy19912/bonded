import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { CodeBlock, Rich, type CodeLanguage } from "./code-block";
import { Collapsible } from "./collapsible";
import { CopyButton } from "./copy-button";
export { CopyButton };

/** A note longer than this waits behind "What this does", so a command isn't buried in prose. */
const LONG_NOTE = 140;

/**
 * A labelled block of code to copy: a command, a config or a snippet, highlighted, with a note
 * under it. A note that is a long string waits behind "What this does". Notes may put code in
 * backticks.
 */
export function CopyBlock({
  label,
  text,
  note,
  language = "bash",
}: {
  label: ReactNode;
  text: string;
  note?: ReactNode;
  language?: CodeLanguage;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <CodeBlock label={label} code={text} language={language} />
      {typeof note === "string" && note.length > LONG_NOTE ? (
        <Collapsible
          className="text-xs text-muted"
          triggerClassName="text-xs"
          contentClassName="pt-1.5"
          summary="What this does"
        >
          <p className="leading-relaxed">
            <Rich>{note}</Rich>
          </p>
        </Collapsible>
      ) : typeof note === "string" ? (
        <p className="text-xs leading-relaxed text-muted">
          <Rich>{note}</Rich>
        </p>
      ) : (
        note && <p className="text-xs leading-relaxed text-muted">{note}</p>
      )}
    </div>
  );
}

/** A secret shown once: copy it now, it won't be shown again. */
export function SecretOnce({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-l-2 border-warn/60 pl-4 text-sm">
      <p className="font-semibold">{label}: copy it now, it won't be shown again</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-lg bg-black/40 px-3 py-2 font-mono text-xs break-all text-soft">
          {value}
        </code>
        <CopyButton text={value} />
      </div>
      {children && <div className="text-xs text-soft">{children}</div>}
    </div>
  );
}

/**
 * Tabs with the keyboard behaviour screen-reader users expect: arrow keys move between tabs,
 * Home and End jump, and only the selected tab is in the tab order.
 */
export function Tabs({
  label,
  tabs,
  selected,
  onSelect,
  children,
}: {
  label: string;
  tabs: { id: string; label: string }[];
  selected: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (e: KeyboardEvent, i: number) => {
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % tabs.length
        : e.key === "ArrowLeft"
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    onSelect(id);
    refs.current[id]?.focus();
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        role="tablist"
        aria-label={label}
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 text-xs"
      >
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            id={`${base}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={selected === t.id}
            aria-controls={`${base}-panel`}
            tabIndex={selected === t.id ? 0 : -1}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => move(e, i)}
            className={`shrink-0 rounded-full px-3 py-1.5 font-semibold whitespace-nowrap focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${selected === t.id ? "bg-ink text-paper" : "bg-white/[0.06] text-muted hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${selected}`}
        className="min-w-0"
      >
        {children}
      </div>
    </div>
  );
}
