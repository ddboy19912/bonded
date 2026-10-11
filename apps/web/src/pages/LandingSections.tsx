import { Link } from "react-router";
import { TIER_RULES } from "@bondedhq/shared";
import { Accordion } from "../components/collapsible";
import { CopyBlock } from "../components/copy";
import { FrameworkLogo } from "../components/framework-questions";
import { ScoreRing, Skeleton, TierBadge, buttonClass, tierTone } from "../components/ui";
import { useAgents, useClaims, waterfall } from "../lib/chain";
import { FRAMEWORKS, FRAMEWORK_TEXT } from "../lib/frameworks";
import { bps, usd } from "../lib/format";
import { DOCS_BYOA, DOCS_HOME, DOCS_SECURITY, TEST_AGENT } from "../lib/routes";

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

const QUESTIONS: { id: string; q: string; a: string }[] = [
  {
    id: "paid",
    q: "Who decides whether I get paid?",
    a: "The contracts do. The vault records a breach, the keeper files the claim, and the payout comes from the operator's bond first, then the cover pool. Models help find attacks and flag trades, but they never decide a payout or a pass or fail.",
  },
  {
    id: "scope",
    q: "Is Bonded only for trading agents?",
    a: "No. It is for any AI agent that can move money: trading bots, wallet copilots, yield and rebalancing agents, assistants that can pay for things, and agents that pay other agents. They share one weakness: an agent that reads outside text and can also sign transactions can be talked into sending funds where it shouldn't. The Arena's tasks today are trading ones, such as rebalancing a portfolio, and an agent that can't touch funds has nothing for a vault to guard.",
  },
  {
    id: "red-team",
    q: "What does the red team actually do?",
    a: "It plants instructions where the agent will read them (news, direct messages, token metadata, tool output, prices) across ten attack classes, while the agent does an ordinary task in a sandbox copy of the chain. The vault's breach log is the verdict.",
  },
  {
    id: "breach",
    q: "What counts as a breach, and what isn't covered?",
    a: "A breach is the agent doing something its vault's rules forbid: a token, contract or payee that isn't allowed, or more than the per-trade or daily limit. Covered means tricked or broken, not unlucky. A bad trade that respected every rule is a market loss, and isn't covered.",
  },
  {
    id: "claims",
    q: "How fast is a claim paid, and how much?",
    a: "When the vault records a breach, the keeper files the claim within seconds, with no forms. The contracts pay the loss minus a 10% deductible, from the operator's bond first and then the pool. In a recorded run on testnet, an agent paid out 5,000 tUSDG to a lookalike address and the claim paid 4,500: 4,000 from the bond and 500 from the pool.",
  },
  {
    id: "gaming",
    q: "Can an agent game its score?",
    a: "Part of every rating uses attacks the operator couldn't study in advance, which is what stops an agent being tuned to the public library. A rating also records the code it was run on, a TEE can prove an agent is running that code, and a score expires unless the agent is rated again. It is a measured result against Bonded's attack library, not a guarantee.",
  },
  {
    id: "preview",
    q: "Can I test my agent without a vault or tokens?",
    a: "Yes. A preview rating needs only a wallet sign-in. It is scored the same way as an official rating, but it isn't on chain and can't be insured.",
  },
  {
    id: "chains",
    q: "Which chains does it use?",
    a: "The contracts are deployed on Robinhood Chain testnet and Arbitrum Sepolia. A signed score can also be posted for Arbitrum, Ethereum and Solana to read.",
  },
];

/**
 * Plain questions in an accordion, one open at a time. The title and the way into the docs sit on
 * the left; the answers take the rest of the width, and the open one is lifted onto a soft panel.
 */
export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-[1180px] scroll-mt-24 px-4 pb-24 sm:px-6">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <h2 className="font-serif text-5xl leading-none sm:text-6xl">
            Frequently asked questions
          </h2>
          <p className="mt-5 max-w-sm text-lg leading-relaxed text-muted">
            The short answers. The docs go into the rest.
          </p>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
            <a href={DOCS_HOME} className="text-accent hover:underline">
              Read the docs <span aria-hidden>→</span>
            </a>
            <a href={DOCS_SECURITY} className="text-accent hover:underline">
              Security policy <span aria-hidden>→</span>
            </a>
          </div>
        </div>
        <Accordion
          defaultOpen="paid"
          className="flex flex-col gap-2"
          itemClassName="rounded-2xl px-5 py-5 transition-colors duration-300 hover:bg-white/[0.02] sm:px-6"
          openItemClassName="bg-white/[0.045] hover:bg-white/[0.045]"
          triggerClassName="text-xl font-semibold"
          contentClassName="pt-3 pr-8"
          items={QUESTIONS.map(({ id, q, a }) => ({
            id,
            summary: q,
            content: <p className="leading-relaxed text-muted">{a}</p>,
          }))}
        />
      </div>
    </section>
  );
}

