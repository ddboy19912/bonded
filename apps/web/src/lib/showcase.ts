import type { AgentRow } from "./chain";

/**
 * Up to three rated agents for the landing page to cycle through: the best score, the worst
 * insurable-or-not score, and one from the middle, so visitors see that scores really differ.
 * Agents without a score are skipped; ties keep the newest agent.
 */
export function showcaseAgents(rows: AgentRow[]): AgentRow[] {
  const rated = rows
    .filter((r) => r.score)
    .sort((a, b) => b.score!.securityScore - a.score!.securityScore);
  if (rated.length <= 3) return rated;
  const picks = [rated[0]!, rated[Math.floor(rated.length / 2)]!, rated[rated.length - 1]!];
  return picks.filter((p, i) => picks.indexOf(p) === i);
}
