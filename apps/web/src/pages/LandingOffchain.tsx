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

/**
 * The owner's rules, a few words each. They are the gate's real kinds of rule (a vendor list,
 * matching bank details, a payment limit, blocked kinds of spending); the $2,000 is an example of a
 * limit the owner sets.
 */
export const RULES = [
  { id: "vendor", text: "On your vendor list" },
  { id: "bank", text: "Bank details match" },
  { id: "limit", text: "Under your $2,000 limit" },
  { id: "kind", text: "Not gambling" },
] as const;

type RuleId = (typeof RULES)[number]["id"];
type Tone = "safe" | "breach" | "warn";
type Kind = "invoice" | "bank" | "card" | "wallet";
type Place = "vendor" | "bank" | "casino" | "unknown";

interface Stop {
  id: Kind;
  tab: string;
  amount: string;
  /** Where the money is headed: the picture, and its name. */
  place: Place;
  payee: string;
  /** Which of the three ways brought it to the gate. */
  via: string;
  /** The rules this payment breaks. None means it is allowed. */
  breaks: RuleId[];
  verdict: string;
  tone: Tone;
  /** Whether the gate decided before the money moved, and so signed a receipt. */
  receipt: boolean;
}

/** Four payments an agent tries to make. Made up for the illustration. */
export const STOPS: Stop[] = [
  {
    id: "invoice",
    tab: "Invoice",
    amount: "$612.40",
    place: "vendor",
    payee: "Nimbus Print",
    via: "Ask first",
    breaks: [],
    verdict: "Allowed",
    tone: "safe",
    receipt: true,
  },
  {
    id: "bank",
    tab: "Bank change",
    amount: "$1,240.00",
    place: "bank",
    payee: "A new bank account",
    via: "Ask first",
    breaks: ["bank"],
    verdict: "Blocked",
    tone: "breach",
    receipt: true,
  },
  {
    id: "card",
    tab: "Card",
    amount: "$450.00",
    place: "casino",
    payee: "Lucky Spins casino",
    via: "Card hooks",
    breaks: ["vendor", "kind"],
    verdict: "Declined",
    tone: "breach",
    receipt: true,
  },
  {
    id: "wallet",
    tab: "Wallet",
    amount: "$5,000.00",
    place: "unknown",
    payee: "An unknown wallet",
    via: "Watch",
    breaks: ["vendor", "limit"],
    verdict: "Breach",
    tone: "warn",
    receipt: false,
  },
];

/** White when a payment simply goes through, blue when the gate stopped one, orange when one got away. */
const TONE_COLOUR: Record<Tone, string> = {
  safe: "var(--l-ink)",
  breach: "var(--l-blue)",
  warn: "var(--l-orange)",
};

/** The three ways to connect. Watch is the one that only sees a payment after it has left. */
const WAYS = ["Ask first", "Card hooks", "Watch"];

/** One run: 0 the payment is on its way to the gate, 1 the rules are checked, 2 the answer. */
const DECIDED = 2;
export const GATE_STEP_MS = [700, 900];

const MARK = [
  "M7 0H130C159 0 182 23 182 51C182 75 170 90 149 101L112 121Q101 127 101 114V75Q101 49 73 61L7 90Q0 94 0 86V7Q0 0 7 0Z",
  "M0 130Q0 122 8 118L58 92Q77 82 77 101V137Q77 159 97 149L169 113Q175 110 180 117C193 129 200 143 200 158C200 190 172 212 136 212H6Q0 212 0 206Z",
];

/** Small line icons for the four payments, on a 24-unit grid. */
const TAB_ICON: Record<Kind, string> = {
  invoice: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  bank: "M3 10l9-5 9 5M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18",
  card: "M3 6h18v12H3zM3 10h18M6 15h4",
  wallet: "M3 7h15a3 3 0 0 1 3 3v8H3zM3 7V6a2 2 0 0 1 2-2h11M16 13h2",
};

/** The payment itself, drawn: a sheet for an invoice or a bank change, a card, a wallet. */
function PaymentAsset({ kind, amount }: { kind: Kind; amount: string }) {
  return (
    <svg viewBox="0 0 280 180" aria-hidden>
      {(kind === "invoice" || kind === "bank") && (
        <>
          <path d="M52 2h126l50 50v126H52z" />
          <path d="M178 2v50h50" />
          <path d="M76 44h62" />
          {kind === "invoice" ? (
            <path d="M76 78h128M76 100h96" className="soft" />
          ) : (
            <>
              <path d="M76 78h128" className="soft" />
              <path d="M76 100h70" className="soft" />
              <path d="M70 100h82" className="hot" />
              <path d="M162 100h42" className="hot" />
            </>
          )}
          <text x="76" y="152" className="amt">
            {amount}
          </text>
        </>
      )}
      {kind === "card" && (
        <>
          <rect x="2" y="2" width="276" height="176" rx="20" />
          <rect x="28" y="40" width="46" height="34" rx="7" />
          <path d="M28 57h46M43 40v34M58 40v34" className="soft" />
          <path d="M214 38a14 14 0 0 1 0 28M226 30a24 24 0 0 1 0 44M238 22a34 34 0 0 1 0 60" />
          <text x="28" y="118" className="sm">
            •••• 4821
          </text>
          <text x="28" y="152" className="amt">
            {amount}
          </text>
        </>
      )}
      {kind === "wallet" && (
        <>
          <path d="M22 44V34a16 16 0 0 1 16-16h170a14 14 0 0 1 14 14v12" />
          <rect x="22" y="44" width="236" height="132" rx="18" />
          <path d="M258 92h-44a18 18 0 0 0 0 36h44" />
          <circle cx="216" cy="110" r="5" className="dot" />
          <text x="44" y="152" className="amt">
            {amount}
          </text>
        </>
      )}
    </svg>
  );
}

