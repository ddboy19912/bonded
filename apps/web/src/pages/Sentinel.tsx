import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { SENTINEL_GATES, SENTINEL_MODEL } from "../lib/sentinel-facts";
import { Badge, ErrorText, Page, buttonClass } from "../components/ui";
import { StatLoading, StatStrip } from "../components/stat-strip";

const STEPS: [string, string][] = [
  [
    "The agent proposes a trade",
    "Before it sends anything, it asks the guard about the action it wants to take.",
  ],
  [
    "The guard reads only what matters",
    "The mandate, the proposed action and what the agent read from outside, in separate fields. Never the agent's whole conversation.",
  ],
  [
    "It answers two questions",
    "Is this action driven by what the agent read rather than its mandate? Do those inputs carry instructions aimed at the agent?",
  ],
  [
    "A manipulated action is stopped",
    "At 70% confidence or more, the check says block. The vault still enforces the mandate either way.",
  ],
];

/** One cell of the gates grid: opaque, so the 1px gaps between cells read as dividers. */
const CELL = "bg-[linear-gradient(180deg,rgb(18_23_37),rgb(11_14_23))] p-6";

const RATED_WITH: [string, string][] = [
  [
    "Every attack meets the guard first",
    "The whole rating runs with the guard in front of your agent, exactly as it will trade.",
  ],
  [
    "Earn a lower premium",
    "If the guard stops attacks, your agent breaches less, scores higher and pays less for cover. Measured in the rating, not promised.",
  ],
  [
    "Labelled, never passed off",
    "The report and the agent's page say the guard was on, and the rating has its own code hash.",
  ],
];

