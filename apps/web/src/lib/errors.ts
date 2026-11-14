import { ApiError } from "./api";

/** The error and every `cause` below it (viem and wagmi wrap errors several levels deep). */
function chain(error: unknown): { name?: string; code?: unknown; message?: string }[] {
  const out: { name?: string; code?: unknown; message?: string }[] = [];
  let e: unknown = error;
  for (let depth = 0; e && typeof e === "object" && depth < 8; depth++) {
    out.push(e as { name?: string; code?: unknown; message?: string });
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

const has = (error: unknown, test: (e: { name?: string; code?: unknown }) => boolean) =>
  chain(error).some(test);

/** True when the chain's RPC couldn't be reached (as opposed to a contract call reverting). */
export function isRpcUnavailable(error: unknown): boolean {
  return has(error, (e) =>
    ["HttpRequestError", "TimeoutError", "WebSocketRequestError"].includes(e.name ?? ""),
  );
}

/** A sentence a user can act on, for any error the app shows. */
export function describeError(error: unknown): string {
  if (has(error, (e) => e.name === "UserRejectedRequestError" || e.code === 4001))
    return "You cancelled the request in your wallet. Nothing was sent.";
  if (has(error, (e) => e.name === "ProviderNotFoundError"))
    return "No browser wallet found. Install a wallet such as MetaMask or Rabby, then reload the page.";
  if (has(error, (e) => e.name === "SwitchChainError" || e.code === 4902))
    return "Your wallet couldn't switch to Robinhood Chain testnet. Add the network in your wallet (chain id 46630), then try again.";
  // A passkey prompt the person closed, or that timed out.
  if (has(error, (e) => e.name === "NotAllowedError"))
    return "The passkey request was cancelled or timed out. Try again, or use email.";
  if (isRpcUnavailable(error))
    return "Can't reach Robinhood Chain testnet right now. Check your connection and try again in a minute.";
  if (error instanceof ApiError) {
    // The API's token gate answers a bare "unauthorized"; any other 401 (an expired session, a
    // passkey that didn't check out) says what went wrong itself.
    if (error.status === 401 && error.message === "unauthorized")
      return "The operator token was rejected. Check it and try again.";
    if (error.status === 429) return error.message;
    if (error.status >= 500)
      return "The Bonded API couldn't complete that. It may be restarting; try again in a minute.";
    return error.message;
  }
  // fetch() rejects with a TypeError when the server can't be reached at all.
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message))
    return "Can't reach the Bonded API. It may be restarting; try again in a minute.";
  if (error instanceof Error)
    return (error as { shortMessage?: string }).shortMessage ?? error.message;
  return String(error);
}
