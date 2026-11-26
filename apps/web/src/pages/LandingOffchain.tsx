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

/** White when a payment simply goes through, blue when the gate stopped one, orange when one got away. */
const TONE_COLOUR: Record<Tone, string> = {
  safe: "var(--l-ink)",
  breach: "var(--l-blue)",
  warn: "var(--l-orange)",
};

const STEP_MS = 650;

/** The three ways to connect, each with the `via` of the example payments that arrive that way. */
const WAYS: { title: string; line: string; via: string }[] = [
  {
    title: "Ask first",
    line: "One API, SDK or MCP call before each payment. In Enforce mode a breach is blocked.",
    via: "Asks first",
  },
  {
    title: "Card hooks",
    line: "Stripe Issuing, Lithic or Marqeta asks Bonded before each card charge.",
    via: "Card hook",
  },
  {
    title: "Watch",
    line: "Bonded reads a wallet or your payment log after the fact, and alerts on a breach.",
    via: "Watch",
  },
];

/**
 * The gate at work on four example payments. Pick one: the payment is on the left, and on the right
 * each rule is checked in turn, the decision lands in large type, and a signed receipt comes out
 * (or, for a payment only seen after it was made, an alert). Under it, the way that payment reached
 * the gate is marked among the three ways to connect. The first payment plays once when it comes on
 * screen and then holds; nothing loops. Reduced-motion readers get each one finished.
 */
function GateDemo() {
  const reduced = useReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>();
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState(0);
  const s = STOPS[index]!;
  const last = s.checks.length + 2;
  const shown = reduced ? last : step;

  useEffect(() => {
    if (reduced || !seen || step >= last) return;
    const t = setTimeout(() => setStep(step + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [step, last, reduced, seen]);

  const decided = shown >= s.checks.length + 1;
  const done = shown >= last;

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
              <span>{st.via}</span>
            </span>
            <span className="l-atk-name">{st.tab}</span>
          </button>
        ))}
      </div>

      <div key={s.id} className="l-sen-grid">
        <div>
          <p className="l-lab">The agent wants to pay</p>
          <p className="l-pay">{s.amount}</p>
          <p className="l-payee">
            {s.via === "Card hook" ? "at" : "to"} <b>{s.payee}</b>
          </p>
          <p className="l-step-text">{s.detail}</p>
          <div className="l-rows mt-8">
            <div>
              <span>Arrives from</span>
              <span>{s.source}</span>
            </div>
            <div>
              <span>Reaches the gate by</span>
              <span>{s.via}</span>
            </div>
          </div>
        </div>

        <div aria-live="polite">
          <p className="l-lab flex justify-between gap-6">
            <span>The gate checks</span>
            <span>Illustration</span>
          </p>
          <ul className="l-out l-out-seq">
            {s.checks.map(([label, mark, note], i) => {
              const on = shown >= i + 1;
              return (
                <li key={label} data-on={on} data-ok={mark === "pass"} aria-hidden={!on}>
                  <span className="n">{String(i + 1).padStart(2, "0")}</span>
                  <span>
                    {label}
                    {note && <small>{note}</small>}
                  </span>
                  <span className="a">{mark === "pass" ? "yes" : "no"}</span>
                </li>
              );
            })}
          </ul>
          <div className="l-verdict mt-10" data-on={decided} aria-hidden={!decided}>
            <p className="l-vv" style={{ color: TONE_COLOUR[s.tone] }}>
              {s.verdict}
            </p>
            <p className="l-vt l-receipt" data-on={done}>
              {s.receipt ? (
                <>
                  Receipt signed by Bonded <code>{s.receipt}</code>. Anyone can check it.
                </>
              ) : (
                <>
                  Seen after it was paid: no receipt. <span>Alert sent to Slack</span>
                </>
              )}
            </p>
          </div>
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