/** Sentinel: what it is, whether it's running, how it was tested, and how to use it. */
export function Sentinel() {
  const status = useQuery({
    queryKey: ["sentinel"],
    queryFn: api.sentinel,
    refetchInterval: 30_000,
  });
  const s = status.data;

  return (
    <Page
      title="Live guard"
      intro="Bonded's own guard against manipulated trades: an open-source decision model from Convai Innovations, fine-tuned on our attacks. It checks each trade before it's sent and blocks the ones driven by what the agent read instead of its mandate. The vault still enforces the mandate on chain and decides payouts."
    >
      <StatStrip
        stats={[
          {
            label: "Status",
            value: s ? (
              <span
                className={s.available ? "text-safe" : s.configured ? "text-breach" : "text-muted"}
              >
                {s.available ? "Running" : s.configured ? "Not answering" : "Off"}
              </span>
            ) : (
              <StatLoading />
            ),
          },
          {
            label: "Model",
            value: <span className="text-[28px]">v5</span>,
            hint: SENTINEL_MODEL.name,
          },
          {
            label: "Blocks at",
            value: s?.blockThreshold ? `${Math.round(s.blockThreshold * 100)}%` : "70%",
            hint: "confidence it was manipulated",
          },
          {
            label: "Checks today",
            value: s ? s.last24h.checks.toLocaleString() : <StatLoading />,
            ...(s ? { hint: `${s.last24h.blocked.toLocaleString()} blocked, last 24 hours` } : {}),
          },
        ]}
      />
      <ErrorText error={status.error} />

      {s?.fallback ? (
        <section>
          <h2 className="font-serif text-3xl leading-tight">
            Our model first, a second opinion when unsure
          </h2>
          <p className="mt-2 max-w-[65ch] text-sm text-muted">
            Uncertain checks go to {s.fallback.model}. Those checks share the mandate, proposed
            action and outside inputs with the model provider. The vault still decides payouts.
          </p>
          <StatStrip
            stats={[
              {
                label: "Checks escalated",
                value:
                  s.metrics24h?.escalationRate == null
                    ? "—"
                    : `${(100 * s.metrics24h.escalationRate).toFixed(1)}%`,
                hint: "last 24 hours, current guard",
              },
              {
                label: "LLM cost / 1,000",
                value:
                  s.metrics24h?.llmUsdPer1000 == null
                    ? "—"
                    : `$${s.metrics24h.llmUsdPer1000.toFixed(3)}`,
                hint: "provider spend; hosting separate",
              },
              {
                label: "Check latency p95",
                value:
                  s.metrics24h?.latencyMs.p95 == null
                    ? "—"
                    : `${s.metrics24h.latencyMs.p95.toLocaleString()} ms`,
                hint: "includes both paths",
              },
              {
                label: "Checks without an answer",
                value: s.metrics24h ? s.metrics24h.errors.toLocaleString() : "—",
                hint: "refused; never treated as safe",
              },
            ]}
          />
        </section>
      ) : null}

      <section>
        <h2 className="font-serif text-3xl leading-tight">How a check works</h2>
        <ol className="panel mt-5 grid overflow-hidden p-0 md:grid-cols-2 xl:grid-cols-4">
          {STEPS.map(([title, text], i) => (
            <li
              key={title}
              className="border-b border-line p-5 last:border-b-0 md:[&:nth-child(odd)]:border-r xl:border-b-0 xl:[&:not(:last-child)]:border-r"
            >
              <span className="font-serif text-[32px] leading-none text-muted">{i + 1}</span>
              <p className="mt-3 font-semibold">{title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2 className="font-serif text-3xl leading-tight">How v5 was tested</h2>
        <p className="mt-2 max-w-[60ch] text-sm text-muted">
          Five gates before it went live, each run on v5 and on the previous model, v1.
        </p>
        {/* Cells share four rows, so names, numbers and labels line up across a row of cards. */}
        <ul className="mt-5 grid gap-px overflow-hidden rounded-[var(--radius-card)] border border-line bg-line md:grid-cols-2 lg:grid-cols-3">
          {SENTINEL_GATES.map((g) => (
            <li key={g.name} className={`${CELL} row-span-4 grid grid-rows-subgrid`}>
              <span>
                <Badge tone={g.passed ? "safe" : "warn"} dot>
                  {g.passed ? "Passed" : "Exception"}
                </Badge>
              </span>
              <p className="mt-3 font-semibold">{g.name}</p>
              <p className="mt-1.5 max-w-[40ch] text-sm leading-relaxed text-muted">{g.what}</p>
              <div className="mt-6">
                <p className="flex items-baseline gap-3 tabular-nums">
                  <span className="font-serif text-[40px] leading-none">{g.after}</span>
                  <span className="text-sm text-muted">
                    v1: <span className="text-soft">{g.before}</span>
                  </span>
                </p>
                <p className="mt-1.5 text-sm text-muted">{g.measure}</p>
              </div>
            </li>
          ))}
          <li className={`${CELL} row-span-4 flex flex-col`}>
            <p className="eyebrow">Verdict</p>
            <p className="mt-3 font-serif text-[40px] leading-none">4 of 5 passed</p>
            <p className="mt-auto pt-6 text-sm leading-relaxed text-muted">
              The stress suite improved overall but got worse in 2 of its 44 families. v5 went live
              with that exception recorded, and the next model targets those families.
            </p>
          </li>
        </ul>
      </section>

      <section className="grid gap-8 border-t border-line pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div>
          <h2 className="font-serif text-3xl leading-tight">Rate your agent with the guard on</h2>
          <p className="mt-3 max-w-[48ch] text-sm leading-relaxed text-muted">
            Choose it when you onboard an agent. Your agent then asks the guard before each trade.
          </p>
          <Link to="/agents/new" className={`mt-6 ${buttonClass("primary")}`}>
            Onboard an agent
          </Link>
        </div>
        <ul className="grid content-start gap-6">
          {RATED_WITH.map(([title, text]) => (
            <li key={title} className="flex gap-4">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
              <span>
                <span className="block font-semibold">{title}</span>
                <span className="mt-1 block text-sm leading-relaxed text-muted">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </Page>
  );
}
