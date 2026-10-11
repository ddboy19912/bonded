import { useEffect, useRef, useState } from "react";

/**
 * A copy button that says it worked ("Copied") or didn't ("Select and copy it"), announced to
 * screen readers. Its width doesn't change between states, so nothing around it moves.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
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
