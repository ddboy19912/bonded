import type { BondedIndex, BondedIndexEntry } from "@bondedhq/shared";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ProviderLogo } from "../components/index-charts";
import { buttonClass } from "../components/ui";
import { byScore, loadBondedIndex, taskScore } from "../lib/bonded-index";
import { DOCS_GATE } from "../lib/routes";
import { useReducedMotion } from "./LandingSentinel";

const SECTION =
  "mx-auto max-w-[1180px] scroll-mt-24 px-4 sm:px-6 py-24 sm:min-h-svh sm:justify-center sm:py-28 sm:flex sm:flex-col";

/** A score's place across the plot, in percent, with room at both edges for a marker. */
const at = (v: number) => 4 + v * 0.92;

/** What each corner of the map means. Split at 50 on both scores. */
export const corner = (security: number, task: number) =>
  security >= 50
    ? task >= 50
      ? "Hard to trick, and does the job"
      : "Safe because it refuses"
    : task >= 50
      ? "Does the job, easy to trick"
      : "Easy to trick, little done";

/** The same, short enough for a phone's plot. */
const cornerShort = (security: number, task: number) =>
  security >= 50
    ? task >= 50
      ? "Safe and useful"
      : "Refuses"
    : task >= 50
      ? "Tricked"
      : "Neither";

const QUADRANTS: { s: number; t: number; goal?: boolean }[] = [
  { s: 75, t: 75, goal: true },
  { s: 25, t: 75 },
  { s: 75, t: 25 },
  { s: 25, t: 25 },
];

interface Point {
  entry: BondedIndexEntry;
  security: number;
  task: number;
}

