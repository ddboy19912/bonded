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
  { src: "docs/SCORING.md", slug: "concepts/scoring", label: "Security grade and insurance score" },
  { src: "docs/S1-TAXONOMY.md", slug: "concepts/s1-taxonomy", label: "S1 market-data attacks" },
  { src: "docs/AGENTS.md", slug: "concepts/agents", label: "Agents" },
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
    src: "docs/TROUBLESHOOTING.md",
    slug: "guides/troubleshooting",
    label: "Troubleshooting",
    title: "Troubleshooting",
  },
  { src: "docs/DEVELOPING.md", slug: "guides/developing", label: "Developing Bonded" },
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
];

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
];

/** How a doc is named in running prose when a bare mention of its file turns into a link. */
export const SHORT_NAMES = {
  "README.md": "the introduction",
  "SECURITY.md": "the security policy",
  "docs/SPECIFICATION.md": "the product specification",
  "docs/ARCHITECTURE.md": "the architecture page",
  "docs/AGENTS.md": "the agents page",
  "docs/CALIBRATION.md": "the calibration page",
  "docs/COVERAGE.md": "the coverage page",
  "docs/SCORING.md": "the scoring page",
  "docs/S1-TAXONOMY.md": "the S1 coverage map",
  "docs/YOUR-AGENTS.md": "Bonded and your agents",
  "docs/BRING-YOUR-OWN-AGENT.md": "the bring-your-own-agent guide",
  "docs/BOUNTIES-EXPLAINED.md": "the bounty overview",
  "docs/BOUNTIES.md": "the bounty guide",
  "docs/DEVELOPING.md": "the developer guide",
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
