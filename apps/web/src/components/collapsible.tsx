import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A disclosure that opens and closes with a height transition, in place of a native <details>,
 * which can't animate. The trigger is a real button (`aria-expanded`, `aria-controls`); closed
 * content stays mounted, so it keeps its state and animates, but is `inert`, so keyboard focus and
 * screen readers skip it. Motion is off under `prefers-reduced-motion`.
 *
 * Uncontrolled by default (`defaultOpen`); pass `open` and `onOpenChange` to control it.
 */
export function Collapsible({
  summary,
  children,
  defaultOpen = false,
  open: controlled,
  onOpenChange,
  className = "",
  triggerClassName = "text-sm font-semibold",
  contentClassName = "pt-3",
}: {
  /** The always-visible line the reader clicks. */
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  // Clipping is needed only while it moves: once open, a focus ring may reach past the edge.
  const [settled, setSettled] = useState(defaultOpen);
  const id = useId();
  // Whoever changes it (this button, or the parent), it clips again while it moves. Not on the
  // first render: an already-open one has nothing to wait for.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSettled(false);
    if (!open) return;
    // No transition end under reduced motion, so a timer settles it too.
    const t = setTimeout(() => setSettled(true), 350);
    return () => clearTimeout(t);
  }, [open]);
  const toggle = () => {
    if (controlled === undefined) setOwn(!open);
    onOpenChange?.(!open);
  };
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
        className={`flex w-full cursor-pointer items-start gap-2 rounded text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${triggerClassName}`}
      >
        <svg
          viewBox="0 0 12 12"
          className={`mt-[0.35em] size-3 shrink-0 text-muted transition-transform duration-300 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m4 2 4 4-4 4" />
        </svg>
        <span className="min-w-0 flex-1">{summary}</span>
      </button>
      <div
        id={id}
        inert={!open}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className={`min-h-0 ${open && settled ? "overflow-visible" : "overflow-hidden"}`}>
          <div className={contentClassName}>{children}</div>
        </div>
      </div>
    </div>
  );
}
