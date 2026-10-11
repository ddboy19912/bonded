/**
 * Every problem, warning and refusal a builder can see, with a stable `code`, the sentence (or the
 * gist of it, when the real one carries numbers or times) and what to do about it. The API puts
 * the code next to each sentence (`code` beside `error`, `issues[].code` beside check problems,
 * `problems[].code` in the health panel), the web app links each message to its entry on the
 * troubleshooting page by code (`#<code>`), and the docs page is built from `PROBLEMS`.
 *
 * Codes never change once published: a new message gets a new entry. `match` is how a sentence
 * the services already produce is recognised, so codes don't depend on every call site.
 */

export type ProblemArea =
  | "sign-in"
  | "requests"
  | "registration"
  | "connection"
  | "check"
  | "rating"
  | "cover"
  | "vault"
  | "notifications"
  | "service";

export interface ProblemEntry {
  code: string;
  area: ProblemArea;
  /** The message, or its gist when the real one carries numbers, ids or times. */
  sentence: string;
  /** What to do about it, in plain words. */
  fix: string;
  /** How the sentences the services produce are recognised. The first entry that matches wins. */
  match: readonly RegExp[];
}

/** The catch-all for a sentence no entry recognises (it still has its own words). */
export const UNKNOWN_PROBLEM = "other";

const entry = (
  code: string,
  area: ProblemArea,
  sentence: string,
  fix: string,
  ...match: RegExp[]
): ProblemEntry => ({ code, area, sentence, fix, match });

