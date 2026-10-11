import type { ReactNode } from "react";
import { Link } from "react-router";
import { TIER_RULES } from "@bondedhq/shared";
import { Collapsible } from "../components/collapsible";
import { CopyBlock } from "../components/copy";
import { FrameworkLogo } from "../components/framework-questions";
import { buttonClass, tierTone } from "../components/ui";
import { FRAMEWORKS, FRAMEWORK_TEXT } from "../lib/frameworks";
import { DOCS_BYOA, DOCS_SECURITY, TEST_AGENT } from "../lib/routes";

/** What Bonded works with, logo only: the frameworks agents are built on, and the chains and accounts it runs on. */
const INTEGRATIONS = [
  { name: "ElizaOS", src: "/brand/frameworks/eliza.svg", size: "h-7 w-7" },
  {
    name: "Coinbase AgentKit",
    src: "/brand/integrations/coinbase.svg",
    size: "h-[22px] w-[123px]",
  },
  { name: "LangChain", src: "/brand/frameworks/langchain.svg", size: "h-7 w-7" },
  { name: "Vercel AI SDK", src: "/brand/frameworks/ai-sdk.svg", size: "h-6 w-6" },
  { name: "Model Context Protocol", src: "/brand/frameworks/mcp.svg", size: "h-7 w-7" },
  { name: "Python", src: "/brand/frameworks/python.svg", size: "h-7 w-7" },
  { name: "Robinhood Chain", src: "/brand/integrations/robinhood.svg", size: "h-7 w-7" },
  { name: "Ethereum", src: "/brand/integrations/ethereum.svg", size: "h-7 w-7" },
  { name: "Arbitrum", src: "/brand/integrations/arbitrum.svg", size: "h-8 w-8" },
  { name: "Solana", src: "/brand/integrations/solana.svg", size: "h-7 w-7" },
  { name: "Safe", src: "/brand/integrations/safe.svg", size: "h-8 w-8" },
] as const;

function Logo({ name, src, size }: { name: string; src: string; size: string }) {
  const url = `url(${src})`;
  return (
    <li
      title={name}
      className="mx-9 flex shrink-0 items-center text-muted transition-colors hover:text-ink sm:mx-12"
    >
      <span
        role="img"
        aria-label={name}
        className={`${size} bg-current`}
        style={{
          mask: `${url} center / contain no-repeat`,
          WebkitMask: `${url} center / contain no-repeat`,
        }}
      />
    </li>
  );
}

/**
 * A carousel of what Bonded works with, under the hero. Logos only. It runs on its own, pauses on
 * hover or focus, and is a still, wrapped row under reduced motion. The second copy is hidden from
 * assistive technology, so each name is read once.
 */
