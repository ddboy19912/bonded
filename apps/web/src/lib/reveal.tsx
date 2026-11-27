import {
  createElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether the reader asks for less motion right now (false where there is no way to ask). */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(REDUCED_MOTION)?.matches === true;
}

/**
 * Whether the reader asks for less motion, kept up to date. It is right from the first render, so
 * nothing starts moving for a reader who asked it not to.
 */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia?.(REDUCED_MOTION);
    if (!mq) return;
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

/**
 * One observer per kind of "seen" for the whole page: each element is told once, the first time it
 * counts as on screen. An observer is made again if the browser's IntersectionObserver itself has
 * changed (tests swap it), so one test's stand-in never answers for the next.
 */
const observers = new Map<string, { make: unknown; observer: IntersectionObserver }>();
const waiting = new Map<Element, () => void>();

function watch(el: Element, onSeen: () => void, rootMargin: string): () => void {
  // No observer (old browsers, the test environment): show everything straight away.
  if (typeof IntersectionObserver === "undefined") {
    onSeen();
    return () => {};
  }
  let entry = observers.get(rootMargin);
  if (!entry || entry.make !== IntersectionObserver) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          waiting.get(e.target)?.();
          waiting.delete(e.target);
          observer.unobserve(e.target);
        }
      },
      { threshold: 0.12, rootMargin },
    );
    entry = { make: IntersectionObserver, observer };
    observers.set(rootMargin, entry);
  }
  const { observer } = entry;
  waiting.set(el, onSeen);
  observer.observe(el);
  return () => {
    waiting.delete(el);
    observer.unobserve(el);
  };
}

/**
 * A ref, and whether its element is on screen right now (unlike `useInView`, it goes back to false
 * when the element leaves). Without an observer it counts as always on screen.
 */
export function useOnScreen<T extends Element>(rootMargin = "0px") {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setOn(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.target === el) setOn(e.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);
  return [ref, on] as const;
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

/** How far apart the pieces of one section come in, when they come on screen together. */
export const BEAT_GAP_MS = 80;

/**
 * The pieces of a section, in reading order: the label, the headline, the line under it, the
 * buttons, then each block of the body. A heading's plain wrapper is opened up so its pieces come
 * in one by one; anything that already rises by itself (`.l-rv`) is left alone.
 */
function beatsOf(section: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const child of section.children) {
    const head = child.classList.contains("l-head") || child.classList.contains("l-how-h");
    if (!head) {
      out.push(child as HTMLElement);
      continue;
    }
    for (const piece of child.children) {
      if (piece.tagName === "DIV" && !piece.className)
        out.push(...([...piece.children] as HTMLElement[]));
      else out.push(piece as HTMLElement);
    }
  }
  return out.filter((el) => !el.classList.contains("l-rv"));
}

/**
 * Walks the reader down the page: each section's pieces fade and rise into place in reading order
 * as they come on screen, a beat apart, so the eye lands on the headline before the detail. It
 * does nothing without an observer (old browsers, tests) or for readers who ask for less motion, so
 * the page never hides anything it cannot bring back. Put the ref on the page; it marks the
 * sections (`.l-sec`) inside it once, when the page mounts.
 */
export function useSectionStory<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const page = ref.current;
    if (!page || typeof IntersectionObserver === "undefined") return;
    if (prefersReducedMotion()) return;
    const beats = [...page.querySelectorAll(".l-sec")].flatMap(beatsOf);
    const observer = new IntersectionObserver(
      (entries) => {
        // Pieces that arrive together come in one after another, in the order they are read.
        entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => entry.target as HTMLElement)
          .sort((a, b) =>
            a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
          )
          .forEach((el, i) => {
            el.style.setProperty("--beat-delay", `${i * BEAT_GAP_MS}ms`);
            el.dataset.in = "true";
            observer.unobserve(el);
          });
      },
      // Start as a piece reaches the bottom edge, so a fast scroll does not land on blank space.
      { rootMargin: "0px 0px 8% 0px" },
    );
    for (const el of beats) {
      el.dataset.beat = "";
      observer.observe(el);
    }
    page.dataset.story = "on";
    return () => {
      observer.disconnect();
      delete page.dataset.story;
      for (const el of beats) {
        delete el.dataset.beat;
        delete el.dataset.in;
      }
    };
  }, []);
  return ref;
}