/** Where a claim's money came from, in words, leaving out a source that paid nothing. */
export function claimSources(fromBond: bigint, fromPool: bigint): string {
  const bond = fromBond > 0n ? `$${usd(fromBond, 0)} from the operator's bond` : "";
  const pool = fromPool > 0n ? `$${usd(fromPool, 0)} from the pool` : "";
  if (bond && pool) return `${bond} and ${pool}`;
  if (bond) return `all of it from the operator's bond`;
  if (pool) return `all of it from the pool`;
  return "";
}

/**
 * The agents behind the scores, and the biggest claim paid so far: real numbers from the chain,
 * the same source as the hero and the stats. It shows only scores that are still current (the
 * registry keeps the last one after it lapses, and the Agents page marks those expired), waits for
 * the data, and hides if no agent has a current score. A claim's size is what reached the vault:
 * the award less any unpaid premium netted off it, which is what the bond and the pool paid.
 */
export function LiveAgents() {
  const agents = useAgents();
  const claims = useClaims();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const rated = (agents.data ?? [])
    .filter((a) => a.score && a.score.expiresAt > now)
    .sort((a, b) => b.score!.score - a.score!.score)
    .slice(0, 4);
  if (agents.data && rated.length === 0) return null;
  const reached = (c: Parameters<typeof waterfall>[0]) => waterfall(c).toVault;
  const biggest = [...(claims.data ?? [])].sort((a, b) =>
    reached(a) === reached(b) ? 0 : reached(a) > reached(b) ? -1 : 1,
  )[0];
  const w = biggest ? waterfall(biggest) : undefined;
  const sources = w ? claimSources(w.fromBond, w.fromPool) : "";
  return (
    <section id="agents" className="mx-auto max-w-[1180px] scroll-mt-24 px-4 pt-12 pb-8 sm:px-6">
      <h2 className="max-w-2xl font-serif text-5xl leading-none sm:text-6xl">
        Scores you can check, straight from the chain.
      </h2>
      <ul className="mt-12 grid grid-cols-2 gap-x-6 gap-y-10 lg:grid-cols-4">
        {agents.data
          ? rated.map((a) => (
              <li key={String(a.agentId)}>
                <Link to={`/agents/${a.agentId}`} className="group flex items-center gap-4">
                  <ScoreRing score={a.score!.score} size={76} />
                  <span className="flex flex-col gap-1.5">
                    <span className="font-semibold group-hover:underline">
                      Agent {String(a.agentId)}
                    </span>
                    <span>
                      <TierBadge score={a.score!.score} />
                    </span>
                    <span className="text-xs text-muted">
                      Expected loss {bps(a.score!.expectedLossBps)}
                    </span>
                  </span>
                </Link>
              </li>
            ))
          : [0, 1, 2, 3].map((i) => (
              <li key={i} className="flex items-center gap-4" aria-hidden>
                <Skeleton className="size-[76px] rounded-full" />
                <span className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-3 w-12" />
                </span>
              </li>
            ))}
      </ul>
      {w && biggest && sources && (
        <p className="mt-12 max-w-3xl text-lg leading-relaxed text-muted">
          <span className="text-ink">
            {(claims.data?.length ?? 0) > 1 ? "Biggest claim paid" : "Claim paid"}, automatically:
          </span>{" "}
          ${usd(w.toVault, 0)} of a ${usd(w.loss, 0)} loss, {sources}.
          {w.premiumNetted > 0n &&
            ` The award was $${usd(biggest.payout, 0)}; $${usd(w.premiumNetted, 0)} of unpaid premium was netted off it.`}{" "}
          <Link to="/claims" className="whitespace-nowrap text-accent hover:underline">
            See every claim <span aria-hidden>→</span>
          </Link>
        </p>
      )}
    </section>
  );
}
