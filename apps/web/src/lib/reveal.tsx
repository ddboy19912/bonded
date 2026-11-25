import {
  createElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/** One observer for the whole page: each element is told once, the first time it comes on screen. */
let observer: IntersectionObserver | null = null;
const waiting = new Map<Element, () => void>();

function watch(el: Element, onSeen: () => void): () => void {
  // No observer (old browsers, the test environment): show everything straight away.
  if (typeof IntersectionObserver === "undefined") {
    onSeen();
    return () => {};
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        waiting.get(entry.target)?.();
        waiting.delete(entry.target);
        observer?.unobserve(entry.target);
      }
    },
    { threshold: 0.12 },
  );
  waiting.set(el, onSeen);
  observer.observe(el);
  return () => {
    waiting.delete(el);
    observer?.unobserve(el);
  };
}

/** A ref, and whether its element has come on screen yet. It never goes back to false. */
export function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return watch(el, () => setSeen(true));
  }, []);
  return [ref, seen] as const;
}

type Tag = "div" | "p" | "h2" | "h3" | "li" | "ol" | "ul" | "article" | "section" | "table";

/**
 * An element that rises into place the first time it comes on screen. The motion is in landing.css
 * (`.l-rv`), which also holds it still for readers who ask for less motion.
 */
export function Reveal({
  as = "div",
  className = "",
  delay = 0,
  style,
  children,
  ...rest
}: {
  as?: Tag;
  className?: string;
  /** Milliseconds to wait after it comes on screen. */
  delay?: number;
  style?: CSSProperties;
  children?: ReactNode;
  id?: string;
  "aria-label"?: string;
}) {
  const [ref, seen] = useInView<HTMLElement>();
  return createElement(
    as,
    {
      ref,
      className: `l-rv ${className}`,
      "data-in": seen,
      style: delay ? { ...style, transitionDelay: `${delay}ms` } : style,
      ...rest,
    },
    children,
  );
}
