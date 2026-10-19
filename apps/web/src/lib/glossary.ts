import { TIER_RULES, type Tier } from "@bondedhq/shared";

/** Plain-language meanings of the words the app uses, shown in tooltips (see `Term`). */
export const GLOSSARY = {
  mandate:
    "The rules an agent's vault enforces on chain: which tokens and contracts it may use, where funds may go, and per-trade and daily limits.",
  vault:
    "A Mandate Vault holds an agent's funds. The agent can only act through it, and the vault checks every action against the mandate.",
  breach:
    "An action that broke the mandate. The vault records it on chain, freezes the agent, and the record is what pays a claim.",
  held: "The agent was attacked and did nothing the mandate forbids.",
  control: "An episode with no attack in it, to check the agent behaves normally on a plain task.",
  episode:
    "One run of the agent in the Arena: a normal task, sometimes with an attack hidden in what it reads.",
  score:
    "The Bonded Score, 0 to 100: how well the agent resisted manipulation in the Arena — any trick it fell for pulls it down. The insurance score underneath prices cover.",
  tier: "A grade from the insurance score, AAA (best) to CCC. Lower tiers need a bigger operator bond, and CCC can't be covered.",
  bond: "Money the agent's operator stakes. On a claim it pays first, before the pool.",
  cover: "Protection for a vault's depositors: if the agent breaches, a claim pays the loss.",
  premium: "What cover costs, a yearly rate streamed from the vault. 80% goes to underwriters.",
  deductible: "The first 10% of a loss, which cover doesn't pay.",
  monitor:
    "Monitor mode: actions that break the mandate go through and are recorded, so the loss can be claimed.",
  enforce:
    "Enforce mode: actions that break the mandate are blocked (and recorded). Scores higher, but there's nothing to claim.",
  attestation: "A score signed by Bonded's attester and posted to BondedRegistry on chain.",
  reportHash:
    "A fingerprint of the full Arena report. Anyone can download the report and check it matches.",
  tee: "Trusted execution environment: the agent's key was made inside sealed hardware (Intel TDX), so the operator can't see it.",
  teeMeasurement: "A fingerprint of the exact code running in the TEE.",
  expectedLoss: "How much of the cover the Arena expects the agent to lose in a year.",
  guardian: "The vault's owner: the only one who can buy cover and unfreeze the agent.",
  agentKey: "The only key that can act for the vault: the agent's own wallet.",
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;

/** One line on what a tier means for cover, e.g. "Insurable; operator bond of at least 20% of cover". */
export function tierMeaning(tier: Tier): string {
  const rule = TIER_RULES.find((r) => r.tier === tier);
  if (!rule || !rule.insurable) return "Not insurable: report only, no cover.";
  const bond = `bond of at least ${rule.minBondBps / 100}% of cover`;
  const cap =
    rule.maxCoverBpsOfPool < 1_000
      ? `, cover capped at ${rule.maxCoverBpsOfPool / 100}% of the pool`
      : "";
  return `Insurable; ${bond}${cap}.`;
}
