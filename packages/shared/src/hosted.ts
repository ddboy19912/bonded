import { z } from "zod";
import { codeHashOf } from "./runner.js";

/**
 * Hosted agents ("Run it on Bonded"): the owner gives Bonded their agent, and Bonded runs it on its
 * own server for a test. Nothing to install, deploy or keep running. Two kinds:
 *
 * - instructions: the agent's own instructions (its system prompt) on a model the owner picks,
 *   run in Bonded's standard tool-calling loop;
 * - code: one JavaScript or TypeScript file whose default export runs one episode, sandboxed with
 *   no network and no files. It reaches the episode's tools and the picked model only through
 *   what Bonded hands it (docs/HOSTED-AGENTS.md).
 *
 * Bonded runs it, so Bonded knows exactly what ran: the code hash commits to the kind, the model
 * and the text, and is labelled "hosted".
 */

/** The models a hosted agent may run on: inexpensive ones, as on the Index's stock-trading rows. */
export const HOSTED_MODELS = [
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
  { id: "qwen/qwen3.7-flash", label: "Qwen3.7 Flash" },
  { id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash" },
  { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick" },
] as const;
export type HostedModel = (typeof HOSTED_MODELS)[number]["id"];
export const DEFAULT_HOSTED_MODEL: HostedModel = "deepseek/deepseek-v4.1-flash";

/**
 * Tests of a hosted agent run this many at a time in a preview: Bonded runs it, so it isn't one
 * operator's server taking one episode at a time. A test takes 30 to 60 s on these models, so one
 * at a time a 20-test preview would run past its time budget.
 */
export const HOSTED_PREVIEW_CONCURRENCY = 4;

/** The longest instructions a hosted agent may have, in characters. */
export const HOSTED_INSTRUCTIONS_MAX = 8_000;
/** The shortest: anything shorter can't say how the agent should work. */
export const HOSTED_INSTRUCTIONS_MIN = 20;
/** The largest code file a hosted agent may have, in characters. */
export const HOSTED_CODE_MAX = 100_000;

const model = z.enum(HOSTED_MODELS.map((m) => m.id) as [HostedModel, ...HostedModel[]], {
  error: "Pick one of the models on the list.",
});

/** A NUL character can't be stored (Postgres text): refused as the owner's input, not a 503. */
const NO_NUL = "Remove the NUL characters (\\0): they can't be saved.";

export const HostedInstructions = z.strictObject({
  kind: z.literal("instructions"),
  model,
  instructions: z
    .string()
    .trim()
    .min(HOSTED_INSTRUCTIONS_MIN, "Write at least a sentence or two of instructions.")
    .max(
      HOSTED_INSTRUCTIONS_MAX,
      `Keep the instructions under ${HOSTED_INSTRUCTIONS_MAX} characters.`,
    )
    .refine((text) => !text.includes("\u0000"), NO_NUL),
});

export const HostedCode = z.strictObject({
  kind: z.literal("code"),
  model,
  language: z.enum(["js", "ts"]),
  code: z
    .string()
    .min(1, "The file is empty.")
    .max(HOSTED_CODE_MAX, `Keep the file under ${HOSTED_CODE_MAX / 1000} KB.`)
    .refine((text) => !text.includes("\u0000"), NO_NUL),
});

/** What the owner gives Bonded to run. */
export const HostedAgentSpec = z.discriminatedUnion("kind", [HostedInstructions, HostedCode]);
export type HostedAgentSpec = z.infer<typeof HostedAgentSpec>;

/** The label for a hosted agent's model. */
export function hostedModelLabel(id: string): string {
  return HOSTED_MODELS.find((m) => m.id === id)?.label ?? id;
}

/**
 * The code hash of a hosted agent: keccak256 of `"hosted:"` and its canonical JSON (kind, model,
 * and the instructions or the code exactly as given). A new model or one changed character is a
 * new hash, so a check passes only the agent it ran.
 */
export function hostedCodeHash(spec: HostedAgentSpec): `0x${string}` {
  const canonical =
    spec.kind === "instructions"
      ? JSON.stringify({ kind: spec.kind, model: spec.model, instructions: spec.instructions })
      : JSON.stringify({
          kind: spec.kind,
          model: spec.model,
          language: spec.language,
          code: spec.code,
        });
  return codeHashOf("hosted", canonical);
}
