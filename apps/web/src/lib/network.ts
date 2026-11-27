import { getAccount, switchChain } from "wagmi/actions";
import { networkName, robinhoodTestnet } from "../config";
import { wagmiConfig } from "../wagmi";

/**
 * The wallet's network matters only when it sends a transaction. Signing in with a wallet is a
 * signed message, which works on any network, so the app never flags the network in the header:
 * it asks the wallet to switch right before a transaction, and says so beside the action.
 */

/** Phantom offers only its built-in networks and can't add Robinhood Chain testnet. */
export const isPhantom = (connector?: { id?: string; name?: string } | null) =>
  /phantom/i.test(`${connector?.id ?? ""} ${connector?.name ?? ""}`);

const PHANTOM = `Phantom can't use ${networkName}. Connect Rabby or MetaMask for this.`;

/** A network problem in words a first-time visitor can act on. */
export class NetworkError extends Error {
  override name = "NetworkError";
}

/**
 * The line beside an on-chain action when the wallet is on another network, or null when it is on
 * the right one (or no wallet is connected).
 */
export function networkNote(
  chainId: number | undefined,
  connector?: { id?: string; name?: string } | null,
): string | null {
  if (chainId === undefined || chainId === robinhoodTestnet.id) return null;
  if (isPhantom(connector)) return PHANTOM;
  return `Your wallet is on another network. It will ask to switch to ${networkName} when you confirm.`;
}

const declined = (e: unknown) =>
  (e as { code?: number })?.code === 4001 ||
  (e as { name?: string })?.name === "UserRejectedRequestError" ||
  /reject|denied|cancel/i.test(String((e as Error)?.message ?? ""));

/**
 * Before a transaction: moves the connected wallet to Robinhood Chain testnet if it is elsewhere.
 * Throws a `NetworkError` that says what to do when the wallet can't or won't switch.
 */
export async function ensureTestnet(): Promise<void> {
  const { chainId, connector, isConnected } = getAccount(wagmiConfig);
  if (!isConnected || chainId === robinhoodTestnet.id) return;
  try {
    await switchChain(wagmiConfig, { chainId: robinhoodTestnet.id });
  } catch (e) {
    // Phantom first: it can't add the network, and wagmi reports a failed add as a refusal.
    if (isPhantom(connector)) throw new NetworkError(PHANTOM);
    if (declined(e))
      throw new NetworkError(
        `Your wallet needs to be on ${networkName} for this. The switch was declined, so nothing was sent.`,
      );
    throw new NetworkError(
      `Your wallet couldn't switch to ${networkName}. Add it in your wallet (chain id ${robinhoodTestnet.id}) or use Rabby or MetaMask, then try again.`,
    );
  }
}
