import { createContext, useContext, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConnectButton as RainbowKitConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import type { Abi, Hex } from "viem";
import { robinhoodTestnet } from "../config";
import { wagmiConfig } from "../wagmi";
import { ensureTestnet, networkNote } from "../lib/network";
import { ErrorText, Input, TxLink, buttonClass } from "./ui";

/**
 * The wallet in the header: "Connect wallet", or the connected address, which opens the account
 * menu. It never shows the wallet's network: only transactions need Robinhood Chain testnet, and
 * they ask for it themselves (lib/network.ts), so a wallet used to sign in isn't flagged as wrong.
 */
export function ConnectButton() {
  return (
    <RainbowKitConnectButton.Custom>
      {({ account, mounted, openAccountModal, openConnectModal }) => {
        if (!mounted) return <span aria-hidden className="inline-block h-9 w-32" />;
        if (!account)
          return (
            <button
              type="button"
              onClick={openConnectModal}
              className={buttonClass("secondary", "sm")}
            >
              Connect wallet
            </button>
          );
        return (
          <button
            type="button"
            onClick={openAccountModal}
            className={buttonClass("secondary", "sm")}
          >
            {account.ensAvatar && (
              <img src={account.ensAvatar} alt="" className="size-5 rounded-full" />
            )}
            <span className="font-mono text-[13px]">{account.displayName}</span>
          </button>
        );
      }}
    </RainbowKitConnectButton.Custom>
  );
}

/** Beside an on-chain action: a line when the wallet is on another network, else nothing. */
export function NetworkNote() {
  const { chainId, connector } = useAccount();
  const note = networkNote(chainId, connector);
  return note ? (
    <p role="status" className="border-l-2 border-warn/60 pl-3 text-[13px] text-soft">
      {note}
    </p>
  ) : null;
}

/** Opens the wallet picker (RainbowKit's connect modal), for the sign-in modal's wallet option. */
export function useOpenConnect(): () => void {
  const { openConnectModal } = useConnectModal();
  return () => openConnectModal?.();
}

export interface Call {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  label: string;
}

/**
 * Send contract calls one after another from the connected wallet, waiting for each receipt,
 * then refresh every on-chain read on the page.
 */
export function useSend() {
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [hashes, setHashes] = useState<Hex[]>([]);
  const [busy, setBusy] = useState(false);
  async function send(calls: Call[]) {
    setBusy(true);
    setError(null);
    setHashes([]);
    try {
      setStatus("Checking your wallet's network");
      await ensureTestnet();
      for (const call of calls) {
        setStatus(`${call.label}: confirm in your wallet`);
        const hash = await writeContractAsync({
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
          chainId: robinhoodTestnet.id,
        } as Parameters<typeof writeContractAsync>[0]);
        setHashes((h) => [...h, hash]);
        setStatus(`${call.label}: waiting for confirmation`);
        const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
        if (receipt.status !== "success") throw new Error(`${call.label} reverted`);
      }
      setStatus("Done");
      await queryClient.invalidateQueries();
      return true;
    } catch (e) {
      setError(e);
      setStatus(null);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const view = (
    <div className="flex flex-col gap-1 text-sm">
      {!busy && <NetworkNote />}
      {status && <span className="text-muted">{status}</span>}
      {hashes.length > 0 && (
        <span className="flex flex-wrap gap-2">
          {hashes.map((h) => (
            <TxLink key={h} hash={h} />
          ))}
        </span>
      )}
      <ErrorText error={error} />
    </div>
  );
  return { send, busy, view };
}

const TokenContext = createContext<{ token: string; setToken: (t: string) => void }>({
  token: "",
  setToken: () => {},
});

/** Holds the operator token in memory for this tab only; reloading the page forgets it. */
export function OperatorTokenProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState("");
  return <TokenContext.Provider value={{ token, setToken }}>{children}</TokenContext.Provider>;
}

export function useOperatorToken() {
  return useContext(TokenContext);
}

export function OperatorTokenField() {
  const { token, setToken } = useOperatorToken();
  return (
    <div className="flex flex-col gap-2">
      <Input
        label="Operator token (API_TOKEN)"
        type="password"
        value={token}
        onChange={setToken}
        placeholder="kept in memory only"
      />
      <span className="text-[13px] leading-relaxed text-muted">
        Starting ratings and signing quotes are operator actions. The token stays in this tab and is
        never saved.
      </span>
    </div>
  );
}
