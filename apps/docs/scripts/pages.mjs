/**
 * Which repository documents become pages, and where. The repo's Markdown stays the single
 * source: the site is generated from it, so the two cannot drift.
 *
 * `src` is relative to the repository root; `slug` is the page's path under /docs/.
 */
export const PAGES = [
  { src: "README.md", slug: "overview/introduction", label: "Introduction", title: "Introduction" },
  {
    src: "docs/YOUR-AGENTS.md",
    slug: "overview/your-agents",
    label: "Bonded and your agents",
  },
  {
    src: "docs/SPECIFICATION.md",
    slug: "overview/specification",
    label: "Product specification",
    title: "Product specification",
  },

  { src: "docs/ARCHITECTURE.md", slug: "concepts/architecture", label: "Architecture" },
  {
    src: "docs/SCORING.md",
    slug: "concepts/scoring",
    label: "Security, Task and insurance scores",
  },
  { src: "docs/S1-TAXONOMY.md", slug: "concepts/s1-taxonomy", label: "S1 market-data attacks" },
  { src: "docs/AGENTS.md", slug: "concepts/agents", label: "Agents" },
  { src: "docs/OFFCHAIN.md", slug: "concepts/offchain", label: "Off-chain agents" },
  { src: "docs/BROKERAGE.md", slug: "concepts/brokerage", label: "Stock-trading agents" },
  { src: "docs/SANDBOX-SECURITY.md", slug: "concepts/sandbox-security", label: "Sandbox security" },
  { src: "docs/INDEX.md", slug: "concepts/bonded-index", label: "Bonded Index" },
  {
    src: "docs/ADAPTIVE-ATTACKER.md",
    slug: "concepts/adaptive-attacker",
    label: "Adaptive attacker",
  },
  { src: "docs/HARBINGER.md", slug: "concepts/harbinger", label: "Harbinger" },
  { src: "docs/CALIBRATION.md", slug: "concepts/calibration", label: "Calibration" },
  { src: "docs/COVERAGE.md", slug: "concepts/coverage", label: "Coverage" },
  { src: "contracts/evm/README.md", slug: "concepts/contracts", label: "Smart contracts" },
  {
    src: "docs/BOUNTIES-EXPLAINED.md",
    slug: "concepts/bounties-explained",
    label: "How bounties work",
  },

  {
    src: "docs/BRING-YOUR-OWN-AGENT.md",
    slug: "guides/bring-your-own-agent",
    label: "Bring your own agent",
  },
  {
    src: "docs/CONNECTING-YOUR-AGENT.md",
    slug: "guides/connecting-your-agent",
    label: "Connecting your agent",
  },
  {
    src: "docs/AGENT-FRAMEWORKS.md",
    slug: "guides/agent-frameworks",
    label: "Framework recipes",
  },
  {
    src: "docs/PREVIEWS-AND-RATINGS.md",
    slug: "guides/previews-and-ratings",
    label: "Previews and official ratings",
  },
  {
    src: "docs/OFFICIAL-RATINGS.md",
    slug: "guides/official-ratings",
    label: "Official ratings",
  },
  {
    src: "docs/PREVIEWS-AND-RATINGS-REFERENCE.md",
    slug: "guides/previews-and-ratings-reference",
    label: "Ratings reference",
  },
  {
    src: "docs/PROTECT-YOUR-AGENT.md",
    slug: "guides/protect-your-agent",
    label: "Protect your agent",
  },
  {
    src: "docs/ACCOUNTS.md",
    slug: "guides/signing-in",
    label: "Signing in without a wallet",
    title: "Signing in without a wallet",
  },
  {
    src: "docs/HOSTED-AGENTS.md",
    slug: "guides/bonded-runs-it",
    label: "Bonded runs it",
    title: "Bonded runs it: hosted agents",
  },
  {
    src: "docs/APPROVAL-IN-TESTS.md",
    slug: "guides/approval-in-tests",
    label: "Approval in tests",
    title: "How approval works in a test",
  },
  {
    src: "docs/DATA-HANDLING.md",
    slug: "guides/your-data",
    label: "Privacy and your data",
    title: "Privacy: how Bonded handles your data",
  },
  {
    src: "docs/PAYMENT-GATE.md",
    slug: "guides/payment-gate",
    label: "Payment gate",
    title: "Payment gate",
  },
  {
    src: "docs/TROUBLESHOOTING.md",
    slug: "guides/troubleshooting",
    label: "Troubleshooting",
    title: "Troubleshooting",
  },
  { src: "docs/DEVELOPING.md", slug: "guides/developing", label: "Developing Bonded" },
  {
    src: "docs/DEVELOPING-REFERENCE.md",
    slug: "guides/developing-reference",
    label: "Developer reference",
  },
  { src: "docs/BOUNTIES.md", slug: "guides/bounties", label: "Submit a bounty attack" },
  {
    src: "docs/TEE.md",
    slug: "guides/tee",
    label: "TEE custody",
    title: "TEE custody",
  },

  { src: "docs/SENTINEL.md", slug: "sentinel/overview", label: "How Sentinel works" },
  { src: "docs/SENTINEL-STRESS.md", slug: "sentinel/stress-suite", label: "Stress suite" },

  {
    src: "SECURITY.md",
    slug: "security/policy",
    label: "Security policy",
    title: "Security policy",
  },
  { src: "docs/AUDIT.md", slug: "security/audit", label: "Internal audit note" },
  { src: "docs/disclosures/README.md", slug: "security/disclosures", label: "Disclosure policy" },
  {
    src: "docs/disclosures/OFFCHAIN.md",
    slug: "security/disclosures/offchain",
    label: "Off-chain disclosure",
  },
  {
    src: "docs/disclosures/agentkit-langchain-chatbot.md",
    slug: "security/disclosures/agentkit-langchain-chatbot",
    label: "Coinbase AgentKit",
  },
  {
    src: "docs/disclosures/solana-agent-kit-langgraph.md",
    slug: "security/disclosures/solana-agent-kit-langgraph",
    label: "Solana Agent Kit",
  },

  {
    src: "packages/sdk/README.md",
    slug: "reference/sdk",
    label: "SDK (@bondedhq/sdk)",
    title: "@bondedhq/sdk",
  },
  {
    src: "apps/runner/README.md",
    slug: "reference/runner",
    label: "Runner (@bondedhq/runner)",
    title: "@bondedhq/runner",
  },
  {
    src: "contracts/evm/deployments/README.md",
    slug: "reference/deployments",
    label: "Deployments",
  },

  {
    src: "docs/internals/OFFCHAIN-SCENARIOS.md",
    slug: "internals/offchain-scenarios",
    label: "Off-chain: jobs, attacks, channels",
  },
  {
    src: "docs/internals/OFFCHAIN-TOOLING.md",
    slug: "internals/offchain-tooling",
    label: "Off-chain: running and tooling",
  },
  {
    src: "docs/internals/ADAPTIVE-ATTACKER-RESULTS.md",
    slug: "internals/adaptive-attacker-results",
    label: "Adaptive attacker: results",
  },
  {
    src: "docs/internals/BROKERAGE-DETAILS.md",
    slug: "internals/brokerage-details",
    label: "Stock-trading: details",
  },
  {
    src: "docs/internals/SCORING-BATTERIES.md",
    slug: "internals/scoring-batteries",
    label: "Scoring: S1, memory and world-state",
  },
  {
    src: "docs/internals/SENTINEL-AUDITS.md",
    slug: "internals/sentinel-audits",
    label: "Sentinel: stress-suite audits",
  },
  {
    src: "docs/internals/SENTINEL-TRAINING-HISTORY.md",
    slug: "internals/sentinel-training-history",
    label: "Sentinel: training history",
  },
  {
    src: "docs/internals/SENTINEL-DATA-AND-EVAL.md",
    slug: "internals/sentinel-data-and-eval",
    label: "Sentinel: payments data and cascade",
  },
];

