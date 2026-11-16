import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { ArrowLeft, KeyRound, Mail, Wallet } from "lucide-react";
import { useAccount } from "wagmi";
import { deployment } from "../config";
import { byoaApi, type PreviewSession } from "../lib/byoa-api";
import { saveAccountSession } from "../lib/connect";
import { useOwnerSession } from "../lib/owner-session";
import { ModalActions, ResponsiveModal } from "./responsive-modal";
import {
  Button,
  ErrorText,
  Input,
  Spinner,
  linkClass,
  type ButtonKind,
  type ButtonSize,
} from "./ui";
import { ConnectButton, useOpenConnect } from "./wallet";

/**
 * Whether a passkey can be used here. Passkeys belong to bondedhq.xyz (the API's WEBAUTHN_RP_ID),
 * so browsers only offer them there and on its subdomains: not on a preview address.
 */
export function passkeysWork(): boolean {
  const rpId = (import.meta.env.VITE_PASSKEY_RP_ID as string | undefined) || "bondedhq.xyz";
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  if (host !== rpId && !host.endsWith(`.${rpId}`)) return false;
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** A page's own wallet sign-in: one signature, which opens the wallet's session. */
export interface WalletSignIn {
  signIn: () => void;
  signingIn: boolean;
  error: unknown;
}

/**
 * The one way to sign in, everywhere: a button that opens the sign-in modal, with an email code,
 * a passkey or a crypto wallet (docs/ACCOUNTS.md). With `wallet`, choosing a wallet connects it
 * and then asks for its one signature; without, it only connects it.
 */
export function SignInButton({
  wallet,
  onSignedIn,
  label = "Sign in",
  kind,
  size,
}: {
  wallet?: WalletSignIn;
  onSignedIn?: (session: PreviewSession) => void;
  label?: string;
  kind?: ButtonKind;
  size?: ButtonSize;
}) {
  const [open, setOpen] = useState(false);
  const { isConnected } = useAccount();
  const openConnect = useOpenConnect();
  // Chose a wallet that wasn't connected yet: sign as soon as it connects.
  const [awaitingWallet, setAwaitingWallet] = useState(false);
  useEffect(() => {
    if (awaitingWallet && isConnected) {
      setAwaitingWallet(false);
      wallet?.signIn();
    }
  }, [awaitingWallet, isConnected, wallet]);
  const chooseWallet = () => {
    setOpen(false);
    if (isConnected) wallet?.signIn();
    else {
      setAwaitingWallet(Boolean(wallet));
      // After the modal has closed, so the wallet's own window gets the focus.
      setTimeout(openConnect, 0);
    }
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <Button kind={kind} size={size} loading={wallet?.signingIn} onClick={() => setOpen(true)}>
        {wallet?.signingIn ? "Sign in your wallet…" : label}
      </Button>
      {wallet && <ErrorText error={wallet.error} />}
      <SignInDialog
        open={open}
        onOpenChange={setOpen}
        onSignedIn={onSignedIn}
        onWallet={chooseWallet}
        walletConnected={isConnected}
      />
    </div>
  );
}

type View = "choose" | "email" | "code" | "offer";

/** The sign-in modal: pick a way in, then the email code steps, then a passkey offer. */
export function SignInDialog({
  open,
  onOpenChange,
  onSignedIn,
  onWallet,
  walletConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignedIn?: (session: PreviewSession) => void;
  onWallet: () => void;
  walletConnected: boolean;
}) {
  const [view, setView] = useState<View>("choose");
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"code" | "session" | "passkey" | "add">();
  const [error, setError] = useState<unknown>(null);
  // Signed in by email, waiting on the passkey offer: kept until the offer is answered, so the
  // page doesn't move on (and close this) underneath it.
  const [pending, setPending] = useState<PreviewSession>();

  // Each opening (and closing) is a new attempt: an answer that arrives for an earlier one, after
  // the modal closed or someone else signed in, is dropped rather than saved.
  const attempt = useRef(0);
  useEffect(() => {
    attempt.current += 1;
    if (!open) return;
    setView("choose");
    setError(null);
    setCode("");
    setPending(undefined);
    setBusy(undefined);
  }, [open]);
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  const complete = (s: PreviewSession) => {
    saveAccountSession(deployment.chainId, s);
    onSignedIn?.(s);
    setPending(undefined);
    onOpenChange(false);
  };
  const close = (next: boolean) => {
    if (!next && pending) complete(pending);
    else onOpenChange(next);
  };
  /** Runs one step; `live()` says whether it still belongs to the open attempt. */
  const run = async (
    what: NonNullable<typeof busy>,
    step: (live: () => boolean) => Promise<void>,
  ) => {
    const mine = attempt.current;
    const live = () => attempt.current === mine;
    setBusy(what);
    setError(null);
    try {
      await step(live);
    } catch (e) {
      if (live()) setError(e);
    } finally {
      if (live()) setBusy(undefined);
    }
  };
  const sendCode = () =>
    run("code", async (live) => {
      const to = email.trim();
      await byoaApi.emailCode(to);
      if (!live()) return;
      setSentTo(to);
      setCode("");
      setView("code");
    });
  const signInWithCode = () =>
    run("session", async (live) => {
      const s = await byoaApi.emailSession(sentTo, code);
      if (!live()) return;
      if (passkeysWork()) {
        setPending(s);
        setView("offer");
      } else complete(s);
    });
  const signInWithPasskey = () =>
    run("passkey", async (live) => {
      const optionsJSON = await byoaApi.passkeySignInOptions();
      const response = await startAuthentication({ optionsJSON });
      const s = await byoaApi.passkeySession(response);
      if (live()) complete(s);
    });
  const addPasskey = () =>
    run("add", async (live) => {
      const s = pending!;
      const optionsJSON = await byoaApi.passkeyAddOptions(s.session);
      const response = await startRegistration({ optionsJSON });
      await byoaApi.passkeyAdd(s.session, response);
      if (live()) complete(s);
    });

  const back = (to: View) => (
    <button
      type="button"
      className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
      onClick={() => {
        setError(null);
        setView(to);
      }}
    >
      <ArrowLeft className="size-4" aria-hidden />
      Back
    </button>
  );

  const heads: Record<View, { title: string; description?: string }> = {
    choose: { title: "Sign in to Bonded", description: "Free. No password needed." },
    email: { title: "Sign in with email", description: "We'll email you a 6-digit code." },
    code: { title: "Check your email", description: `Enter the code we sent to ${sentTo}.` },
    offer: { title: "Add a passkey?" },
  };

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={close}
      title={heads[view].title}
      description={heads[view].description}
    >
      {view === "choose" && (
        <div className="flex flex-col gap-3">
          <Option
            icon={<Mail className="size-5" aria-hidden />}
            title="Continue with email"
            hint="Your email and a one-time code."
            onClick={() => {
              setError(null);
              setView("email");
            }}
          />
          {passkeysWork() && (
            <Option
              icon={<KeyRound className="size-5" aria-hidden />}
              title="Sign in with a passkey"
              hint="If you added one before."
              busy={busy === "passkey"}
              onClick={() => void signInWithPasskey()}
            />
          )}
          <Option
            icon={<Wallet className="size-5" aria-hidden />}
            title={walletConnected ? "Sign in with your wallet" : "Use a crypto wallet"}
            hint="One signature. You won't send anything or pay gas."
            onClick={onWallet}
          />
          <ErrorText error={error} />
        </div>
      )}

      {view === "email" && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void sendCode();
          }}
        >
          <Input
            label="Your email"
            type="email"
            inputMode="email"
            autoComplete="email"
            mono={false}
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
          />
          <ErrorText error={error} />
          <Button type="submit" loading={busy === "code"} disabled={!email.includes("@")}>
            Email me a code
          </Button>
          {back("choose")}
        </form>
      )}

      {view === "code" && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void signInWithCode();
          }}
        >
          <Input
            label="Sign-in code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            hint="It works for 10 minutes. Check spam if it hasn't arrived."
          />
          <ErrorText error={error} />
          <Button type="submit" loading={busy === "session"} disabled={code.length !== 6}>
            Sign in
          </Button>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <button type="button" className={linkClass} onClick={() => void sendCode()}>
              Send a new code
            </button>
            <button
              type="button"
              className={linkClass}
              onClick={() => {
                setError(null);
                setView("email");
              }}
            >
              Use another email
            </button>
          </div>
        </form>
      )}

      {view === "offer" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">You're signed in as {pending?.account?.email}.</p>
          <ErrorText error={error} />
          <ModalActions>
            <Button kind="secondary" onClick={() => pending && complete(pending)}>
              Not now
            </Button>
            <Button loading={busy === "add"} onClick={() => void addPasskey()}>
              Add a passkey
            </Button>
          </ModalActions>
        </div>
      )}
    </ResponsiveModal>
  );
}