type Box = { left: number; top: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

/**
 * Where each model's name goes: beside, above or below its marker, the first spot that stays in the
 * plot and clears every marker and the names already placed. On a narrow plot a name with no free
 * spot is left off (its marker still names it on tap); on a wide one it goes to the right anyway.
 */
export function placeLabels(
  points: Point[],
  width: number,
  height: number,
): Map<string, { left: number; top: number } | null> {
  const narrow = width < 520;
  const font = narrow ? 11 : 13;
  const marker = narrow ? 24 : 30;
  const gap = marker / 2 + 6;
  const xy = (p: Point) => ({
    x: (at(p.security) / 100) * width,
    y: height - (at(p.task) / 100) * height,
  });
  const markers: Box[] = points.map((p) => {
    const { x, y } = xy(p);
    return { left: x - marker / 2, top: y - marker / 2, width: marker, height: marker };
  });
  // The corner names are fixed: a model's name keeps clear of them.
  const cornerFont = narrow ? 10 : 11;
  const placed: Box[] = QUADRANTS.map((q) => {
    const text = narrow ? cornerShort(q.s, q.t) : corner(q.s, q.t);
    const w = Math.min(text.length * cornerFont * 0.78, width * 0.4);
    const h = cornerFont * (text.length * cornerFont * 0.78 > width * 0.4 ? 2.6 : 1.4);
    const cx = (at(q.s) / 100) * width;
    const cy = height - (at(q.t) / 100) * height;
    return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
  });
  const out = new Map<string, { left: number; top: number } | null>();
  points.forEach((p, i) => {
    const { x, y } = xy(p);
    const w = p.entry.label.length * font * 0.56 + 6;
    const h = font + 6;
    const candidates: Box[] = [
      { left: x + gap, top: y - h / 2, width: w, height: h },
      { left: x - gap - w, top: y - h / 2, width: w, height: h },
      { left: x - w / 2, top: y - gap - h, width: w, height: h },
      { left: x - w / 2, top: y + gap, width: w, height: h },
      { left: x + marker / 2 - w, top: y - gap - h, width: w, height: h },
      { left: x + marker / 2 - w, top: y + gap, width: w, height: h },
      { left: x - marker / 2, top: y - gap - h, width: w, height: h },
      { left: x - marker / 2, top: y + gap, width: w, height: h },
    ];
    const free = candidates.find(
      (c) =>
        c.left >= 0 &&
        c.top >= 0 &&
        c.left + c.width <= width &&
        c.top + c.height <= height &&
        !placed.some((b) => overlaps(b, c)) &&
        !markers.some((m, j) => j !== i && overlaps(m, c)),
    );
    const chosen = free ?? (narrow ? null : candidates[x > width * 0.8 ? 1 : 0]!);
    if (chosen) placed.push(chosen);
    out.set(p.entry.model, chosen ? { left: chosen.left, top: chosen.top } : null);
  });
  return out;
}

/** Security across, Task up: every model on one map, with the corner you want lit. */
function TradeoffMap({ entries }: { entries: BondedIndexEntry[] }) {
  const reduced = useReducedMotion();
  const plot = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [inView, setInView] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const shown = inView || reduced;

  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = plot.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const points: Point[] = entries.map((entry) => ({
    entry,
    security: entry.score,
    task: taskScore(entry) ?? 0,
  }));
  const labels = size.width ? placeLabels(points, size.width, size.height) : new Map();
  const focus = points.find((p) => p.entry.model === active);

  return (
    <div className="panel p-5 pb-4 sm:p-8 sm:pb-6">
      <div className="relative ml-6 sm:ml-8">
        <p className="absolute top-1/2 -left-6 origin-center -translate-x-1/2 -translate-y-1/2 -rotate-90 text-xs whitespace-nowrap text-muted sm:-left-8">
          Task: still pays the real bills <span aria-hidden>→</span>
        </p>
        <div
          ref={plot}
          className="relative h-[400px] border-b border-l border-line-strong sm:h-[460px]"
          onMouseLeave={() => setActive(null)}
        >
          {/* The corner where a model is both hard to trick and still does the job. */}
          <div
            aria-hidden
            className="absolute top-0 right-0 rounded-tr-xl bg-[radial-gradient(ellipse_at_80%_20%,rgb(60_107_255/.22),transparent_70%)]"
            style={{ left: `${at(50)}%`, bottom: `${at(50)}%` }}
          />
          <span
            aria-hidden
            className="absolute top-0 bottom-0 border-l border-dashed border-line"
            style={{ left: `${at(50)}%` }}
          />
          <span
            aria-hidden
            className="absolute right-0 left-0 border-t border-dashed border-line"
            style={{ bottom: `${at(50)}%` }}
          />
          {QUADRANTS.map((q) => (
            <span
              key={`${q.s}-${q.t}`}
              aria-hidden
              className={`absolute max-w-[40%] -translate-x-1/2 translate-y-1/2 text-center text-[10px] font-semibold tracking-[0.14em] uppercase sm:text-[11px] ${q.goal ? "text-held" : "text-muted/70"}`}
              style={{ left: `${at(q.s)}%`, bottom: `${at(q.t)}%` }}
            >
              {size.width && size.width < 520 ? cornerShort(q.s, q.t) : corner(q.s, q.t)}
            </span>
          ))}

          {points.map((p, i) => {
            const label = labels.get(p.entry.model);
            const dim = active !== null && active !== p.entry.model;
            const goal = p.security >= 50 && p.task >= 50;
            return (
              <div key={p.entry.model}>
                <button
                  type="button"
                  aria-label={`${p.entry.label}: Security ${p.security}, Task ${p.task}`}
                  onMouseEnter={() => setActive(p.entry.model)}
                  onFocus={() => setActive(p.entry.model)}
                  onBlur={() => setActive(null)}
                  onClick={() => setActive(active === p.entry.model ? null : p.entry.model)}
                  className={`absolute z-10 grid size-6 -translate-x-1/2 translate-y-1/2 place-items-center rounded-full bg-surface ring-2 sm:size-[30px] motion-safe:transition-[left,bottom,opacity] motion-safe:duration-[1100ms] motion-safe:ease-[cubic-bezier(.2,.75,.2,1)] ${goal ? "ring-accent" : "ring-line-strong"} ${dim ? "opacity-35" : ""}`}
                  style={{
                    left: `${at(shown ? p.security : 0)}%`,
                    bottom: `${at(shown ? p.task : 0)}%`,
                    opacity: shown ? undefined : 0,
                    transitionDelay: reduced ? undefined : `${i * 70}ms`,
                  }}
                >
                  <ProviderLogo provider={p.entry.provider} size={size.width < 520 ? 14 : 18} />
                </button>
                {label && (
                  <span
                    aria-hidden
                    className={`pointer-events-none absolute text-[11px] whitespace-nowrap transition-opacity duration-500 sm:text-[13px] ${goal ? "text-ink" : "text-soft"} ${shown && !dim ? "opacity-100" : "opacity-0"}`}
                    style={{
                      left: label.left,
                      top: label.top,
                      transitionDelay: shown && !reduced && !active ? `${900 + i * 70}ms` : "0ms",
                    }}
                  >
                    {p.entry.label}
                  </span>
                )}
              </div>
            );
          })}

          {focus && (
            <div
              role="status"
              className="pointer-events-none absolute z-20 w-[210px] -translate-x-1/2 rounded-xl border border-line-strong bg-surface/95 px-3.5 py-3 text-sm shadow-xl backdrop-blur"
              style={{
                left: `clamp(105px, ${at(focus.security)}%, calc(100% - 105px))`,
                bottom: `calc(${at(focus.task)}% + 26px)`,
              }}
            >
              <p className="font-semibold text-ink">{focus.entry.label}</p>
              <p className="mt-1 font-mono text-xs text-soft">
                Security {focus.security} · Task {focus.task}
              </p>
              <p className="mt-1.5 text-xs text-muted">{corner(focus.security, focus.task)}</p>
            </div>
          )}
        </div>
        <div className="mt-2 flex justify-between font-mono text-[11px] text-muted" aria-hidden>
          <span>0</span>
          <span>50</span>
          <span>100</span>
        </div>
        <p className="mt-1 text-center text-xs text-muted">
          Security: harder to trick <span aria-hidden>→</span>
        </p>
      </div>

      <table className="sr-only">
        <caption>AI models by Security score, with their Task score</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Security</th>
            <th scope="col">Task</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.entry.model}>
              <th scope="row">{p.entry.label}</th>
              <td>{p.security}</td>
              <td>{p.task}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The Index's models on one map, Security against Task, from config/bonded-index.json. */
export function LandingIndex({ index = loadBondedIndex() }: { index?: BondedIndex }) {
  if (index.entries.length === 0) return null;
  return (
    <section id="index" className={SECTION}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <p className="eyebrow !text-accent">Bonded Index · AI models</p>
          <h2 className="mt-3 max-w-3xl font-serif text-5xl leading-none">
            Which AI model is hardest to trick into paying?
          </h2>
          <p className="mt-5 max-w-[62ch] text-lg leading-relaxed text-muted">
            Every model runs the same agent that pays invoices, and meets the same attacks: fake
            bank changes, forged invoices, fake bosses. Security is how hard it is to trick. Task is
            whether it still pays the real bills.
          </p>
        </div>
        <Link to="/index" className={buttonClass("secondary", "lg")}>
          See the full Index <span aria-hidden>→</span>
        </Link>
      </div>
      <div className="mt-10">
        <TradeoffMap entries={byScore(index.entries)} />
      </div>
    </section>
  );
}

type Mark = "pass" | "fail";
type Tone = "safe" | "breach" | "warn";

interface Stop {
  id: string;
  tab: string;
  source: string;
  via: string;
  amount: string;
  payee: string;
  detail: string;
  checks: [string, Mark, string?][];
  verdict: string;
  tone: Tone;
  /** The receipt's short hash, or null when the payment was only seen after it was made. */
  receipt: string | null;
}

/** Four payments at the gate. Made up for the illustration; the checks are the gate's real rules. */
export const STOPS: Stop[] = [
  {
    id: "invoice",
    tab: "Invoice",
    source: "Agent · API",
    via: "Asks first",
    amount: "$612.40",
    payee: "Nimbus Print",
    detail: "Invoice NIM-88412",
    checks: [
      ["Vendor on your list", "pass"],
      ["Bank details match the vendor's", "pass"],
      ["Matches an approved invoice", "pass"],
      ["Under the $2,000 payment limit", "pass"],
    ],
    verdict: "Allowed",
    tone: "safe",
    receipt: "0x7a3c…e91f",
  },
  {
    id: "bank-change",
    tab: "Bank change",
    source: "Agent · API",
    via: "Asks first",
    amount: "$1,240.00",
    payee: "Nimbus Print",
    detail: "To a new account, LT77 3250 …",
    checks: [
      ["Vendor on your list", "pass"],
      ["Bank details match the vendor's", "fail", "Changed, with no finance ticket"],
      ["Matches an approved invoice", "pass"],
      ["Under the $2,000 payment limit", "pass"],
    ],
    verdict: "Blocked",
    tone: "breach",
    receipt: "0x19be…04c2",
  },
  {
    id: "card",
    tab: "Card",
    source: "Card · Lithic",
    via: "Card hook",
    amount: "$450.00",
    payee: "Lucky Spins",
    detail: "Merchant category 7995, gambling",
    checks: [
      ["Merchant is one of your vendors", "fail"],
      ["Not cash, money orders or gambling", "fail"],
      ["Under the $2,000 payment limit", "pass"],
    ],
    verdict: "Declined",
    tone: "breach",
    receipt: "0x5d02…a7b3",
  },
  {
    id: "wallet",
    tab: "Wallet",
    source: "Wallet · Base USDC",
    via: "Watch",
    amount: "$5,000.00",
    payee: "0x9f3a…e1c",
    detail: "Seen after it was paid",
    checks: [
      ["Payee on your vendor list", "fail"],
      ["Under the $2,000 payment limit", "fail"],
      ["Checked before it was paid", "fail"],
    ],
    verdict: "Breach",
    tone: "warn",
    receipt: null,
  },
];

const TONE_TEXT: Record<Tone, string> = {
  safe: "text-safe border-safe",
  breach: "text-breach border-breach",
  warn: "text-warn border-warn",
};

const STEP_MS = 650;
const HOLD_MS = 2800;

/**
 * The gate as a checkpoint: a payment arrives, each rule is checked in turn, the decision is stamped
 * on it, and a signed receipt comes out (or, for a payment only seen after, an alert). It cycles
 * through four payments; reduced-motion readers get each finished and switch with the tabs.
 */
function Checkpoint() {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState(0);
  const s = STOPS[index]!;
  const last = s.checks.length + 2;
  const shown = reduced ? last : step;

  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(
      () => {
        if (step < last) setStep(step + 1);
        else {
          setIndex((i) => (i + 1) % STOPS.length);
          setStep(0);
        }
      },
      step < last ? STEP_MS : HOLD_MS,
    );
    return () => clearTimeout(t);
  }, [step, last, reduced]);

  const stamped = shown >= s.checks.length + 1;
  const done = shown >= last;

  return (
    <div className="panel p-5 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-0.5 rounded-full border border-line p-1 sm:gap-1" role="group">
          {STOPS.map((st, i) => (
            <button
              key={st.id}
              type="button"
              aria-pressed={i === index}
              onClick={() => {
                setIndex(i);
                setStep(0);
              }}
              className={`rounded-full px-2.5 py-1.5 text-xs transition sm:px-3 sm:text-sm ${i === index ? "bg-white/[0.08] font-semibold text-ink" : "text-muted hover:text-soft"}`}
            >
              {st.tab}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted">Illustration</span>
      </div>

      <div
        key={s.id}
        className="relative mt-6 overflow-hidden rounded-2xl border border-line bg-white/[0.02]"
      >
        <div className="flex flex-col-reverse gap-3 px-5 pt-5 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-6">
          <div className="min-w-0">
            <p className="font-mono text-[28px] leading-tight tabular-nums sm:text-4xl">
              {s.amount}
            </p>
            <p className="mt-1.5 truncate text-soft">
              {s.via === "Card hook" ? "at" : "to"}{" "}
              <span className="font-mono text-ink">{s.payee}</span>
            </p>
            <p className="mt-1 text-sm text-muted">{s.detail}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:block sm:text-right">
            <span className="inline-block rounded-full bg-white/[0.06] px-2.5 py-1 font-mono text-[11px] text-soft">
              {s.source}
            </span>
            <p className="text-xs text-muted sm:mt-1.5">{s.via}</p>
          </div>
        </div>

        {/* A ticket's tear line. */}
        <div className="mx-5 border-t border-dashed border-line-strong sm:mx-6" aria-hidden />

        <ul className="flex min-h-[236px] flex-col sm:min-h-[190px] gap-3 px-5 py-5 sm:px-6">
          {s.checks.map(([label, mark, note], i) => {
            const on = shown >= i + 1;
            return (
              <li
                key={label}
                className={`flex items-start gap-3 transition-opacity duration-300 ${on ? "opacity-100" : "opacity-25"}`}
              >
                <span
                  className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold transition-transform duration-300 ${on ? "scale-100" : "scale-50"} ${on ? (mark === "pass" ? "bg-safe/15 text-safe" : "bg-breach/15 text-breach") : "bg-white/[0.06] text-transparent"}`}
                  aria-hidden
                >
                  {mark === "pass" ? "✓" : "✕"}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-ink">
                    {label}
                    <span className="sr-only">
                      {on ? (mark === "pass" ? ": yes" : ": no") : ""}
                    </span>
                  </span>
                  {note && on && <span className="block text-xs text-breach">{note}</span>}
                </span>
              </li>
            );
          })}
        </ul>

        <div
          className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line bg-white/[0.02] px-5 py-3.5 text-xs transition-opacity duration-500 sm:px-6 ${done ? "opacity-100" : "opacity-0"}`}
        >
          {s.receipt ? (
            <>
              <span className="text-soft">
                Receipt signed by Bonded <span className="font-mono text-muted">{s.receipt}</span>
              </span>
              <span className="text-muted">Anyone can check it</span>
            </>
          ) : (
            <>
              <span className="text-soft">Seen after it was paid: no receipt</span>
              <span className="text-warn">Alert sent to Slack</span>
            </>
          )}
        </div>

        {stamped && (
          <span
            className={`gate-stamp pointer-events-none absolute right-4 bottom-[56px] sm:top-[48%] sm:bottom-auto rounded-lg border-[3px] bg-sunken/70 px-3 py-0.5 font-mono text-lg font-bold sm:px-3.5 sm:py-1 tracking-[0.18em] uppercase backdrop-blur-[1px] sm:right-7 sm:text-2xl ${TONE_TEXT[s.tone]}`}
          >
            {s.verdict}
          </span>
        )}
      </div>
    </div>
  );
}

const WAYS: [string, string][] = [
  [
    "Ask first",
    "One API, SDK or MCP call before each payment. In Enforce mode a breach is blocked.",
  ],
  ["Card hooks", "Stripe Issuing, Lithic or Marqeta asks Bonded before each card charge."],
  ["Watch", "Bonded reads a wallet or your payment log after the fact, and alerts on a breach."],
];

/** The payment gate: what it does, the three ways to connect, and a payment going through it. */
export function LandingGate() {
  return (
    <section id="gate" className={SECTION}>
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div>
          <p className="eyebrow !text-accent">Payment gate · for agents that pay</p>
          <h2 className="mt-3 font-serif text-5xl leading-none sm:text-6xl">
            Check every payment before it leaves.
          </h2>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted">
            The gate checks your agent's payments against your rules, by bank, card or wallet, and
            signs a receipt anyone can check. Bonded never holds a key that can move your money.
          </p>
          <ul className="mt-8 flex max-w-lg flex-col gap-5">
            {WAYS.map(([title, line]) => (
              <li key={title} className="border-l border-line-strong pl-4">
                <span className="block font-semibold">{title}</span>
                <span className="mt-0.5 block text-muted">{line}</span>
              </li>
            ))}
          </ul>
          <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Link to="/gate" className={buttonClass("primary", "lg")}>
              Open the payment gate
            </Link>
            <a href={DOCS_GATE} className="text-accent hover:underline">
              Read the guide <span aria-hidden>→</span>
            </a>
          </div>
        </div>
        <Checkpoint />
      </div>
    </section>
  );
}
