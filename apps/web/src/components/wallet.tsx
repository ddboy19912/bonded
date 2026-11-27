import { createContext, useContext, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useDisconnect, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import type { Abi, Hex } from "viem";
import { explorerUrl, robinhoodTestnet } from "../config";
import { addressUrl, short } from "../lib/format";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/shadcn/popover";
import { copyText } from "./copy-button";
import { wagmiConfig } from "../wagmi";
import { TriangleAlert } from "lucide-react";
import { ensureTestnet, networkNote, useChainName } from "../lib/network";
import { NetworkLogo, WalletAvatar, useWalletIcon } from "./wallet-identity";
import { ErrorText, Input, TxLink, buttonClass } from "./ui";

/**
 * The wallet in the header: "Connect wallet", or the connected wallet as a pill (its avatar, the
 * short address and the network's logo) that opens our own account menu. RainbowKit's account modal refuses to open
 * while the wallet is on a network the app doesn't use, so the menu is ours: it works on any
 * network, and offers the switch from there. Transactions ask for the network themselves
 * (lib/network.ts), so a wallet used only to sign in is never flagged.
 */
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const openConnect = useOpenConnect();
  if (!isConnected || !address)
    return (
      <button type="button" onClick={openConnect} className={buttonClass("secondary", "sm")}>
        Connect wallet
      </button>
    );
  return <WalletMenu address={address} />;
}

function WalletMenu({ address }: { address: `0x${string}` }) {
  const { chainId, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const onTestnet = chainId === robinhoodTestnet.id;
  const network = useChainName(chainId);
  const walletIcon = useWalletIcon(connector);
  async function copy() {
    if (await copyText(address)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }
  async function moveToTestnet() {
    setSwitching(true);
    setProblem(null);
    try {
      await ensureTestnet();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitching(false);
    }
  }
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), setProblem(null))}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Wallet ${short(address)}, on ${network ?? "an unknown network"}`}
          className={`group inline-flex h-9 items-center gap-2.5 rounded-full pr-2.5 pl-1 text-ink shadow-[inset_0_0_0_1px_rgb(255_255_255/0.16)] transition hover:bg-white/[0.06] hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.3)] ${open ? "bg-white/[0.06]" : ""}`}
        >
          <WalletAvatar address={address} size={28} />
          <span className="font-mono text-[13px] tracking-tight">{short(address)}</span>
          <span title={network} className="relative inline-flex">
            <NetworkLogo chainId={chainId} name={network} size={16} />
            {!onTestnet && (
              <TriangleAlert
                aria-hidden
                className="absolute -top-1.5 -right-1.5 size-2.5 fill-paper text-warn"
                strokeWidth={3}
              />
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={10} className="w-[21.5rem] p-0">
        <div className="flex items-center gap-3.5 p-5 pb-4">
          <WalletAvatar
            address={address}
            size={44}
            walletIcon={walletIcon}
            walletName={connector?.name}
          />
          <div className="min-w-0 flex-1">
            <p className="eyebrow">{connector?.name ?? "Wallet"}</p>
            <p className="mt-1 font-mono text-[15px] text-ink">{short(address, 6)}</p>
          </div>
          <button
            type="button"
            onClick={copy}
            className="rounded-full px-3 py-1 font-mono text-[11.5px] text-soft shadow-[inset_0_0_0_1px_rgb(255_255_255/0.16)] transition hover:bg-ink hover:text-paper hover:shadow-none"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="border-t border-line px-5 py-4">
          <p className="eyebrow">Network</p>
          <p className="mt-3 flex items-center gap-2.5 text-[15px] text-ink">
            <NetworkLogo chainId={chainId} name={network} size={22} />
            {network ?? "Unknown network"}
            {!onTestnet && (
              <TriangleAlert
                role="img"
                aria-label={`Not ${robinhoodTestnet.name}`}
                className="size-4 shrink-0 text-warn"
                strokeWidth={2.25}
              />
            )}
          </p>
          {!onTestnet && (
            <>
              <p className="mt-3 text-[13px] leading-relaxed text-muted">
                Signing in works on any network. Vaults, cover and bonds need{" "}
                {robinhoodTestnet.name}.
              </p>
              <button
                type="button"
                onClick={moveToTestnet}
                disabled={switching}
                className={`${buttonClass("primary", "sm")} mt-3.5 w-full gap-2`}
              >
                <NetworkLogo chainId={robinhoodTestnet.id} size={16} />
                {switching ? "Check your wallet…" : `Switch to ${robinhoodTestnet.name}`}
              </button>
              {problem && (
                <p role="alert" className="mt-3 text-[13px] leading-relaxed text-breach">
                  {problem}
                </p>
              )}
            </>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          {explorerUrl ? (
            <a
              href={addressUrl(address)}
              target="_blank"
              rel="noreferrer"
              className="text-[13px] text-muted transition hover:text-ink"
            >
              View on explorer <span aria-hidden>↗</span>
            </a>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => (setOpen(false), disconnect())}
            className="text-[13px] text-breach transition hover:text-breach/75"
          >
            Disconnect
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Beside an on-chain action: a line when the wallet is on another network, else nothing. */
export function NetworkNote() {
  const { chainId } = useAccount();
  const note = networkNote(chainId);
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
