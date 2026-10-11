import { useEffect, useRef, useState } from "react";

/**
 * A copy button that says it worked ("Copied") or didn't ("Select and copy it"), announced to
 * screen readers. Its width doesn't change between states, so nothing around it moves.
 */
export function CopyButton({
  text,
  label = "Copy",
  variant = "pill",
}: {
  text: string;
  label?: string;
  /** "icon" is a small square with a copy icon, for the corner of a code block. */
  variant?: "pill" | "icon";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  if (variant === "icon")
    return (
      <button
        type="button"
        onClick={() => void copy()}
        title="Copy to clipboard"
        className="flex size-8 items-center justify-center rounded-md border border-line-strong bg-white/[0.02] text-muted transition hover:bg-white/[0.07] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <svg
          viewBox="0 0 24 24"
          className={`size-4 ${state === "copied" ? "text-safe" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {state === "copied" ? (
            <path d="M20 6 9 17l-5-5" />
          ) : (
            <>
              <rect width="14" height="14" x="8" y="8" rx="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </>
          )}
        </svg>
        <span className="sr-only" aria-live="polite">
          {state === "copied" ? "Copied" : state === "failed" ? "Select it" : label}
        </span>
      </button>
    );
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="inline-flex min-w-[5.5rem] items-center justify-center rounded-full border border-line-strong px-3 py-1 text-xs font-semibold text-accent hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Select it" : label}
      </span>
    </button>
  );
}
