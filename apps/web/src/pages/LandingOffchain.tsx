import type { BondedIndex } from "@bondedhq/shared";
import { Link } from "react-router";
import { VIZ } from "../components/charts";
import { ProviderLogo } from "../components/index-charts";
import { buttonClass } from "../components/ui";
import { byScore, idle, loadBondedIndex, taskScore } from "../lib/bonded-index";
import { DOCS_GATE } from "../lib/routes";

const SECTION =
  "mx-auto max-w-[1180px] scroll-mt-24 px-4 sm:px-6 py-24 sm:min-h-svh sm:justify-center sm:py-28 sm:flex sm:flex-col";

/** One score as a number and a thin bar, the same size for Security and Task. */
function ScoreBar({ value, color, low }: { value: number | null; color: string; low?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`w-8 shrink-0 text-right font-mono text-sm tabular-nums ${low ? "text-warn" : "text-ink"}`}
      >
        {value ?? "—"}
      </span>
      <span
        className="hidden h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06] sm:block"
        aria-hidden
      >
        <span
          className="block h-full rounded-full"
          style={{ width: `${value ?? 0}%`, backgroundColor: color }}
        />
      </span>
    </div>
  );
}

/** The Index's models, Security and Task side by side, from config/bonded-index.json. */
export function LandingIndex({ index = loadBondedIndex() }: { index?: BondedIndex }) {
  if (index.entries.length === 0) return null;
  const rows = byScore(index.entries);
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

      <div className="panel mt-10 p-5 sm:p-7">
        <table className="w-full table-fixed text-left">
          <caption className="sr-only">AI models by Security score, with their Task score</caption>
          <thead>
            <tr className="text-xs text-muted">
              <th scope="col" className="w-[58%] pb-3 font-medium sm:w-[34%]">
                Model
              </th>
              <th scope="col" className="pb-3 pl-2 font-medium">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: VIZ.accent }}
                    aria-hidden
                  />
                  Security
                </span>
              </th>
              <th scope="col" className="pb-3 pl-4 font-medium">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: VIZ.accentSoft }}
                    aria-hidden
                  />
                  Task
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.model} className="border-t border-line">
                <th scope="row" className="py-2.5 pr-2 font-normal">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <ProviderLogo provider={e.provider} />
                    <span className="truncate text-sm text-soft">{e.label}</span>
                  </span>
                </th>
                <td className="py-2.5 pl-2">
                  <ScoreBar value={e.score} color={VIZ.accent} />
                </td>
                <td className="py-2.5 pl-4">
                  <ScoreBar value={taskScore(e)} color={VIZ.accentSoft} low={idle(e)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 max-w-2xl text-sm text-muted">
        A model that refuses every payment is hard to trick but does no work, so we show both. Task
        under 50 is in amber. Updated {index.updatedAt.slice(0, 10)}, on test payments.
      </p>
    </section>
  );
}

type Outcome = "allowed" | "blocked" | "seen";

/** Example lines from a gate account's Activity tab. Illustration only. */
const ACTIVITY: {
  outcome: Outcome;
  result: string;
  source: string;
  payment: string;
  why: string;
}[] = [
  {
    outcome: "allowed",
    result: "Allowed",
    source: "Checked first · API",
    payment: "$612.40 to Nimbus Print",
    why: "Matches invoice NIM-88412. Receipt signed.",
  },
  {
    outcome: "blocked",
    result: "Blocked",
    source: "Checked first · API",
    payment: "$9,800.00 to LT77 3250 …",
    why: "Payee isn't on your vendor list.",
  },
  {
    outcome: "blocked",
    result: "Declined",
    source: "Card · Lithic",
    payment: "$450.00 at Lucky Spins",
    why: "Gambling is always declined.",
  },
  {
    outcome: "seen",
    result: "Breach",
    source: "Seen after · Base USDC",
    payment: "$5,000.00 to 0x9f3a…e1c",
    why: "No check first. Alert sent.",
  },
];

const TONE: Record<Outcome, string> = {
  allowed: "text-safe",
  blocked: "text-breach",
  seen: "text-warn",
};

const WAYS: [string, string][] = [
  [
    "Ask first",
    "One API, SDK or MCP call before each payment. In Enforce mode a breach is blocked.",
  ],
  ["Card hooks", "Stripe Issuing, Lithic or Marqeta asks Bonded before each card charge."],
  ["Watch", "Bonded reads a wallet or your payment log after the fact, and alerts on a breach."],
];

/** The payment gate: what it does, the three ways to connect, and a look at its activity log. */
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

        <div className="panel overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
            <p className="eyebrow">Payment gate · Activity</p>
            <span className="text-xs text-muted">Illustration</span>
          </div>
          <ul>
            {ACTIVITY.map((a) => (
              <li
                key={a.payment}
                className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-4 border-b border-line px-5 py-4 last:border-b-0"
              >
                <span className={`text-sm font-semibold ${TONE[a.outcome]}`}>{a.result}</span>
                <span className="min-w-0">
                  <span className="block truncate font-mono text-sm">{a.payment}</span>
                  <span className="mt-1 block text-sm text-muted">{a.why}</span>
                  <span className="mt-1.5 block text-xs text-soft">{a.source}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
