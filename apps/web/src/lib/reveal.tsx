import {
  createElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * One observer per kind of "seen" for the whole page: each element is told once, the first time it
 * counts as on screen.
 */
const observers = new Map<string, IntersectionObserver>();
const waiting = new Map<Element, () => void>();

function watch(el: Element, onSeen: () => void, rootMargin: string): () => void {
  // No observer (old browsers, the test environment): show everything straight away.
  if (typeof IntersectionObserver === "undefined") {
    onSeen();
    return () => {};
  }
  let observer = observers.get(rootMargin);
  if (!observer) {
    observer = new IntersectionObserver(
      (entries, self) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          waiting.get(entry.target)?.();
          waiting.delete(entry.target);
          self.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin },
    );
    observers.set(rootMargin, observer);
  }
  waiting.set(el, onSeen);
  observer.observe(el);
  return () => {
    waiting.delete(el);
    observer.unobserve(el);
  };
}

/**
 * A ref, and whether its element has come on screen yet. It never goes back to false. `rootMargin`
 * moves the line it must cross: "0px 0px -40% 0px" waits until it is 40% of the way up the screen,
 * which works however tall the element is.
 */
export function useInView<T extends Element>(rootMargin = "0px") {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return watch(el, () => setSeen(true), rootMargin);
  }, [rootMargin]);
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