export function WorksWith() {
  return (
    <section aria-label="Works with" className="px-4 pt-20 sm:px-6">
      <p className="mx-auto max-w-xl text-center text-sm text-muted">
        Works with the frameworks agents are built on, and the chains they trade on.
      </p>
      <div className="logo-marquee mx-auto mt-8 max-w-[1180px]">
        <div className="logo-track">
          {[false, true].map((copy) => (
            <ul
              key={String(copy)}
              className="logo-copy flex shrink-0 items-center"
              {...(copy ? { "aria-hidden": true } : {})}
            >
              {INTEGRATIONS.map((l) => (
                <Logo key={l.name} {...l} />
              ))}
            </ul>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Who Bonded is for: the operator gets the large panel, depositors and underwriters share the rest. */
export function Roles() {
  return (
    <section id="who" className="mx-auto max-w-[1180px] scroll-mt-24 px-4 py-24 sm:px-6">
      <h2 className="max-w-2xl font-serif text-5xl leading-none sm:text-6xl">
        Pick your side of the loop.
      </h2>
      <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="panel relative flex flex-col justify-between gap-10 overflow-hidden bg-[radial-gradient(ellipse_at_85%_0%,rgb(29_78_216/.28),transparent_55%)] p-8 sm:p-10">
          <div>
            <h3 className="font-serif text-4xl leading-tight sm:text-5xl">Building an agent?</h3>
            <p className="mt-4 max-w-md text-lg leading-relaxed text-muted">
              Find out how it scores before it holds anyone's money. A free preview rating needs
              only a wallet. Make it official and the score goes on chain, with a vault and cover to
              match.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link to={TEST_AGENT} className={buttonClass("primary", "lg")}>
              Test your agent, free
            </Link>
            <Link to="/agents/new" className={buttonClass("secondary", "lg")}>
              Onboard an agent
            </Link>
          </div>
        </div>
        <div className="flex flex-col justify-center gap-10 lg:pl-6">
          <div>
            <h3 className="text-2xl font-bold">Putting money behind an agent?</h3>
            <p className="mt-3 max-w-md leading-relaxed text-muted">
              Choose a rated agent, deposit into its vault and buy cover priced from its score. If
              it breaks its rules, the claim is paid automatically.
            </p>
            <Link to="/vaults" className="mt-4 inline-block text-accent hover:underline">
              Browse vaults <span aria-hidden>→</span>
            </Link>
          </div>
          <div>
            <h3 className="text-2xl font-bold">Want to earn from the risk?</h3>
            <p className="mt-3 max-w-md leading-relaxed text-muted">
              Fund the pool that pays claims once the operator's bond is spent, and earn 80% of
              every premium.
            </p>
            <Link to="/underwrite" className="mt-4 inline-block text-accent hover:underline">
              Underwrite the pool <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The tiers, from the contracts' own rules, across the page as one scale. */
export function ScoreScale() {
  return (
    <section id="score" className="mx-auto max-w-[1180px] scroll-mt-24 px-4 pb-24 sm:px-6">
      <h2 className="max-w-3xl font-serif text-5xl leading-none sm:text-6xl">
        One score, the same scale for every agent.
      </h2>
      <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
        Every agent is attacked with the same published library, plus attacks held back and
        unpublished. Breach rates become an expected loss, a premium and a score from 0 to 100,
        signed so Arbitrum, Ethereum and Solana can read it. The tier sets how much bond the
        operator must stake against the cover.
      </p>
      <ol className="mt-12 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4 lg:grid-cols-7">
        {TIER_RULES.map((t, i) => {
          const above = TIER_RULES[i - 1];
          const range = above ? `${t.minScore} to ${above.minScore - 1}` : `${t.minScore} to 100`;
          const tone = tierTone(t.minScore);
          const colour =
            tone === "brand" ? "text-held" : tone === "warn" ? "text-warn" : "text-breach";
          return (
            <li key={t.tier} className="flex flex-col gap-1.5">
              <span className={`font-serif text-5xl leading-none ${colour}`}>{t.tier}</span>
              <span className="mt-2 font-mono text-sm text-soft">{range}</span>
              <span className="text-sm text-muted">
                {t.insurable
                  ? `Bond of at least ${t.minBondBps / 100}% of the cover`
                  : "Not insurable"}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-10 max-w-2xl text-sm text-muted">
        The attack library uses fixed seeds, so a score is an in-library result. Everything runs on
        testnets with test tokens.
      </p>
    </section>
  );
}

/** Bring any agent: the one command, and the frameworks it wires in. */
export function BringYourAgent() {
  return (
    <section id="bring" className="mx-auto max-w-[1180px] scroll-mt-24 px-4 pb-24 sm:px-6">
      <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <h2 className="font-serif text-5xl leading-none sm:text-6xl">
            Bring any agent, in any framework.
          </h2>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted">
            Connect it by its HTTPS address, or with a small runner next to it that connects out to
            the Arena. A connection check tells you what to fix before any rating, and the report
            shows, for each breach, what the agent read, what it did and what would have stopped it.
          </p>
          <div className="mt-8 max-w-lg">
            <CopyBlock label="Wire it into a Node agent" text="npx @bondedhq/runner init" />
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <Link to={TEST_AGENT} className={buttonClass("primary", "lg")}>
              Test your agent, free
            </Link>
            <a href={DOCS_BYOA} className="text-accent hover:underline">
              Read the guide <span aria-hidden>→</span>
            </a>
          </div>
        </div>
        <ul className="grid gap-x-8 gap-y-7 sm:grid-cols-2 lg:pt-3">
          {FRAMEWORKS.map((f) => (
            <li key={f} className="flex items-start gap-3.5">
              <span className="mt-0.5 text-soft">
                <FrameworkLogo framework={f} size="size-6" />
              </span>
              <span>
                <span className="block font-semibold">{FRAMEWORK_TEXT[f].title}</span>
                <span className="mt-0.5 block text-sm text-muted">{FRAMEWORK_TEXT[f].line}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const QUESTIONS: { q: string; a: ReactNode }[] = [
  {
    q: "Is this real money?",
    a: "Not yet. Bonded runs on Robinhood Chain testnet and Arbitrum Sepolia, with test tokens only.",
  },
  {
    q: "Who decides whether I get paid?",
    a: "The contracts do. The vault records a breach, the keeper files the claim, and the payout comes from the operator's bond first, then the cover pool. Models help find attacks and flag trades, but they never decide a payout or a pass or fail.",
  },
  {
    q: "What does the red team actually do?",
    a: "It plants instructions where the agent will read them (news, direct messages, token metadata, tool output, prices) across ten attack classes, while the agent does an ordinary task in a sandbox copy of the chain. The vault's breach log is the verdict.",
  },
  {
    q: "Can I test my agent without a vault or tokens?",
    a: "Yes. A preview rating needs only a wallet sign-in. It is scored the same way as an official rating, but it isn't on chain and can't be insured.",
  },
  {
    q: "Which chains does it use?",
    a: "The contracts are deployed on Robinhood Chain testnet and Arbitrum Sepolia. A signed score can also be posted for Arbitrum, Ethereum and Solana to read.",
  },
  {
    q: "Has it been audited?",
    a: (
      <>
        There is an internal audit note covering invariant tests, static analysis and a manual
        review, with no high-severity issues found. It is an in-house review, not an external audit.{" "}
        <a href={DOCS_SECURITY} className="text-accent hover:underline">
          Read the security policy
        </a>
        .
      </>
    ),
  },
];

/** Plain questions, answered in plain words, folded away until opened. */
export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-[1180px] scroll-mt-24 px-4 pb-24 sm:px-6">
      <h2 className="font-serif text-5xl leading-none sm:text-6xl">Questions</h2>
      <div className="mt-10 max-w-3xl divide-y divide-line">
        {QUESTIONS.map(({ q, a }) => (
          <Collapsible
            key={q}
            className="py-5"
            triggerClassName="text-lg font-semibold"
            contentClassName="pt-3 pl-5"
            summary={q}
          >
            <p className="max-w-2xl leading-relaxed text-muted">{a}</p>
          </Collapsible>
        ))}
      </div>
    </section>
  );
}
