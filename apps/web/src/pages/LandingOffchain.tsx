import type { BondedIndex } from "@bondedhq/shared";
import { AppLink } from "../components/app-link";
import { useEffect, useState, type CSSProperties } from "react";
import { byScore, loadBondedIndex, taskScore } from "../lib/bonded-index";
import { Reveal, useInView } from "../lib/reveal";
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

type Tone = "safe" | "breach" | "warn";

interface Stop {
  id: string;
  tab: string;
  /** Where the payment comes from, and which of the three ways brought it to the gate. */
  source: string;
  via: string;
  amount: string;
  payee: string;
  /** The gate's rules, in a few words each, and whether this payment passes. */
  checks: [rule: string, pass: boolean][];
  verdict: string;
  /** The decision in one short line. */
  why: string;
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
    checks: [
      ["Known vendor", true],
      ["Bank details match", true],
      ["Approved invoice", true],
      ["Under $2,000", true],
    ],
    verdict: "Allowed",
    why: "Every rule passes.",
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
    checks: [
      ["Known vendor", true],
      ["Bank details match", false],
      ["Approved invoice", true],
      ["Under $2,000", true],
    ],
    verdict: "Blocked",
    why: "The bank details changed, with no finance ticket.",
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
    checks: [
      ["Known vendor", false],
      ["Not gambling", false],
      ["Under $2,000", true],
    ],
    verdict: "Declined",
    why: "A gambling merchant, and not one of your vendors.",
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
    checks: [
      ["Known payee", false],
      ["Under $2,000", false],
      ["Checked before paying", false],
    ],
    verdict: "Breach",
    why: "Seen only after it was paid.",
    tone: "warn",
    receipt: null,
  },
];

/** White when a payment simply goes through, blue when the gate stopped one, orange when one got away. */
const TONE_COLOUR: Record<Tone, string> = {
  safe: "var(--l-ink)",
  breach: "var(--l-blue)",
  warn: "var(--l-orange)",
};

const STEP_MS = 550;

/** The three ways to connect, each with the `via` of the example payments that arrive that way. */
const WAYS: { title: string; line: string; via: string }[] = [
  { title: "Ask first", line: "One call before each payment.", via: "Asks first" },
  { title: "Card hooks", line: "Your card program asks Bonded first.", via: "Card hook" },
  { title: "Watch", line: "Reads payments after, and alerts.", via: "Watch" },
];

/**
 * The gate at work on four example payments, to be read at a glance: the amount on the left, the
 * decision in large type on the right. Under the decision, one line saying why, and the rules as a
 * row of ticks and crosses. Under that, the three ways to connect, with the one this payment used
 * marked. The first payment plays once when it comes on screen and then holds; nothing loops.
 * Reduced-motion readers get each one finished.
 */
function GateDemo() {
  const reduced = useReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>();
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState(0);
  const s = STOPS[index]!;
  const last = s.checks.length + 1;
  const shown = reduced ? last : step;

  useEffect(() => {
    if (reduced || !seen || step >= last) return;
    const t = setTimeout(() => setStep(step + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [step, last, reduced, seen]);

  const decided = shown >= last;

  return (
    <div ref={ref}>
      <div className="l-atks l-picks l-picks-4" role="group" aria-label="Pick a payment">
        {STOPS.map((st, i) => (
          <button
            key={st.id}
            type="button"
            className="l-atk"
            aria-pressed={i === index}
            onClick={() => {
              setIndex(i);
              setStep(0);
            }}
            style={{ "--pick": TONE_COLOUR[st.tone] } as CSSProperties}
          >
            <span className="l-atk-meta">
              <span>{String(i + 1).padStart(2, "0")}</span>
            </span>
            <span className="l-atk-name">{st.tab}</span>
          </button>
        ))}
      </div>

      <div key={s.id} className="l-sen-grid" aria-live="polite">
        <div>
          <p className="l-lab">{s.source}</p>
          <p className="l-pay">{s.amount}</p>
          <p className="l-payee">
            {s.via === "Card hook" ? "at" : "to"} <b>{s.payee}</b>
          </p>
        </div>

        <div>
          <p className="l-lab flex justify-between gap-6">
            <span>The gate says</span>
            <span>Illustration</span>
          </p>
          <div className="l-verdict l-gate-verdict" data-on={decided} aria-hidden={!decided}>
            <p className="l-vv" style={{ color: TONE_COLOUR[s.tone] }}>
              {s.verdict}
            </p>
            <p className="l-why">{s.why}</p>
          </div>
          <ul className="l-marks">
            {s.checks.map(([rule, pass], i) => {
              const on = shown >= i + 1;
              return (
                <li key={rule} data-on={on} data-ok={pass} aria-hidden={!on}>
                  <span aria-hidden>{pass ? "✓" : "✕"}</span>
                  {rule}
                  <span className="sr-only">{pass ? ": yes" : ": no"}</span>
                </li>
              );
            })}
          </ul>
          <p className="l-lab l-receipt" data-on={decided}>
            {s.receipt ? (
              <>Receipt signed by Bonded {s.receipt}</>
            ) : (
              <>
                No receipt · <span>Alert sent to Slack</span>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="l-cols l-ways">
        {WAYS.map((way) => (
          <div key={way.title} data-on={way.via === s.via}>
            <h3>{way.title}</h3>
            <p>{way.line}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The payment gate: what it does, a payment going through it, and the three ways to connect. */
export function LandingGate() {
  return (
    <section id="gate" className="l-sec">
      <div className="l-head">
        <p className="l-lab">Payment gate · for agents that pay</p>
        <div>
          <Reveal as="h2" className="l-h2">
            Check every payment <span className="dim">before it leaves.</span>
          </Reveal>
          <p className="l-lede">
            The gate checks your agent's payments against your rules, by bank, card or wallet, and
            signs a receipt anyone can check. Bonded never holds a key that can move your money.
          </p>
          <div className="l-actions">
            <AppLink to="/gate" className="l-btn l-btn-p">
              Open the payment gate
            </AppLink>
            <a href={DOCS_GATE} className="l-link">
              Read the guide <span aria-hidden>→</span>
            </a>
          </div>
        </div>
      </div>
      <div className="l-body">
        <GateDemo />
      </div>
    </section>
  );
}