/** Where the money is headed, as one small line drawing. */
function PlaceGlyph({ place }: { place: Place }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden>
      {place === "vendor" && (
        <path d="M8 20l4-10h24l4 10M10 21v17h28V21M8 20a4 4 0 0 0 8 0a4 4 0 0 0 8 0a4 4 0 0 0 8 0a4 4 0 0 0 8 0M20 38V28h8v10" />
      )}
      {place === "bank" && (
        <path d="M6 20l18-11 18 11M10 20v15M18 20v15M30 20v15M38 20v15M6 39h36M8 35h32" />
      )}
      {place === "casino" && (
        <>
          <rect x="9" y="9" width="30" height="30" rx="7" />
          {[
            [17, 17],
            [31, 17],
            [24, 24],
            [17, 31],
            [31, 31],
          ].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.9" className="dot" />
          ))}
        </>
      )}
      {place === "unknown" && (
        <>
          <circle cx="24" cy="24" r="17" />
          <path d="M19 19.5a5 5 0 1 1 7.2 4.5c-1.6.9-2.2 1.9-2.2 3.6M24 32.5v.6" />
        </>
      )}
    </svg>
  );
}

/**
 * The gate as a picture, with as few words as it needs: the payment on the left, drawn; the gate
 * in the middle; where the money is headed on the right. Pick a payment and it travels to the gate,
 * the owner's four rules are ticked or crossed, and one word says what happened. An allowed payment
 * carries on to its payee; a blocked one stops at the gate. The wallet payment arrives by Watch,
 * which only sees it after it has left, so it gets through and the gate raises a breach. The first
 * payment plays once when it comes on screen and then holds; nothing loops. Reduced-motion readers
 * get each one finished.
 */
function GateDemo() {
  const reduced = useReducedMotion();
  const [ref, seen] = useInView<HTMLDivElement>();
  // It opens on the bank change: a payment the gate stops, for one rule.
  const [index, setIndex] = useState(1);
  const [step, setStep] = useState(0);
  const s = STOPS[index]!;
  const phase = reduced ? DECIDED : step;

  useEffect(() => {
    if (reduced || !seen || step >= DECIDED) return;
    const t = setTimeout(() => setStep(step + 1), GATE_STEP_MS[step]);
    return () => clearTimeout(t);
  }, [step, reduced, seen]);

  const decided = phase >= DECIDED;
  const allowed = s.breaks.length === 0;
  // Watch sees a payment only after it has left: it is through before the gate can answer.
  const after = s.via === "Watch";
  const through = after ? phase >= 1 : decided && allowed;
  const broken = s.breaks.map((id) => RULES.find((r) => r.id === id)!.text);

  return (
    <div ref={ref}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="l-seg" role="group" aria-label="Pick a payment">
          {STOPS.map((stop, i) => (
            <button
              key={stop.id}
              type="button"
              aria-pressed={i === index}
              onClick={() => {
                setIndex(i);
                setStep(0);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d={TAB_ICON[stop.id]} />
              </svg>
              {stop.tab}
            </button>
          ))}
        </div>
        <span className="l-lab">Illustration</span>
      </div>

      <div
        key={s.id}
        className="l-flow"
        data-phase={phase}
        data-through={through}
        style={{ "--tone": TONE_COLOUR[s.tone] } as CSSProperties}
      >
        <div className="l-asset">
          <PaymentAsset kind={s.id} amount={s.amount} />
        </div>
        <span className="l-wire" aria-hidden>
          <i />
        </span>
        <div className="l-gnode">
          <svg viewBox="0 0 224 224" aria-hidden>
            <g transform="translate(12 6)">
              {MARK.map((d) => (
                <path key={d} d={d} />
              ))}
            </g>
          </svg>
        </div>
        <span className="l-wire l-wire-out" aria-hidden>
          <i />
        </span>
        <div className="l-place">
          <PlaceGlyph place={s.place} />
        </div>

        <p className="l-cap l-cap-pay">{s.tab}</p>
        <div className="l-gout">
          <p className="l-gverdict" data-on={decided} aria-hidden={!decided}>
            {s.verdict}
          </p>
          <p className="l-lab l-gnote" data-on={decided} aria-hidden={!decided}>
            {s.receipt ? "Receipt signed by Bonded" : "Alert sent to Slack"}
          </p>
          <p className="sr-only" aria-live="polite">
            {decided &&
              (allowed
                ? `${s.verdict}: it keeps every rule.`
                : `${s.verdict}: it breaks ${broken.join(" and ")}.`)}
          </p>
        </div>
        <p className="l-cap l-cap-place">{s.payee}</p>
      </div>

      <div className="l-rulebar">
        <p className="l-lab">Your rules</p>
        <ul>
          {RULES.map((rule, i) => {
            const ok = !s.breaks.includes(rule.id);
            return (
              <li
                key={rule.id}
                data-on={phase >= 1}
                data-ok={ok}
                style={{ transitionDelay: `${i * 150}ms` }}
              >
                <span aria-hidden>{ok ? "✓" : "✕"}</span>
                {rule.text}
              </li>
            );
          })}
        </ul>
      </div>

      <p className="l-waybar">
        <span className="l-lab">Connect by</span>
        {WAYS.map((way) => (
          <span key={way} data-on={way === s.via}>
            {way}
          </span>
        ))}
      </p>
    </div>
  );
}

/** The payment gate: one line on what it does, and a payment going through it. */
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
            Your rules, checked before your agent pays. Bonded never holds a key that can move your
            money.
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
