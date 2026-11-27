import { useEffect, useState } from "react";
import { useInView, useReducedMotion } from "../lib/reveal";

/** Fast at first, settling into the value: the landing page's ease, as a function of 0..1. */
const easeOut = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * A number that counts up to its value the first time it comes on screen, then holds. Readers who
 * ask for less motion, and places with no observer (tests, old browsers), see the value at once.
 * Screen readers always get the value itself, never the frames in between.
 */
export function CountUp({
  value,
  format = (n) => Math.round(n).toLocaleString("en-US"),
  ms = 1400,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  ms?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const still =
    reduced || typeof IntersectionObserver === "undefined" || typeof window === "undefined";
  const [ref, seen] = useInView<HTMLSpanElement>();
  const [shown, setShown] = useState(still ? value : 0);

  useEffect(() => {
    if (still) return setShown(value);
    if (!seen) return;
    let frame = 0;
    const start = performance.now();
    const from = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setShown(from + (value - from) * easeOut(t));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [seen, still, value, ms]);

  const final = format(value);
  return (
    <span ref={ref} className={className}>
      {still || shown === value ? (
        final
      ) : (
        <>
          <span aria-hidden>{format(shown)}</span>
          <span className="sr-only">{final}</span>
        </>
      )}
    </span>
  );
}