function Option({
  icon,
  title,
  hint,
  busy = false,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-xl border border-line-strong px-4 py-3.5 text-left transition-colors hover:border-accent/60 hover:bg-white/[0.03] disabled:opacity-60"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
        {busy ? <Spinner /> : icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="font-medium text-ink">{title}</span>
        <span className="text-sm text-muted">{hint}</span>
      </span>
    </button>
  );
}

/**
 * The header's sign-in: the email account when signed in with one (with its Sign out, and a way to
 * connect a wallet too), the wallet's own button once one is connected, and otherwise "Sign in",
 * which opens the same modal as every page.
 */
export function HeaderSignIn() {
  const { isConnected } = useAccount();
  const owner = useOwnerSession();
  const openConnect = useOpenConnect();
  const [open, setOpen] = useState(false);
  if (!owner.email) return isConnected ? <ConnectButton /> : <SignInButton />;
  return (
    <>
      <Button kind="secondary" onClick={() => setOpen(true)}>
        <span className="max-w-[16ch] truncate">{owner.email}</span>
      </Button>
      {isConnected && <ConnectButton />}
      <ResponsiveModal
        open={open}
        onOpenChange={setOpen}
        title="Signed in"
        description={`As ${owner.email}.`}
      >
        <p className="text-sm text-muted">
          Your email works for testing agents, the payment gate and notifications.{" "}
          {isConnected
            ? "Your connected wallet is used for vaults, cover and bonds."
            : "Vaults, cover and bonds need a crypto wallet as well."}
        </p>
        <ModalActions>
          <Button
            kind="secondary"
            onClick={() => {
              owner.forget();
              setOpen(false);
            }}
          >
            Sign out
          </Button>
          {!isConnected && (
            <Button
              onClick={() => {
                setOpen(false);
                // After the modal has closed, so the wallet's own window gets the focus.
                setTimeout(openConnect, 0);
              }}
            >
              Connect a wallet
            </Button>
          )}
        </ModalActions>
      </ResponsiveModal>
    </>
  );
}
