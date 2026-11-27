import { createContext, useContext, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConnectButton as RainbowKitConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import type { Abi, Hex } from "viem";
import { robinhoodTestnet } from "../config";
import { wagmiConfig } from "../wagmi";
import { ErrorText, Input, TxLink } from "./ui";

export function ConnectButton() {
  return (
    <RainbowKitConnectButton
      label="Connect wallet"
      accountStatus={{ smallScreen: "avatar", largeScreen: "full" }}
      chainStatus={{ smallScreen: "none", largeScreen: "icon" }}
      showBalance={false}
    />
  );
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
