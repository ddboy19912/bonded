import { TIER_RULES } from "@bondedhq/shared";
import { AppLink } from "../components/app-link";
import { Accordion } from "../components/collapsible";
import { CopyBlock } from "../components/copy";
import { FrameworkLogo } from "../components/framework-questions";
import { ScoreRing, Skeleton, TierBadge, tierTone } from "../components/ui";
import { useAgents, useClaims, waterfall } from "../lib/chain";
import { FRAMEWORKS, FRAMEWORK_TEXT } from "../lib/frameworks";
import { bps, usd } from "../lib/format";
import { blogPostPath, formatPostDate, useLatestPosts } from "../lib/blog";
import { Reveal } from "../lib/reveal";
import { BLOG_HOME, DOCS_BYOA, DOCS_HOME, DOCS_SECURITY, TEST_AGENT } from "../lib/routes";

/**
 * What Bonded works with: the frameworks agents are built on, and the chains and accounts it runs
 * on. `shown` is the word set beside the mark, and `wide` is a mark's width over its height where it
 * is not square (Coinbase's is its wordmark, so only "AgentKit" is set beside it).
 */
const INTEGRATIONS: { name: string; shown: string; src: string; wide?: number }[] = [
  { name: "ElizaOS", shown: "ElizaOS", src: "/brand/frameworks/eliza.svg" },
  {
    name: "Coinbase AgentKit",
    shown: "AgentKit",
    src: "/brand/integrations/coinbase.svg",
    wide: 5.6,
  },
  { name: "LangChain", shown: "LangChain", src: "/brand/frameworks/langchain.svg" },
  { name: "Vercel AI SDK", shown: "Vercel AI SDK", src: "/brand/frameworks/ai-sdk.svg" },
  { name: "Model Context Protocol", shown: "MCP", src: "/brand/frameworks/mcp.svg" },
  { name: "Python", shown: "Python", src: "/brand/frameworks/python.svg" },
  { name: "Robinhood Chain", shown: "Robinhood Chain", src: "/brand/integrations/robinhood.svg" },
  { name: "Ethereum", shown: "Ethereum", src: "/brand/integrations/ethereum.svg" },
  { name: "Arbitrum", shown: "Arbitrum", src: "/brand/integrations/arbitrum.svg" },
  { name: "Solana", shown: "Solana", src: "/brand/integrations/solana.svg" },
  { name: "Safe", shown: "Safe", src: "/brand/integrations/safe.svg" },
];

function Logo({ name, shown, src, wide }: (typeof INTEGRATIONS)[number]) {
  const url = `url(${src})`;
  const height = wide ? 0.44 : 0.78;
  return (
    <li title={name}>
      <span
        role="img"
        aria-label={name}
        style={{
          mask: `${url} center / contain no-repeat`,
          WebkitMask: `${url} center / contain no-repeat`,
          width: `${height * (wide ?? 1)}em`,
          height: `${height}em`,
        }}
      />
      {/* The mark already carries the name for assistive technology. */}
      <span aria-hidden>{shown}</span>
    </li>
  );
}

/**
 * A carousel of what Bonded works with, under the hero: each mark with its name, in the page's large
 * type. It runs on its own, pauses on hover or focus, and is a still, wrapped row under reduced
 * motion. The second copy is hidden from assistive technology, so each name is read once.
 */
