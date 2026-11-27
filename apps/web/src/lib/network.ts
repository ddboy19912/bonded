import { useEffect, useState } from "react";
import { getAccount, switchChain } from "wagmi/actions";
import { networkName, robinhoodTestnet } from "../config";
import { wagmiConfig } from "../wagmi";

/**
 * The wallet's network matters only when it sends a transaction. Signing in with a wallet is a
 * signed message, which works on any network, so the app never flags the network in the header:
 * it asks the wallet to switch right before a transaction, and says so beside the action.
 */

/** Phantom's EVM side reports a failed switch as a refusal, so its failures get their own wording. */
export const isPhantom = (connector?: { id?: string; name?: string } | null) =>
  /phantom/i.test(`${connector?.id ?? ""} ${connector?.name ?? ""}`);

/** A network problem in words a first-time visitor can act on. */
export class NetworkError extends Error {
  override name = "NetworkError";
}

/**
 * The line beside an on-chain action when the wallet is on another network, or null when it is on
 * the right one (or no wallet is connected).
 */
export function networkNote(chainId: number | undefined): string | null {
  if (chainId === undefined || chainId === robinhoodTestnet.id) return null;
  return `Your wallet is on another network. It will ask to switch to ${networkName} when you confirm.`;
}

/** The wallet's own error under wagmi's wrapping (wagmi reports a failed "add network" as a refusal). */
const rootOf = (e: unknown) => {
  let x = e as { cause?: unknown } | undefined;
  for (let i = 0; i < 8 && x?.cause && x.cause !== x; i++) x = x.cause as { cause?: unknown };
  return x as { code?: number; message?: string } | undefined;
};

const declined = (e: unknown) => {
  const root = rootOf(e);
  return root?.code === 4001 || /reject|denied|cancel/i.test(String(root?.message ?? ""));
};

const OTHER_WALLET = "Try Rabby or MetaMask.";

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
    // Phantom first: wagmi reports its failed "add network" as a refusal.
    if (isPhantom(connector))
      throw new NetworkError(`Phantom didn't switch to ${networkName}. ${OTHER_WALLET}`);
    if (declined(e))
      throw new NetworkError(
        `Your wallet needs to be on ${networkName} for this. The switch was declined, so nothing was sent.`,
      );
    throw new NetworkError(`Your wallet couldn't switch to ${networkName}. ${OTHER_WALLET}`);
  }
}

/** Chain names by id, from viem's chain list. Loaded once, and only when a wallet is off the testnet. */
let names: Promise<Map<number, string>> | undefined;
const loadNames = () =>
  (names ??= import("viem/chains").then(
    (all) =>
      new Map(
        (Object.values(all) as unknown[])
          .filter(
            (c): c is { id: number; name: string } =>
              typeof c === "object" && c !== null && "id" in c && "name" in c,
          )
          .map((c) => [c.id, c.name] as const),
      ),
  ));

/** The name of the network the wallet is on: "Ethereum", "Base"… or "Chain 1234" if it isn't a known one. */
export function useChainName(chainId: number | undefined): string | undefined {
  const known = chainId === robinhoodTestnet.id ? robinhoodTestnet.name : undefined;
  const [found, setFound] = useState<{ id: number; name: string }>();
  useEffect(() => {
    if (chainId === undefined || known) return;
    let live = true;
    void loadNames().then(
      (m) => live && setFound({ id: chainId, name: m.get(chainId) ?? `Chain ${chainId}` }),
    );
    return () => {
      live = false;
    };
  }, [chainId, known]);
  if (chainId === undefined) return undefined;
  return known ?? (found?.id === chainId ? found.name : `Chain ${chainId}`);
}