/**
 * How a long section of the sidebar is split into smaller groups, in order. A page of the
 * section that no group names still shows, after the groups, so a new page is never lost.
 * Slugs are the page's path under /docs/ without the section: `concepts/scoring` is `scoring`.
 */
export const SIDEBAR_GROUPS = {
  concepts: [
    {
      label: "What we rate",
      slugs: ["agents", "offchain", "brokerage", "bonded-index"],
    },
    {
      label: "How ratings work",
      slugs: [
        "scoring",
        "s1-taxonomy",
        "calibration",
        "coverage",
        "adaptive-attacker",
        "harbinger",
      ],
    },
    {
      label: "How it is built",
      slugs: ["architecture", "contracts", "sandbox-security", "bounties-explained"],
    },
  ],
  guides: [
    {
      label: "Get your agent rated",
      slugs: [
        "bring-your-own-agent",
        "connecting-your-agent",
        "agent-frameworks",
        "previews-and-ratings",
        "official-ratings",
        "previews-and-ratings-reference",
        "approval-in-tests",
        "protect-your-agent",
      ],
    },
    { label: "Accounts and billing", slugs: ["signing-in", "bonded-runs-it", "payment-gate"] },
    { label: "Privacy and custody", slugs: ["your-data", "tee"] },
    {
      label: "Help and contributing",
      slugs: ["troubleshooting", "developing", "developing-reference", "bounties"],
    },
  ],
};

