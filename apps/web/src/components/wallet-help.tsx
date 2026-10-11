import { useState } from "react";
import { useAccount, useBalance } from "wagmi";
import { faucets, isLocal, networkName, robinhoodTestnet } from "../config";
import { addChainParams, gasLine } from "../lib/wallet-help";
import { Button, Card, ErrorText, linkClass } from "./ui";

/**
 * Before onboarding: the network in the wallet (one click), test ETH for gas from a faucet, and
 * how much gas the onboarding needs, from its simulated transactions.
 */
export function WalletHelp({ gasNeeded }: { gasNeeded: bigint | undefined }) {
  const { address, chainId, connector, isConnected } = useAccount();
  const balance = useBalance({
    address,
    chainId: robinhoodTestnet.id,
    query: { enabled: Boolean(address), refetchInterval: 30_000 },
  });
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const onChain = chainId === robinhoodTestnet.id;
  const add = async () => {
    if (!connector) return;
    setAdding(true);
    setError(null);
    try {
      const provider = (await connector.getProvider()) as {
        request: (a: { method: string; params: unknown[] }) => Promise<unknown>;
      };
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [addChainParams(robinhoodTestnet)],
      });
      setAdded(true);
    } catch (e) {
      setError(e);
    } finally {
      setAdding(false);
    }
  };
  const gas = gasLine(gasNeeded, balance.data?.value);
  return (
    <Card title="Your wallet">
      <div className="flex flex-col gap-3 text-sm">
        {!isConnected ? (
          <p className="text-muted">Connect a wallet first: it signs every step.</p>
        ) : onChain || added ? (
          <p className="flex items-center gap-2 text-safe">
            <span className="size-2 shrink-0 rounded-full bg-current" aria-hidden />
            Your wallet is on {networkName}.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-muted">
              Your wallet isn't on {networkName} yet. Add it in one click: chain id{" "}
              {robinhoodTestnet.id}, gas paid in test ETH.
            </p>
            <div>
              <Button size="sm" kind="secondary" loading={adding} onClick={() => void add()}>
                Add {networkName} to my wallet
              </Button>
            </div>
          </div>
        )}
        <p
          className={gas.short ? "text-warn" : "text-muted"}
          role={gas.short ? "alert" : undefined}
        >
          {gas.text}
        </p>
        {!isLocal && faucets.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-line pt-3 text-xs text-muted">
            <p>
              Free test ETH:{" "}
              {faucets.map((url, i) => (
                <span key={url}>
                  {i > 0 && " · "}
                  <a className={linkClass} href={url} target="_blank" rel="noreferrer">
                    {new URL(url).hostname}
                  </a>
                </span>
              ))}
            </p>
            <p>
              Test <span className="font-mono">tUSDG</span> for the bond and deposit is minted for
              you during onboarding.
            </p>
          </div>
        )}
        <ErrorText error={error} />
      </div>
    </Card>
  );
}
