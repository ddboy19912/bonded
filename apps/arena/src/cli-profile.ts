import { DEFAULT_CONTROLS, HOSTED_REMOTE_PROFILE, type RatingOptions } from "./rate.js";

/** Which settings `pnpm arena rate` uses: its own local ones, or a hosted rating's. */
export type RateProfile = "local" | "hosted";

/** What a rating run from the CLI uses, after its profile and flags are resolved. */
export interface RateSettings {
  profile: RateProfile;
  repeats: number;
  controls: number;
  /** The agent's time limit per episode (built-in: 300 s; remote: 240 s unless hosted). */
  episodeTimeoutMs: number;
  /** Held-out variants per attack class, for a remote agent (0 for none). */
  heldOutPerClass: number;
  /**
   * Clean/manipulated pairs per S1 (market-data) seed, folded into the Security score; 0 skips
   * the S1 battery. On by default for Bonded's own agents. Off for a remote agent, as in a hosted
   * rating, whose time budget plans only the main library for now.
   */
  s1Pairs: number;
  /**
   * Runs of each benign twin (benign.ts), for the Task score; 0 skips them. On by default, for
   * Bonded's own agents and remote ones alike, as in a hosted rating.
   */
  benignRuns: number;
  /**
   * Attempts per world-state seed (docs/WORLD-STATE.md), folded into the Security score; 0 skips
   * the battery. On by default for Bonded's own agents, off for a remote agent, as in a hosted
   * rating, whose time budget doesn't plan it yet.
   */
  worldRounds: number;
  exercise?: RatingOptions["exercise"];
  attackLiveness?: RatingOptions["attackLiveness"];
}

/** The flags that set what the hosted profile fixes. */
export interface RateFlags {
  repeats?: string;
  controls?: string;
  "episode-timeout"?: string;
  "held-out-fresh"?: string;
  "s1-pairs"?: string;
  "benign-runs"?: string;
  "world-rounds"?: string;
}

const LOCAL = {
  repeats: 1,
  controls: DEFAULT_CONTROLS,
  episodeTimeoutS: 240,
  heldOutPerClass: 1,
  s1Pairs: 2,
  benignRuns: 1,
  worldRounds: 3,
};

/**
 * Resolves `--profile` and the flags it covers. "local" (the default) keeps the CLI's own
 * defaults, each one overridable. "hosted" runs what a hosted rating of an operator-run agent runs
 * (`HOSTED_REMOTE_PROFILE`), for `--agent remote` with `rate` only, and refuses flags that would
 * change it: the point is a result that predicts the hosted one.
 */
export function rateSettings(
  profile: string | undefined,
  flags: RateFlags,
  context: { remote: boolean; command: string | undefined },
): RateSettings {
  if (profile !== undefined && profile !== "local" && profile !== "hosted")
    throw new Error("--profile must be local or hosted");
  if (profile === "hosted") {
    if (!context.remote || context.command !== "rate")
      throw new Error("--profile hosted is for rating your own agent: rate --agent remote");
    const set = (Object.keys(flags) as (keyof RateFlags)[]).filter((k) => flags[k] !== undefined);
    if (set.length)
      throw new Error(
        `--profile hosted fixes ${set.map((k) => `--${k}`).join(", ")}; leave ${set.length > 1 ? "them" : "it"} out`,
      );
    const h = HOSTED_REMOTE_PROFILE;
    return {
      profile: "hosted",
      repeats: h.repeats,
      controls: h.controls,
      episodeTimeoutMs: h.episodeTimeoutMs,
      heldOutPerClass: h.heldOutPerClass,
      s1Pairs: 0,
      benignRuns: h.benignRuns,
      worldRounds: 0,
      exercise: h.exercise,
      attackLiveness: h.attackLiveness,
    };
  }
  const s1Pairs = count(
    flags["s1-pairs"] ?? String(context.remote ? 0 : LOCAL.s1Pairs),
    "--s1-pairs",
    true,
  );
  if (context.remote && s1Pairs > 0)
    throw new Error("--s1-pairs must be 0 for remote agents; remote ratings currently run S2 only");
  const benignRuns = count(flags["benign-runs"] ?? String(LOCAL.benignRuns), "--benign-runs", true);
  const worldRounds = count(
    flags["world-rounds"] ?? String(context.remote ? 0 : LOCAL.worldRounds),
    "--world-rounds",
    true,
  );
  return {
    profile: "local",
    repeats: count(flags.repeats ?? String(LOCAL.repeats), "--repeats"),
    controls: count(flags.controls ?? String(LOCAL.controls), "--controls", true),
    episodeTimeoutMs:
      count(
        flags["episode-timeout"] ?? String(context.remote ? LOCAL.episodeTimeoutS : 300),
        "--episode-timeout",
      ) * 1000,
    heldOutPerClass: count(
      flags["held-out-fresh"] ?? String(LOCAL.heldOutPerClass),
      "--held-out-fresh",
      true,
    ),
    s1Pairs,
    benignRuns,
    worldRounds,
  };
}

/**
 * The episode time limit to pass to `rateAgent` / `runControls` for one of Bonded's own agents:
 * the `--episode-timeout` value when given, else nothing (episode.ts's 5-minute default). A remote
 * agent's limit is set on its gateway instead, so it gets nothing here.
 */
export function ownAgentTimeout(
  flags: RateFlags,
  settings: RateSettings,
  remote: boolean,
): { episodeTimeoutMs?: number } {
  return !remote && flags["episode-timeout"] ? { episodeTimeoutMs: settings.episodeTimeoutMs } : {};
}

/** The profile in a line, for the CLI to print before it rates. */
export function describeProfile(s: RateSettings): string {
  if (s.profile === "local")
    return `Profile: local (${s.repeats} ${s.repeats === 1 ? "run" : "runs"} of each attack, ${s.controls} controls, ${s.episodeTimeoutMs / 1000} s episodes, ${s.s1Pairs ? `S1 market-data battery at ${s.s1Pairs} ${s.s1Pairs === 1 ? "pair" : "pairs"} a seed` : "no S1 battery"}, ${s.benignRuns ? `benign twins ${s.benignRuns === 1 ? "once" : `${s.benignRuns} times`} each` : "no benign twins"}, ${s.worldRounds ? `world-state battery at ${s.worldRounds} ${s.worldRounds === 1 ? "attempt" : "attempts"} a seed` : "no world-state battery"}). Use --profile hosted to rate as the hosted service does.`;
  return (
    `Profile: hosted (${s.repeats} runs of each attack, ${s.episodeTimeoutMs / 1000} s episodes, ${s.controls} controls, ` +
    `${s.heldOutPerClass} held-out ${s.heldOutPerClass === 1 ? "variant" : "variants"} per class, only exposed trials count, ` +
    "refused when the agent works too rarely, or less under attack, benign twins once each, no S1 or world-state battery yet). The hosted service also rates on a fork of the live chain: add --fork robinhood to match."
  );
}

function count(value: string, flag: string, zeroOk = false): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < (zeroOk ? 0 : 1))
    throw new Error(`${flag} must be a ${zeroOk ? "whole number" : "positive whole number"}`);
  return n;
}
