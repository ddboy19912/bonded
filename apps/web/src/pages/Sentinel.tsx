import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { SENTINEL_GATES, SENTINEL_MODEL } from "../lib/sentinel-facts";
import { Badge, ErrorText, Page, Section, buttonClass } from "../components/ui";
import { StatLoading, StatStrip } from "../components/stat-strip";

const STEPS: [string, string][] = [
  [
    "The agent proposes a trade",
    "Before it sends anything, it asks Sentinel about the action it wants to take.",
  ],
  [
    "Sentinel reads only what matters",
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

const RATED_WITH: [string, string][] = [
  [
    "Every attack meets Sentinel first",
    "The whole rating runs with Sentinel in front of your agent, exactly as it will trade.",
  ],
  [
    "Earn a lower premium",
    "If Sentinel stops attacks, your agent breaches less, scores higher and pays less for cover. Measured in the Arena, not promised.",
  ],
  [
    "Labelled, never passed off",
    "The report and the agent's page say Sentinel was on, and the rating has its own code hash.",
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
      title="Sentinel"
      intro="Bonded's own guard against manipulated trades: Laya, Convai Innovations' open-source decision model, fine-tuned on attacks from our Arena. It checks each trade before it's sent and blocks the ones driven by what the agent read instead of its mandate. The vault still enforces the mandate on chain and decides payouts."
    >
      <StatStrip
        stats={[
          {
            label: "Status",
            value: s ? (
              <span className={s.available ? "text-safe" : "text-muted"}>
                {/* It sleeps when idle and wakes in about 15 s (.railway/railway.ts). */}
                {s.available ? "Running" : s.configured ? "Waking up" : "Off"}
              </span>
            ) : status.isError ? (
              "—"
            ) : (
              <StatLoading />
            ),
          },
          {
            label: "Model",
            value: "v5",
            hint: SENTINEL_MODEL.name,
          },
          {
            label: "Blocks at",
            value: s?.blockThreshold ? `${Math.round(s.blockThreshold * 100)}%` : "70%",
            hint: "confidence it was manipulated",
          },
          {
            label: "Checks today",
            value: s ? s.last24h.checks.toLocaleString() : status.isError ? "—" : <StatLoading />,
            ...(s ? { hint: `${s.last24h.blocked.toLocaleString()} blocked, last 24 hours` } : {}),
          },
        ]}
      />
      <ErrorText error={status.error} />

      {s?.fallback ? (
        <Section
          label="Second opinion"
          title="Laya first, a second opinion when unsure"
          intro={`Uncertain checks go to ${s.fallback.model}. Those checks share the mandate, proposed action and outside inputs with the model provider. The vault still decides payouts.`}
        >
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
        </Section>
      ) : null}

      <Section label="The check" title="How a check works">
        <ol className="grid gap-x-8 gap-y-8 md:grid-cols-2 xl:grid-cols-4">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="border-t border-line pt-5">
              <span className="eyebrow">{String(i + 1).padStart(2, "0")}</span>
              <p className="mt-4 text-[19px] leading-snug font-medium tracking-[-0.03em]">
                {title}
              </p>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{text}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        label="Testing"
        title="How v5 was tested"
        intro="Five gates before it went live, each run on v5 and on the previous model, v1."
      >
        {/* Cells share four rows, so names, numbers and labels line up across a row of gates. */}
        <ul className="grid gap-x-10 md:grid-cols-2 lg:grid-cols-3">
          {SENTINEL_GATES.map((g) => (
            <li
              key={g.name}
              className="row-span-4 grid grid-rows-subgrid border-t border-line pt-5 pb-12"
            >
              <span>
                <Badge tone={g.passed ? "brand" : "warn"} dot>
                  {g.passed ? "Passed" : "Exception"}
                </Badge>
              </span>
              <p className="mt-4 text-[19px] leading-snug font-medium tracking-[-0.03em]">
                {g.name}
              </p>
              <p className="mt-2 max-w-[40ch] text-[15px] leading-relaxed text-muted">{g.what}</p>
              <div className="mt-6">
                <p className="flex items-baseline gap-3 tabular-nums">
                  <span className="num-giant">{g.after}</span>
                  <span className="font-mono text-[12px] text-muted">
                    v1 <span className="text-soft">{g.before}</span>
                  </span>
                </p>
                <p className="mt-2.5 text-[13px] text-muted">{g.measure}</p>
              </div>
            </li>
          ))}
          <li className="row-span-4 flex flex-col border-t border-line pt-5 pb-12">
            <p className="eyebrow">Verdict</p>
            <p className="num-giant mt-4">4 of 5 passed</p>
            <p className="mt-auto pt-6 text-[15px] leading-relaxed text-muted">
              The stress suite improved overall but got worse in 2 of its 44 families. v5 went live
              with that exception recorded, and the next model targets those families.
            </p>
          </li>
        </ul>
      </Section>

      <Section label="Use it" title="Rate your agent with Sentinel on">
        <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div>
            <p className="max-w-[48ch] text-[15px] leading-relaxed text-muted">
              Choose it when you onboard an agent. Your agent then asks Sentinel before each trade.
            </p>
            <Link to="/agents/new" className={`mt-6 ${buttonClass("primary")}`}>
              Onboard an agent
            </Link>
          </div>
          <ul className="border-b border-line">
            {RATED_WITH.map(([title, text]) => (
              <li key={title} className="border-t border-line py-5">
                <span className="block text-[17px] font-medium tracking-[-0.02em]">{title}</span>
                <span className="mt-1.5 block text-[15px] leading-relaxed text-muted">{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </Page>
  );
}
