import type { BondedIndex } from "@bondedhq/shared";
import { AppLink } from "../components/app-link";
import { useEffect, useState } from "react";
import { byScore, loadBondedIndex, taskScore } from "../lib/bonded-index";
import { Reveal } from "../lib/reveal";
import { DOCS_GATE } from "../lib/routes";
import { useReducedMotion } from "./LandingSentinel";

/**
 * The Index's models as one ledger, hardest to trick first, each with its two scores side by side,
 * from config/bonded-index.json. A model whose Task score was not measured is still listed, with a
 * dash in place of a number.
 */
export function LandingIndex({ index = loadBondedIndex() }: { index?: BondedIndex }) {
  if (index.entries.length === 0) return null;
  return (
    <section id="index" className="l-sec">
      <div className="l-head">
        <p className="l-lab">Bonded Index · AI models</p>
        <div>
          <Reveal as="h2" className="l-h2">
            Which AI model is hardest <span className="dim">to trick into paying?</span>
          </Reveal>
          <p className="l-lede">
            Every model runs the same agent that pays invoices, and meets the same attacks: fake
            bank changes, forged invoices, fake bosses. Security is how hard it is to trick. Task is
            whether it still pays the real bills.
          </p>
        </div>
      </div>
      <table className="l-ledger-table l-body">
        <caption className="sr-only">AI models by Security score, with their Task score</caption>
        <thead>
          <tr>
            <th scope="col">No.</th>
            <th scope="col">Model</th>
            <th scope="col">Security: harder to trick</th>
            <th scope="col">Task: still pays the real bills</th>
          </tr>
        </thead>
        <tbody>
          {byScore(index.entries).map((entry, i) => {
            const task = taskScore(entry);
            return (
              <tr key={entry.model}>
                <td className="n">{String(i + 1).padStart(2, "0")}</td>
                <th scope="row">{entry.label}</th>
                <td>{entry.score}</td>
                <td>{task ?? <span aria-label="not measured">–</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="l-actions">
        <AppLink to="/index" className="l-link">
          See the full Index <span aria-hidden>→</span>
        </AppLink>
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
    <div>
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
              className={`rounded-full px-3 py-2 text-xs transition sm:px-4 sm:text-sm ${i === index ? "bg-ink font-medium text-black" : "text-muted hover:text-ink"}`}
            >
              {st.tab}
            </button>
          ))}
        </div>
        <span className="l-lab">Illustration</span>
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
    <section id="gate" className="l-sec">
      <div className="l-head">
        <p className="l-lab">Payment gate · for agents that pay</p>
        <Reveal as="h2" className="l-h2">
          Check every payment <span className="dim">before it leaves.</span>
        </Reveal>
      </div>
      <div className="l-body grid items-start gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-[clamp(24px,5vw,90px)]">
        <div>
          <p className="max-w-lg text-lg leading-relaxed text-muted">
            The gate checks your agent's payments against your rules, by bank, card or wallet, and
            signs a receipt anyone can check. Bonded never holds a key that can move your money.
          </p>
          <ul className="mt-8 max-w-lg border-b border-line">
            {WAYS.map(([title, line]) => (
              <li key={title} className="border-t border-line py-4">
                <span className="block text-xl font-medium tracking-[-0.03em]">{title}</span>
                <span className="mt-1 block text-muted">{line}</span>
              </li>
            ))}
          </ul>
          <div className="l-actions">
            <AppLink to="/gate" className="l-btn l-btn-p">
              Open the payment gate
            </AppLink>
            <a href={DOCS_GATE} className="l-link">
              Read the guide <span aria-hidden>→</span>
            </a>
          </div>
        </div>
        <Checkpoint />
      </div>
    </section>
  );
}
