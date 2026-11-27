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
import { ensureTestnet, networkDetails, networkNote, useChainName } from "../lib/network";
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
  const [byHand, setByHand] = useState(false);
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
      const message = e instanceof Error ? e.message : String(e);
      // The details are right below here, so the menu says so instead of pointing to itself.
      const cantAdd = /by hand/.test(message);
      setProblem(
        cantAdd
          ? `${message.split(". ")[0]}. Add it by hand with the details below, or use Rabby or MetaMask.`
          : message,
      );
      setByHand(cantAdd);
    } finally {
      setSwitching(false);
    }
  }
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), setProblem(null), setByHand(false))}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Wallet ${short(address)}, on ${network ?? "an unknown network"}`}
          className={`group inline-flex h-9 items-center gap-2.5 rounded-full pr-2.5 pl-1 text-ink shadow-[inset_0_0_0_1px_rgb(255_255_255/0.16)] transition hover:bg-white/[0.06] hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.3)] ${open ? "bg-white/[0.06]" : ""}`}
        >
          <WalletAvatar address={address} size={28} />
          <span className="font-mono text-[13px] tracking-tight">{short(address)}</span>
          <span
            title={network}
            className={`rounded-full ${onTestnet ? "" : "ring-1 ring-warn ring-offset-1 ring-offset-paper"}`}
          >
            <NetworkLogo chainId={chainId} name={network} size={16} />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={10}
        className="w-[21.5rem] rounded-2xl border-line-strong bg-surface p-0 shadow-(--shadow-raised)"
      >
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
          <div className="flex items-baseline justify-between">
            <p className="eyebrow">Network</p>
            <p className={`text-[12px] ${onTestnet ? "text-brand-bright" : "text-warn"}`}>
              {onTestnet ? "Ready for transactions" : "Not used here"}
            </p>
          </div>
          <p className="mt-3 flex items-center gap-2.5 text-[15px] text-ink">
            <NetworkLogo chainId={chainId} name={network} size={22} />
            {network ?? "Unknown network"}
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
              <button
                type="button"
                aria-expanded={byHand}
                onClick={() => setByHand((v) => !v)}
                className="mt-3 flex w-full items-center justify-between text-[12.5px] text-muted transition hover:text-ink"
              >
                Add the network by hand
                <span
                  aria-hidden
                  className={`inline-block font-mono text-[15px] leading-none transition-transform ${byHand ? "rotate-45" : ""}`}
                >
                  +
                </span>
              </button>
              {byHand && <NetworkDetails />}
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
            className="text-[13px] text-muted transition hover:text-breach"
          >
            Disconnect
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Robinhood Chain testnet's details, each with its own copy button, for adding it by hand. */
function NetworkDetails() {
  const [copied, setCopied] = useState<string>();
  async function copy(label: string, value: string) {
    if (await copyText(value)) {
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? undefined : c)), 1600);
    }
  }
  return (
    <dl className="mt-2 divide-y divide-line border-y border-line">
      {networkDetails().map(({ label, value }) => (
        <div key={label} className="flex items-center gap-3 py-2">
          <dt className="w-24 shrink-0 text-[12px] text-muted">{label}</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-[12px] text-soft" title={value}>
            {value}
          </dd>
          <button
            type="button"
            onClick={() => copy(label, value)}
            aria-label={`Copy ${label}`}
            className="shrink-0 font-mono text-[11px] text-muted transition hover:text-ink"
          >
            {copied === label ? "Copied" : "Copy"}
          </button>
        </div>
      ))}
    </dl>
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