export function WorksWith() {
  return (
    <section aria-label="Works with" className="l-works">
      <div className="logo-marquee">
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

/** Who Bonded is for: operators, depositors and underwriters, side by side. */
export function Roles() {
  return (
    <section id="who" className="l-sec">
      <div className="l-head">
        <p className="l-lab">Who it's for</p>
        <Reveal as="h2" className="l-h2">
          Pick your side <span className="dim">of the loop.</span>
        </Reveal>
      </div>
      <div className="l-cols l-body">
        <Reveal>
          <p className="l-lab">01 · Operators</p>
          <h3 className="l-h3 mt-5">Building an agent?</h3>
          <p>
            Find out how it scores before it holds anyone's money. A free preview rating needs only
            an email address. Make it official and the score goes on chain, with a vault and cover
            to match.
          </p>
          <div className="l-actions">
            <AppLink to={TEST_AGENT} className="l-btn l-btn-p">
              Test your agent, free
            </AppLink>
            <AppLink to="/agents/new" className="l-btn l-btn-s">
              Onboard an agent
            </AppLink>
          </div>
        </Reveal>
        <Reveal delay={90}>
          <p className="l-lab">02 · Depositors</p>
          <h3 className="l-h3 mt-5">Putting money behind an agent?</h3>
          <p>
            Choose a rated agent, deposit into its vault and buy cover priced from its insurance
            score. If it breaks its rules, the claim is paid automatically.
          </p>
          <div className="l-actions">
            <AppLink to="/vaults" className="l-link">
              Browse vaults <span aria-hidden>→</span>
            </AppLink>
          </div>
        </Reveal>
        <Reveal delay={180}>
          <p className="l-lab">03 · Underwriters</p>
          <h3 className="l-h3 mt-5">Want to earn from the risk?</h3>
          <p>
            Fund the pool that pays claims once the operator's bond is spent, and earn 80% of every
            premium.
          </p>
          <div className="l-actions">
            <AppLink to="/underwrite" className="l-link">
              Underwrite the pool <span aria-hidden>→</span>
            </AppLink>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/** Blue for the tiers that hold up, amber for the middling ones, orange for the rest. */
function tierColour(minScore: number): string {
  const tone = tierTone(minScore);
  return tone === "brand"
    ? "var(--l-blue)"
    : tone === "warn"
      ? "var(--l-amber)"
      : "var(--l-orange)";
}

/** The tiers, from the contracts' own rules, across the page as one scale. */
export function ScoreScale() {
  return (
    <section id="score" className="l-sec">
      <div className="l-head">
        <p className="l-lab">The score</p>
        <div>
          <Reveal as="h2" className="l-h2">
            Security measured. <span className="dim">Insurance priced.</span>
          </Reveal>
          <p className="l-lede">
            Every agent is attacked with the same published library, plus attacks held back and
            unpublished. The Security score measures resistance to manipulation from 0 to 100. A
            separate insurance score measures loss after containment and prices cover. These
            insurance tiers set how much bond the operator must stake against the cover.
          </p>
        </div>
      </div>
      <Reveal as="ol" className="l-tiers l-body">
        {TIER_RULES.map((t, i) => {
          const above = TIER_RULES[i - 1];
          const range = above ? `${t.minScore} to ${above.minScore - 1}` : `${t.minScore} to 100`;
          return (
            <li key={t.tier}>
              <span className="l-tier" style={{ color: tierColour(t.minScore) }}>
                {t.tier}
              </span>
              <span className="l-tier-range">{range}</span>
              <span className="l-tier-bond">
                {t.insurable
                  ? `Bond of at least ${t.minBondBps / 100}% of the cover`
                  : "Not insurable"}
              </span>
            </li>
          );
        })}
      </Reveal>
      <p className="l-lab mt-10 max-w-2xl">
        The attack library uses fixed seeds, so a score is an in-library result. Everything runs on
        testnets with test tokens.
      </p>
    </section>
  );
}

/** Bring any agent: the one command, and the frameworks it wires in. */
export function BringYourAgent() {
  return (
    <section id="bring" className="l-sec">
      <div className="l-head">
        <p className="l-lab">Bring your agent</p>
        <Reveal as="h2" className="l-h2">
          Bring any agent, <span className="dim">in any framework.</span>
        </Reveal>
      </div>
      <div className="l-body grid items-start gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-[clamp(24px,5vw,90px)]">
        <div>
          <p className="max-w-lg text-lg leading-relaxed text-muted">
            Connect it by its HTTPS address, or with a small runner next to it that connects out to
            our attack sandbox. A connection check tells you what to fix before any rating, and the
            report shows, for each breach, what the agent read, what it did and what would have
            stopped it.
          </p>
          <div className="mt-8 max-w-lg">
            <CopyBlock label="Wire it into a Node agent" text="npx @bondedhq/runner init" />
          </div>
          <div className="l-actions">
            <AppLink to={TEST_AGENT} className="l-btn l-btn-p">
              Test your agent, free
            </AppLink>
            <a href={DOCS_BYOA} className="l-link">
              Read the guide <span aria-hidden>→</span>
            </a>
          </div>
        </div>
        <ul>
          {FRAMEWORKS.map((f) => (
            <li
              key={f}
              className="grid grid-cols-[28px_minmax(0,1fr)] items-baseline gap-x-4 border-t border-line py-4 sm:grid-cols-[28px_minmax(0,2fr)_minmax(0,3fr)]"
            >
              <span className="self-center text-soft">
                <FrameworkLogo framework={f} size="size-6" />
              </span>
              <span className="text-xl font-medium tracking-[-0.03em]">
                {FRAMEWORK_TEXT[f].title}
              </span>
              <span className="col-start-2 text-sm text-muted sm:col-start-3">
                {FRAMEWORK_TEXT[f].line}
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
    a: "No. It is for any AI agent that can move money: trading bots, wallet copilots, yield and rebalancing agents, assistants that can pay for things, and agents that pay other agents. That includes agents that pay through Visa Intelligent Commerce, Mastercard Agent Pay and x402. They share one weakness: an agent that reads outside text and can also sign transactions can be talked into sending funds where it shouldn't. We test stock-trading agents on a simulated brokerage account, and crypto agents on a testnet, with everyday tasks such as rebalancing a portfolio. The Bonded Index tests agents that pay invoices, and the payment gate checks their real payments by bank, card or wallet. An agent that can't touch funds has nothing to guard.",
  },
  {
    id: "red-team",
    q: "What does the red team actually do?",
    a: "It plants instructions where the agent will read them (news, direct messages, token metadata, tool output, prices) across ten attack classes, while the agent does an ordinary task in a sandbox copy of the chain. In ratings of Bonded's own and leaderboard agents it also feeds the agent false market data (fake news, prices and numbers, with no instruction at all) and, for agents that keep notes between sessions, plants a false standing instruction to see if it acts on it another day. The Security score counts every time the agent acted on an attack, even when the vault then stopped it; the vault's breach log decides what's covered.",
  },
  {
    id: "breach",
    q: "What counts as a breach, and what isn't covered?",
    a: "A breach is the agent doing something its vault's rules forbid: a token, contract or payee that isn't allowed, or more than the per-trade or daily limit. Covered means tricked or broken, not unlucky. A bad trade that respected every rule is a market loss, and isn't covered. If false data is what talked the agent into that trade, it still lowers the agent's Security score.",
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
    q: "Can I test my agent for free?",
    a: "Yes. Sign in with your email and run a preview rating. It's scored the same way as an official rating, and only you see it.",
  },
  {
    id: "keys",
    q: "Does Bonded hold my keys or card details?",
    a: "No. An on-chain agent signs with its own key, and its vault holds the funds. The payment gate keeps only hashes of its API keys, your card program's signing secret (encrypted) or a password hash, and public wallet addresses. It can't make, fund or charge a payment.",
  },
  {
    id: "chains",
    q: "Which chains does it use?",
    a: "The contracts are deployed on Robinhood Chain testnet and Arbitrum Sepolia. A signed score can also be posted for Arbitrum, Ethereum and Solana to read. The payment gate's Watch reads USDC payments on Ethereum, Base and Arbitrum, and USDT on Ethereum and Arbitrum.",
  },
];

/**
 * The newest blog posts, read from the blog's public Sanity dataset. Hidden while loading and if
 * the request fails or there are no posts, so the page never shows an empty or broken block.
 * The cards are plain links: the blog is its own site under /blog, not a router page.
 */
export function LatestPosts() {
  const posts = useLatestPosts();
  if (!posts.data?.length) return null;
  return (
    <section id="blog" className="l-sec">
      <div className="l-head">
        <p className="l-lab">Blog</p>
        <div>
          <h2 className="l-h2">
            Notes from <span className="dim">the red team.</span>
          </h2>
          <div className="l-actions">
            <a href={BLOG_HOME} className="l-link">
              Read the blog <span aria-hidden>→</span>
            </a>
          </div>
        </div>
      </div>
      <ul className="l-body grid gap-x-8 gap-y-12 md:grid-cols-3">
        {posts.data.map((p) => (
          <li key={p.slug}>
            <a href={blogPostPath(p.slug)} className="group flex h-full flex-col gap-4">
              <img
                src={p.cover}
                alt={p.alt}
                width={800}
                height={420}
                loading="lazy"
                className="aspect-[800/420] w-full rounded-xl object-cover"
              />
              <span className="l-lab">{formatPostDate(p.publishedAt)}</span>
              <span className="text-2xl leading-tight font-medium tracking-[-0.035em] group-hover:underline">
                {p.title}
              </span>
              <span className="leading-relaxed text-muted">{p.description}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Plain questions in an accordion, one open at a time. The title and the way into the docs sit on
 * the left; the answers take the rest of the width, split by thin rules.
 */
export function Faq() {
  return (
    <section id="faq" className="l-sec">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-[clamp(24px,5vw,90px)]">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <p className="l-lab">Questions</p>
          <h2 className="l-h3 mt-4 !text-[clamp(34px,4.4vw,68px)] !leading-[0.95]">
            Frequently asked questions
          </h2>
          <p className="mt-5 max-w-sm text-lg leading-relaxed text-muted">
            The short answers. The docs go into the rest.
          </p>
          <div className="l-actions">
            <a href={DOCS_HOME} className="l-link">
              Read the docs <span aria-hidden>→</span>
            </a>
            <a href={DOCS_SECURITY} className="l-link">
              Security policy <span aria-hidden>→</span>
            </a>
          </div>
        </div>
        <Accordion
          defaultOpen="paid"
          className="flex flex-col border-b border-line"
          itemClassName="border-t border-line py-6"
          triggerClassName="text-xl font-medium tracking-[-0.03em] sm:text-2xl"
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
 * the same source as the hero's numbers. It shows only scores that are still current (the
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
    .sort((a, b) => b.score!.securityScore - a.score!.securityScore)
    .slice(0, 4);
  if (agents.data && rated.length === 0) return null;
  const reached = (c: Parameters<typeof waterfall>[0]) => waterfall(c).toVault;
  const biggest = [...(claims.data ?? [])].sort((a, b) =>
    reached(a) === reached(b) ? 0 : reached(a) > reached(b) ? -1 : 1,
  )[0];
  const w = biggest ? waterfall(biggest) : undefined;
  const sources = w ? claimSources(w.fromBond, w.fromPool) : "";
  return (
    <section id="agents" className="l-sec">
      <div className="l-head">
        <p className="l-lab">Live agents</p>
        <h2 className="l-h2">
          Scores you can check, <span className="dim">straight from the chain.</span>
        </h2>
      </div>
      <ul className="l-body grid grid-cols-2 gap-x-6 gap-y-10 border-t border-line pt-8 lg:grid-cols-4">
        {agents.data
          ? rated.map((a) => (
              <li key={String(a.agentId)}>
                <AppLink to={`/agents/${a.agentId}`} className="group flex items-center gap-4">
                  <ScoreRing score={a.score!.securityScore} size={76} />
                  <span className="flex flex-col gap-1.5">
                    <span className="text-xl font-medium tracking-[-0.03em] group-hover:underline">
                      Agent {String(a.agentId)}
                    </span>
                    <span>
                      <TierBadge score={a.score!.score} />
                    </span>
                    <span className="text-xs text-muted">
                      Insurance {a.score!.score} · loss {bps(a.score!.expectedLossBps)}
                    </span>
                  </span>
                </AppLink>
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
          <AppLink to="/claims" className="whitespace-nowrap text-accent hover:underline">
            See every claim <span aria-hidden>→</span>
          </AppLink>
        </p>
      )}
    </section>
  );
}