/** Folders whose Markdown files each become a page, in file-name order. None for now. */
export const FOLDERS = [];

/** Where evidence files live on the site. Linked from the notes that cite them. */
export const EVIDENCE_DIRS = [
  { from: "docs/progress/evidence", to: "evidence" },
  // Committed deployments only (<chainId>.json): never a pending file or the git-ignored sandbox/
  // folder a local Arena run writes to.
  {
    from: "contracts/evm/deployments",
    to: "evidence/deployments",
    only: /^contracts\/evm\/deployments\/\d+\.json$/,
  },
  { from: "contracts/solana/deployments", to: "evidence/solana", only: /\.json$/ },
  // Diagrams the docs pages show, so the same relative link works on GitHub and on the site.
  { from: "docs/images", to: "images", only: /\.(jpe?g|png|webp|svg)$/ },
];

/** How a doc is named in running prose when a bare mention of its file turns into a link. */
export const SHORT_NAMES = {
  "README.md": "the introduction",
  "SECURITY.md": "the security policy",
  "docs/SPECIFICATION.md": "the product specification",
  "docs/ARCHITECTURE.md": "the architecture page",
  "docs/AGENTS.md": "the agents page",
  "docs/OFFCHAIN.md": "the off-chain page",
  "docs/INDEX.md": "the Index page",
  "docs/internals/OFFCHAIN-SCENARIOS.md": "the off-chain jobs and attacks page",
  "docs/internals/OFFCHAIN-TOOLING.md": "the off-chain tooling page",
  "docs/internals/ADAPTIVE-ATTACKER-RESULTS.md": "the adaptive attacker results page",
  "docs/internals/BROKERAGE-DETAILS.md": "the brokerage details page",
  "docs/internals/SCORING-BATTERIES.md": "the scoring batteries page",
  "docs/internals/SENTINEL-AUDITS.md": "the Sentinel audits page",
  "docs/internals/SENTINEL-TRAINING-HISTORY.md": "the Sentinel training history page",
  "docs/internals/SENTINEL-DATA-AND-EVAL.md": "the Sentinel data and cascade page",
  "docs/ADAPTIVE-ATTACKER.md": "the adaptive attacker page",
  "docs/HARBINGER.md": "the Harbinger page",
  "docs/CALIBRATION.md": "the calibration page",
  "docs/COVERAGE.md": "the coverage page",
  "docs/SCORING.md": "the scoring page",
  "docs/S1-TAXONOMY.md": "the S1 coverage map",
  "docs/YOUR-AGENTS.md": "Bonded and your agents",
  "docs/BRING-YOUR-OWN-AGENT.md": "the bring-your-own-agent guide",
  "docs/CONNECTING-YOUR-AGENT.md": "the connecting guide",
  "docs/AGENT-FRAMEWORKS.md": "the framework recipes",
  "docs/PREVIEWS-AND-RATINGS.md": "the previews and ratings guide",
  "docs/PROTECT-YOUR-AGENT.md": "the protect-your-agent guide",
  "docs/SANDBOX-SECURITY.md": "the sandbox security page",
  "docs/BROKERAGE.md": "the stock-trading page",
  "docs/HOSTED-AGENTS.md": "the Bonded-runs-it guide",
  "docs/ACCOUNTS.md": "signing in without a wallet",
  "docs/APPROVAL-IN-TESTS.md": "how approval works in a test",
  "docs/DATA-HANDLING.md": "how Bonded handles your data",
  "docs/PAYMENT-GATE.md": "the payment gate guide",
  "docs/BOUNTIES-EXPLAINED.md": "the bounty overview",
  "docs/BOUNTIES.md": "the bounty guide",
  "docs/DEVELOPING.md": "the developer guide",
  "docs/DEVELOPING-REFERENCE.md": "the developer reference",
  "docs/OFFICIAL-RATINGS.md": "the official ratings page",
  "docs/PREVIEWS-AND-RATINGS-REFERENCE.md": "the ratings reference",
  "docs/TEE.md": "the TEE custody page",
  "docs/SENTINEL.md": "the Sentinel page",
  "docs/SENTINEL-STRESS.md": "the stress suite page",
  "docs/AUDIT.md": "the audit note",
  "docs/disclosures/README.md": "the disclosure policy",
  "docs/disclosures/OFFCHAIN.md": "the off-chain disclosure policy",
  "contracts/evm/README.md": "the contracts page",
  "contracts/evm/deployments/README.md": "the deployments page",
  "packages/sdk/README.md": "the SDK reference",
  "apps/runner/README.md": "the runner reference",
};

/** Sections left out of the site. */
export const DROP_SECTIONS = {
  "docs/DEVELOPING.md": ["The documentation site"],
};