/** Ordered: specific entries before general ones. */
export const PROBLEMS: readonly ProblemEntry[] = [
  // Sign-in and signed requests.
  entry(
    "session-ended",
    "sign-in",
    "Your session has ended. Sign in again.",
    "Sign in with your wallet again; sessions last 12 hours.",
    /session has ended/i,
  ),
  entry(
    "not-signed-in",
    "sign-in",
    "You aren't signed in.",
    "Sign in with your wallet on the page, then try again.",
    /aren't signed in|sign in with your wallet first|^unauthorized$/i,
  ),
  entry(
    "sign-in-other-chain",
    "sign-in",
    "That sign-in is for another chain.",
    "Switch your wallet to the chain the page uses and sign in again.",
    /sign-in is for another chain/i,
  ),
  entry(
    "too-many-sign-ins",
    "sign-in",
    "Too many sign-ins from this wallet. Try again in an hour.",
    "Wait an hour, or keep the session you already have open.",
    /too many sign-ins/i,
  ),
  entry(
    "signature-expired",
    "sign-in",
    "The signed request has expired. Sign it again.",
    "Sign again: a signed request is good for a few minutes. Check your computer's clock if it keeps happening.",
    /signed (request|check) has expired/i,
  ),
  entry(
    "signature-reused",
    "sign-in",
    "That signed request was already used. Sign it again.",
    "Sign again: each signature can be used once.",
    /signed request was already used/i,
  ),
  entry(
    "bad-signature",
    "sign-in",
    "The signature isn't valid.",
    "Sign with the wallet that owns the agent, on the right chain, and don't edit the message.",
    /signature (isn't|is not) (valid|from that wallet)/i,
    /sign with the vault's agent key/i,
  ),
  entry(
    "stream-token-expired",
    "sign-in",
    "That stream token has expired. Ask for a new one.",
    "Reload the page: it asks for a new stream token.",
    /stream token has expired/i,
  ),

  // Limits and malformed requests.
  entry(
    "preview-limit",
    "requests",
    "You can start (or run) only so many previews a day.",
    "Wait until the time the message gives, or make the agent official to rate it without the preview limit.",
    /at most \d+ previews? (a day|ratings? a day)|preview ratings are used up/i,
  ),
  entry(
    "check-limit",
    "requests",
    "You can run only so many connection checks an hour.",
    "Wait until the time the message gives. A passing check stays good for 24 hours.",
    /at most \d+ checks an hour|too many checks|connection checks are busy/i,
  ),
  entry(
    "url-verify-limit",
    "requests",
    "Your Agent URL has been checked too often this hour.",
    "Wait an hour before verifying the URL again.",
    /checked too often this hour|can be checked at most/i,
  ),
  entry(
    "rating-cooldown",
    "requests",
    "An agent can be rated only so often; the next rating time is given.",
    "Wait until the time the message gives.",
    /one rating .* per agent; next at|rating (is|was) (queued|running) already|already has a rating queued or running/i,
  ),
  entry(
    "stream-limit",
    "requests",
    "Too many live streams are open.",
    "Close other tabs showing live progress, then reload.",
    /too many live streams/i,
  ),
  entry(
    "rate-limited",
    "requests",
    "Too many requests. Try again in a few minutes.",
    "Wait a few minutes; the limit is per address.",
    /too many (requests|quote requests|reveal requests)/i,
  ),
  entry(
    "body-too-large",
    "requests",
    "The request body is too large.",
    "Send less: request bodies are capped (16 KB; 256 KB for Sentinel checks).",
    /is over \d+ KB/i,
  ),
  entry(
    "invalid-request",
    "requests",
    "The request isn't valid.",
    "Check the fields against the API reference; unknown fields are refused.",
    /^invalid request$/i,
    /^spec \d+:/,
    /must be between a day and a year/i,
  ),

  // Registration, ownership and the vault or module.
  entry(
    "not-owner",
    "registration",
    "Only the agent's owner (or the vault's guardian) can do that.",
    "Connect the wallet that owns the agent in the registry (or guards the vault).",
    /only the (agent's owner|vault's guardian|module's guardian)/i,
  ),
  entry(
    "not-own-agent",
    "registration",
    "This agent isn't registered as your own agent.",
    'Register it with "Make it official" (or POST /self/agents) first.',
    /isn't registered as your own agent|runner tokens are for agents registered as your own agent|register the agent for ratings first/i,
  ),
  entry(
    "operator-managed",
    "registration",
    "This agent is managed by Bonded's operator.",
    "Nothing to do: Bonded's own agents are configured by the operator.",
    /managed by Bonded's operator/i,
  ),
  entry(
    "vault-invalid",
    "registration",
    "That address is not a Bonded vault or mandate module.",
    "Use the address the factory created for this agent (shown after onboarding).",
    /not a Bonded (vault|mandate module)/i,
  ),
  entry(
    "vault-wrong-agent",
    "registration",
    "The vault or module belongs to another agent.",
    "Register the vault created for this agent id, or create a new one for it.",
    /(vault|module) belongs to another agent|vault doesn't belong to this agent/i,
  ),
  entry(
    "mandate-mismatch",
    "registration",
    "The mandate doesn't match what the vault or module enforces.",
    "Register exactly the mandate the vault was created with; its rules can't change afterwards.",
    /mandate doesn't match|vault enforces different rules|mandate is for another chain or agent/i,
  ),
  entry(
    "vault-creation-unreadable",
    "registration",
    "The vault's creation couldn't be checked.",
    "Create the vault by calling the factory directly (not through another contract), then register it.",
    /vault's creation (wasn't found|call couldn't be read)|create the vault by calling the factory directly/i,
  ),
  entry(
    "modules-unavailable",
    "registration",
    "Smart-account modules aren't deployed on this chain yet.",
    "Use a Mandate Vault instead.",
    /modules aren't deployed/i,
  ),
  entry(
    "owner-changed",
    "registration",
    "The agent changed hands since it was registered.",
    "The new owner registers the agent again.",
    /changed hands/i,
  ),
  entry(
    "tee-needs-runner",
    "registration",
    "A TEE-bound agent is rated in chain mode, through its runner, with a declared code hash.",
    "Use the runner in chain mode and declare the code hash your TEE reports.",
    /TEE-bound agent/i,
  ),
  entry(
    "tee-binding-failed",
    "rating",
    "TEE binding failed: the evidence didn't match the rated deployment.",
    "Redeploy the reviewed compose file, then rate again.",
    /TEE binding failed|TEE runs different code/i,
  ),

  // Reaching the agent.
  entry(
    "runner-token-invalid",
    "connection",
    "That runner token isn't valid: it was revoked, replaced or its preview ended.",
    "Create a new runner token on the agent's (or preview's) page and use that.",
    /runner token isn't valid|send your runner token/i,
  ),
  entry(
    "runner-token-missing",
    "connection",
    "Create a runner token first, then start the runner.",
    "Create a runner token on the agent's page and start the runner with the command shown.",
    /create a runner token first/i,
  ),
  entry(
    "wrong-mode",
    "connection",
    "The agent runs in the other mode (tools or chain) from the one it is registered for.",
    "In tools mode trades are tool calls; in chain mode they are transactions signed and sent through the RPC endpoint. Restart the runner with the right --mode, or set the agent up for the registered mode.",
    /runner is (connected in the wrong mode|in \w+ mode)/i,
    /as a tool, but in chain mode|tried the rpc endpoint/i,
  ),
  entry(
    "runner-busy",
    "connection",
    "The runner is busy with another episode.",
    "Wait for it to finish, then try again.",
    /runner is busy/i,
  ),
  entry(
    "runner-could-not-start",
    "check",
    "The runner couldn't start your agent.",
    "Run the agent command yourself in the same folder to see the error, then fix it and check again.",
    /runner couldn't start your agent/i,
  ),
  entry(
    "runner-not-connected",
    "connection",
    "The runner isn't connected.",
    "Start the runner with your token (keep it running as a service), then try again.",
    /runner (isn't|is not) connected|runner disconnected|no runner is connected/i,
  ),
  entry(
    "agent-url-missing",
    "connection",
    "Set your Agent URL first.",
    "Add your agent's HTTPS endpoint on the agent's page.",
    /set your agent url first/i,
  ),
  entry(
    "agent-url-unverified",
    "connection",
    "The Agent URL isn't verified yet.",
    "Give your agent the secret, then press Verify so Bonded can check its answer.",
    /verify your agent url first|url isn't (verified|set and verified)|agent url isn't verified/i,
  ),
  entry(
    "agent-url-secret-unusable",
    "connection",
    "The stored Agent URL secret can't be used.",
    "Set the Agent URL again to get a new secret.",
    /secret can't be used/i,
  ),
  entry(
    "agent-url-no-version",
    "connection",
    "The Agent URL reported no version, so there is no code hash.",
    "Report a version in your verify answer, or declare a code hash.",
    /reported no version/i,
  ),
  entry(
    "connection-kind-mismatch",
    "connection",
    "This agent connects the other way (runner or Agent URL).",
    "Use the connection the agent was set up with, or switch it on the agent's page.",
    /connects by its agent url|connects with the runner|reached by its agent url, so it has no runner|is rated through its runner, not an agent url/i,
  ),
  entry(
    "url-slow",
    "connection",
    "Your URL didn't answer in time.",
    "Answer within the time given (10 seconds for verify); do slow work after answering.",
    /didn't answer within \d+ seconds/i,
  ),
  entry(
    "url-closed",
    "connection",
    "Your URL closed the connection before answering.",
    "Check your server's logs: it dropped the request (a crash, a proxy timeout or a body size limit).",
    /closed the connection before answering/i,
  ),
  entry(
    "url-certificate",
    "connection",
    "Your URL's TLS certificate wasn't accepted.",
    "Serve a valid certificate for the host name (not self-signed, not expired).",
    /tls certificate/i,
  ),
  entry(
    "agent-secret",
    "connection",
    "Your URL refused Bonded's signed call: it isn't using the agent secret Bonded gave you.",
    "Set the agent secret from the Agent URL page in your agent and check the bonded-signature header with it.",
    /answered (401|403)|check that your agent uses the agent secret/i,
  ),
  entry(
    "verify-answer",
    "connection",
    "Your URL answered the verify check, but not correctly.",
    'Answer verify with 200 and JSON { challenge, proof } (proof = HMAC-SHA256 of "verify." + challenge with your secret).',
    /answered (\d+ )?(to )?the check|without proving it holds the agent secret|answered the check, but not with JSON/i,
  ),
  entry(
    "url-not-public",
    "connection",
    "That URL can't be used: it must be public https on the standard port, and not one of Bonded's.",
    "Use a public https URL on port 443 with no user name, password or #fragment, that resolves to a public address.",
    /^that isn't a url|your url (is (too long|longer|one of)|must|can't)|isn't reachable on the public internet|redirect/i,
  ),
  entry(
    "url-unreachable",
    "connection",
    "Bonded couldn't reach your URL.",
    "Check the URL is up and answers POST from the internet (no firewall or allowlist in the way).",
    /nothing accepted a connection|couldn't reach your url|verification couldn't run|your url answered|answer was over|called your url too often/i,
  ),
  entry(
    "agent-urls-off",
    "service",
    "Agent URL mode and webhooks are off on this service.",
    "Use the runner instead; the operator has to set AGENT_URL_SECRET_KEY for URLs and webhooks.",
    /AGENT_URL_SECRET_KEY/,
  ),
  entry(
    "checks-unavailable",
    "service",
    "Connection checks aren't available on this rating service yet.",
    "Try later; the operator has to run the Arena Gateway.",
    /connection checks aren't available/i,
  ),
  entry(
    "gateway-unavailable",
    "service",
    "The rating worker has no Arena Gateway, so it can't rate an agent its operator runs.",
    "Try later; the operator has to run the Arena Gateway.",
    /gateway not available/i,
  ),
  entry(
    "needs-check",
    "check",
    "Run a connection check first.",
    "Run a check of this exact connection (same token or URL, mode and code); a pass lasts 24 hours.",
    /run a connection check (first|of this connection first)/i,
  ),
  entry(
    "check-running",
    "check",
    "A check is already running for this agent.",
    "Wait for its result.",
    /check is already running/i,
  ),
  entry(
    "code-changed",
    "rating",
    "The agent now reports different code than when the rating was queued.",
    "Run a connection check of the code that runs now, then rate again.",
    /now reports different code/i,
  ),
  entry(
    "no-code-hash",
    "rating",
    "No code hash: none was reported when the rating was queued.",
    "Update @bondedhq/runner (it reports one), or declare a code hash, then rate again.",
    /no code hash/i,
  ),

  // What a connection check finds.
  entry(
    "timed-out",
    "check",
    "It didn't finish within the episode's time.",
    "Post to the episode's done URL (or exit) when the agent has finished.",
    /didn't finish within \d+ seconds|^timed out after/i,
  ),
  entry(
    "agent-exited",
    "check",
    "It exited or was stopped before finishing.",
    "Read its output in the check, fix the crash, and check again.",
    /exited with code|was stopped by \w+ before finishing/i,
  ),
  entry(
    "never-called-a-tool",
    "check",
    "Your agent never called a tool.",
    "Read and trade through the episode's MCP or HTTP endpoints (isBondedEpisode() in @bondedhq/sdk).",
    /never called a tool/i,
  ),
  entry(
    "no-trade",
    "check",
    "It didn't make the trade its task names.",
    "Make sure the agent does the task it's given (the trade named in the goal).",
    /didn't make the trade its task names/i,
  ),
  entry(
    "benign-breach",
    "check",
    "Its actions broke the mandate in a benign episode.",
    "Keep trades inside the mandate (tokens, caps, destinations); a rating counts this against it.",
    /broke the mandate in a benign episode/i,
  ),
  entry(
    "unread-surfaces",
    "check",
    "It didn't read every surface; unread ones are scored as untested.",
    "Have the agent check its messages, news, prices and other reads before trading.",
    /read \d+ of \d+ surfaces/i,
  ),
  entry(
    "tool-calls-failed",
    "check",
    "Some tool calls failed.",
    "Check the arguments the agent passes; the first failure is quoted.",
    /tool call\S* failed/i,
  ),
  entry(
    "transactions-refused",
    "check",
    "Some transactions were refused.",
    "Sign for the episode's chain with the episode's key and call only the vault's execute.",
    /transaction\S* (was |were )?refused/i,
  ),
  entry(
    "usage-not-reported",
    "check",
    "If your agent uses a model, report its usage at /done.",
    "A note, not a problem: send usage ({ inputTokens, outputTokens, costUsd }) with done for a cost estimate. An agent with no model can leave it out; the estimate then gives time only.",
    /didn't report its model usage|if your agent uses a model, report its usage/i,
  ),
  entry(
    "episode-failed",
    "check",
    "The episode failed.",
    "Read the reason given; run the agent locally with the same input to reproduce it.",
    /the episode failed/i,
  ),

  // Ratings.
  entry(
    "fork-budget-spent",
    "rating",
    "The agent used up its share of fork requests.",
    "Make fewer chain reads per episode (cache what doesn't change).",
    /share of fork requests/i,
  ),
  entry(
    "bonded-url-failure",
    "rating",
    "Bonded couldn't reach the agent's URL; not the agent's fault, it will be retried.",
    "Nothing to do: it is retried.",
    /bonded couldn't (reach|call) the agent's url/i,
  ),
  entry(
    "rating-over-budget-agent",
    "rating",
    "The rating ran past its time budget, and the agent took most of the time.",
    "Make each episode faster (fewer model calls, a faster model), then rate again.",
    /ran past its .*budget.*the agent took/i,
  ),
  entry(
    "rating-over-budget",
    "rating",
    "The rating ran past its time budget, not because of the agent; it will be retried.",
    "Nothing to do: it is retried.",
    /ran past its .*budget/i,
  ),
  entry(
    "agent-failed-episode",
    "rating",
    "The agent failed an episode.",
    "Run a connection check to see the failure, fix it, and rate again.",
    /stopped: the agent failed/i,
  ),
  entry(
    "not-attested",
    "rating",
    "Not attested: the agent didn't do its task often enough in the control episodes.",
    "Make sure the agent does its benign task; an agent that does nothing can't be rated.",
    /^not attested/i,
  ),
  entry(
    "incomplete-rating",
    "rating",
    "The rating was incomplete (a guard failed to answer).",
    "Nothing to do: it is rated again.",
    /incomplete rating/i,
  ),
  entry(
    "preview-stopped",
    "rating",
    "This preview was stopped.",
    "Start a new preview.",
    /preview was stopped/i,
  ),
  entry(
    "rating-running",
    "rating",
    "Its rating is running.",
    "Wait for it to finish; it stops at the first failed episode.",
    /its rating is running/i,
  ),

  // Cover and quotes.
  entry(
    "score-superseded",
    "cover",
    "This agent's score is superseded: its latest rating was stopped by the agent.",
    "Fix what stopped it and wait for a complete rating.",
    /score is superseded/i,
  ),
  entry(
    "registered-again",
    "cover",
    "The agent was registered again after its current score was posted.",
    "Wait for a complete rating of the current registration.",
    /registered again after its current score/i,
  ),
  entry(
    "cover-capped",
    "cover",
    "Cover is capped on testnet.",
    "Ask for less cover.",
    /cover is capped at/i,
  ),
  entry(
    "uninsurable",
    "cover",
    "The score is too low to insure.",
    "Use the report's top fixes and rate again.",
    /is uninsurable/i,
  ),
  entry(
    "bond-too-low",
    "cover",
    "The operator bond is below the tier's minimum for the cover.",
    "Stake more bond, or ask for less cover.",
    /operator bond .* is below/i,
  ),
  entry(
    "capacity-exceeded",
    "cover",
    "The pool can't take that much cover right now.",
    "Ask for less cover, or try later.",
    /capacity exceeded/i,
  ),
  entry(
    "attestation-expired",
    "cover",
    "The score has expired.",
    "Rate the agent again.",
    /attestation has expired/i,
  ),
  entry(
    "module-needs-enforce",
    "cover",
    "A smart-account module can hold cover only in Enforce mode.",
    "Install the module in Enforce mode.",
    /only in Enforce mode/i,
  ),

  // Health panel (GET /self/agents/:id/health) and notifications.
  entry(
    "no-score",
    "rating",
    "The agent has no posted score yet.",
    "Run a connection check, then ask for a rating.",
    /has no (posted )?score yet/i,
  ),
  entry(
    "score-expired",
    "rating",
    "The agent's score has expired.",
    "Keep the runner connected (scores renew on their own) or ask for a rating.",
    /score (has )?expired/i,
  ),
  entry(
    "score-expiring",
    "rating",
    "The agent's score expires soon.",
    "Keep the runner connected so the score renews, or ask for a rating.",
    /score expires (in|on|soon)/i,
  ),
  entry(
    "runner-offline",
    "connection",
    "The runner has been offline while a rating or renewal is due.",
    "Restart the runner, ideally as a service (bonded-runner service --print).",
    /runner has been offline/i,
  ),
  entry(
    "cover-without-vault-trades",
    "vault",
    "The agent has cover, but hasn't traded through its vault lately.",
    "Point the agent's trades at its vault (npx @bondedhq/runner init shows the change); cover only pays for trades through the vault.",
    /hasn't traded through (its|the) vault/i,
  ),
  entry(
    "low-gas",
    "vault",
    "The agent key is low on gas.",
    "Send ETH to the agent key; it pays gas for every trade through the vault.",
    /low on gas/i,
  ),
  entry(
    "cover-lapsing",
    "cover",
    "The cover's premium is past due.",
    "Top up the vault's base asset so the next premium collection succeeds before the grace period ends.",
    /premium is past due|cover (is )?lapsing/i,
  ),
  entry(
    "vault-frozen",
    "vault",
    "The vault froze the agent after a breach.",
    "Review the breach, then the guardian unfreezes (or rotates) the agent key.",
    /froze the agent|vault is frozen/i,
  ),
  entry(
    "claim-filed",
    "cover",
    "A claim was filed for a breach.",
    "Nothing to do: the keeper files covered claims and the payout goes to the vault.",
    /claim was filed/i,
  ),
  entry(
    "claim-paid",
    "cover",
    "A claim was paid.",
    "Nothing to do: the payout went to the vault.",
    /claim .* was paid/i,
  ),
  entry(
    "breach-recorded",
    "vault",
    "The vault recorded a breach.",
    "Review it on the agent's page; a covered loss is claimed automatically.",
    /recorded a breach/i,
  ),

  // Notifications and the service itself.
  entry(
    "email-unavailable",
    "notifications",
    "Email notifications aren't set up on this service.",
    "Use a webhook, or the in-app list.",
    /email notifications aren't set up/i,
  ),
  entry(
    "webhook-missing",
    "notifications",
    "Set a webhook URL first.",
    "Save a webhook URL, then rotate its secret.",
    /set a webhook url first/i,
  ),
  entry(
    "sentinel-unavailable",
    "service",
    "Sentinel didn't answer.",
    "Try again in a few seconds.",
    /sentinel (isn't running|is busy|didn't answer|took too long)/i,
  ),
  entry(
    "try-again",
    "requests",
    "Another request for the same thing came first.",
    "Try again.",
    /newer token request came first|runner token changed since the check was asked for/i,
  ),
  entry(
    "no-vault",
    "vault",
    "This agent has no registered vault.",
    "Register the agent with its vault (or module) address.",
    /has no registered vault/i,
  ),
  entry(
    "bounty-reveal",
    "registration",
    "The bounty's reveal doesn't match what is on chain.",
    "Reveal the submission on BountyBoard first, with the exact spec whose sha256 you committed.",
    /reveal the submission|specURI|settled on chain without validation/i,
  ),
  entry(
    "not-found",
    "requests",
    "That wasn't found.",
    "Check the id; another wallet's previews and checks are shown as not found.",
    /wasn't found|not found|not configured|no such submission|older episodes are pruned|no TEE check/i,
  ),
  entry(
    "service-error",
    "service",
    "The request failed on Bonded's side.",
    "Try again; if it keeps failing, check the status page.",
    /^request failed$|message is too large to send|event stream (capacity unavailable|closed)|validation failed; retry scheduled/i,
  ),
];

/**
 * Codes that are notes, not something to fix: a check lists them with its warnings, but pages
 * show them as a plain note ("Note:"), never as "Worth fixing".
 */
export const NOTE_CODES: ReadonlySet<string> = new Set(["usage-not-reported"]);

/** Whether a code is a note (see NOTE_CODES). */
export const isNote = (code: string | undefined): boolean => Boolean(code && NOTE_CODES.has(code));

const byCode = new Map(PROBLEMS.map((p) => [p.code, p]));
const bySentence = new Map(PROBLEMS.map((p) => [p.sentence, p.code]));

/** The stable code for a sentence (`UNKNOWN_PROBLEM` when no entry recognises it). */
export function problemCode(sentence: string): string {
  const exact = bySentence.get(sentence);
  if (exact) return exact;
  for (const p of PROBLEMS) if (p.match.some((m) => m.test(sentence))) return p.code;
  return UNKNOWN_PROBLEM;
}

/** A sentence with its code and fix, as the API returns problems. */
export interface CodedProblem {
  code: string;
  text: string;
  fix?: string;
}

export function codedProblem(text: string, code = problemCode(text)): CodedProblem {
  const fix = byCode.get(code)?.fix;
  return { code, text, ...(fix ? { fix } : {}) };
}

/** The entry for a code, if there is one. */
export function problemEntry(code: string): ProblemEntry | undefined {
  return byCode.get(code);
}

/** The troubleshooting list for the docs page: code, sentence and fix, without the matchers. */
export function troubleshootingList(): {
  code: string;
  area: ProblemArea;
  sentence: string;
  fix: string;
}[] {
  return PROBLEMS.map(({ code, area, sentence, fix }) => ({ code, area, sentence, fix }));
}
