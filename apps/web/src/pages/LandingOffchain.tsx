import type { BondedIndex } from "@bondedhq/shared";
import { AppLink } from "../components/app-link";
import { useState, type CSSProperties } from "react";
import { byScore, loadBondedIndex, taskScore } from "../lib/bonded-index";
import { Reveal, useInView } from "../lib/reveal";
import { DOCS_GATE } from "../lib/routes";

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

/**
 * The rules the gate holds a payment to, written the way an owner would say them. They are the
 * gate's real kinds of rule (a vendor list, matching bank details, a payment limit, blocked kinds
 * of spending); the $2,000 is an example of a limit the owner sets.
 */
export const RULES = [
  { id: "vendor", text: "Only pay vendors on my list." },
  { id: "bank", text: "Bank details must match the vendor's." },
  { id: "limit", text: "No payment over $2,000." },
  { id: "kind", text: "No gambling, cash or money orders." },
] as const;

type RuleId = (typeof RULES)[number]["id"];
type Tone = "safe" | "breach" | "warn";

interface Stop {
  id: string;
  amount: string;
  /** Who it is going to, as a reader would say it. */
  to: string;
  /** Which of the three ways brought it to the gate. */
  via: string;
  /** The rules this payment breaks. None means it is allowed. */
  breaks: RuleId[];
  verdict: string;
  /** What follows from the rules, to finish the sentence "Breaks rule 02, ...". */
  then: string;
  tone: Tone;
  /** The receipt's short hash, or null when the payment was only seen after it was made. */
  receipt: string | null;
}

/** Four payments an agent tries to make. Made up for the illustration. */
export const STOPS: Stop[] = [
  {
    id: "invoice",
    amount: "$612.40",
    to: "to Nimbus Print, a vendor",
    via: "Asks first",
    breaks: [],
    verdict: "Allowed",
    then: "so it goes through.",
    tone: "safe",
    receipt: "0x7a3c…e91f",
  },
  {
    id: "bank-change",
    amount: "$1,240.00",
    to: "to Nimbus Print, at a new bank account",
    via: "Asks first",
    breaks: ["bank"],
    verdict: "Blocked",
    then: "so it never leaves.",
    tone: "breach",
    receipt: "0x19be…04c2",
  },
  {
    id: "card",
    amount: "$450.00",
    to: "at Lucky Spins, a casino",
    via: "Card hook",
    breaks: ["vendor", "kind"],
    verdict: "Declined",
    then: "so the card is declined.",
    tone: "breach",
    receipt: "0x5d02…a7b3",
  },
  {
    id: "wallet",
    amount: "$5,000.00",
    to: "to a wallet nobody knows",
    via: "Watch",
    breaks: ["vendor", "limit"],
    verdict: "Breach",
    then: "but it was only seen after it was paid.",
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

/** The three ways to connect, each with the `via` of the example payments that arrive that way. */
const WAYS: { title: string; line: string; via: string }[] = [
  { title: "Ask first", line: "One call before each payment.", via: "Asks first" },
  { title: "Card hooks", line: "Your card program asks Bonded first.", via: "Card hook" },
  { title: "Watch", line: "Reads payments after, and alerts.", via: "Watch" },
];

const number = (i: number) => String(i + 1).padStart(2, "0");

/** "Breaks rules 01 and 04, so the card is declined." for the picked payment. */
export function outcome(stop: Stop): string {
  const broken = stop.breaks.map((id) => number(RULES.findIndex((r) => r.id === id)));
  const start =
    broken.length === 0
      ? "Passes every rule"
      : `Breaks rule${broken.length > 1 ? "s" : ""} ${broken.join(" and ")}`;
  return `${start}, ${stop.then}`;
}

/**
 * The gate in one picture: the owner's rules on the left, in their own words, and on the right
 * four payments the agent tries to make, each with the gate's answer. So the limit means something:
 * it is a rule the reader can see, not a number on its own. Point at a payment (or pick it) and the
 * rules it breaks are marked, one line says what follows, and the way it reached the gate is marked
 * among the three ways to connect. Nothing plays or loops: the rows arrive once, as they come on
 * screen, and everything is there to read.
 */
function GateDemo() {
  const [ref, seen] = useInView<HTMLDivElement>();
  // It opens on the bank change: a payment the gate stops, for one rule.
  const [index, setIndex] = useState(1);
  const s = STOPS[index]!;

  return (
    <div ref={ref} className="l-gate" data-in={seen}>
      <div className="l-gate-grid">
        <div>
          <p className="l-lab">You set the rules</p>
          <ol className="l-rules">
            {RULES.map((rule, i) => {
              const broken = s.breaks.includes(rule.id);
              return (
                <li key={rule.id} data-ok={!broken}>
                  <span className="n">{number(i)}</span>
                  <span>{rule.text}</span>
                  <span className="m" aria-hidden>
                    {broken ? "✕" : "✓"}
                  </span>
                  <span className="sr-only">{broken ? "Broken by this payment" : "Kept"}</span>
                </li>
              );
            })}
          </ol>
        </div>

        <div>
          <p className="l-lab flex justify-between gap-6">
            <span>Your agent tries to pay</span>
            <span>Illustration</span>
          </p>
          <div className="l-pays" role="group" aria-label="Example payments">
            {STOPS.map((stop, i) => (
              <button
                key={stop.id}
                type="button"
                className="l-payrow"
                aria-pressed={i === index}
                onClick={() => setIndex(i)}
                onMouseEnter={() => setIndex(i)}
                onFocus={() => setIndex(i)}
                style={{ "--pick": TONE_COLOUR[stop.tone], "--d": `${i * 130}ms` } as CSSProperties}
              >
                <span className="amt">{stop.amount}</span>
                <span className="to">{stop.to}</span>
                <span className="v">{stop.verdict}</span>
              </button>
            ))}
          </div>
          <p className="l-gate-sum" aria-live="polite">
            {outcome(s)}
            <span className="l-lab">
              {s.receipt ? (
                <>Receipt signed by Bonded {s.receipt}</>
              ) : (
                <>
                  No receipt · <b>Alert sent to Slack</b>
                </>
              )}
            </span>
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
