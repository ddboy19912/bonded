import { useState } from "react";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { useAccount } from "wagmi";
import { deployment } from "../config";
import { byoaApi, type PreviewSession } from "../lib/byoa-api";
import { saveAccountSession } from "../lib/connect";
import { Button, ErrorText, Input, linkClass } from "./ui";
import { ConnectButton } from "./wallet";

/** Whether this browser can use passkeys (false in tests and old browsers). */
const passkeysWork = () => {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
};

/**
 * Signing in, for everyone: an email code or a passkey (no wallet needed, docs/ACCOUNTS.md), or
 * a wallet as before. An email or passkey sign-in is kept as the account's session, which every
 * owner page reads first.
 */
export function SignInPanel({
  onSignedIn,
  wallet,
  expired = false,
}: {
  /** Told when an email or passkey sign-in opened a session. */
  onSignedIn?: (session: PreviewSession) => void;
  /** Signing in with the connected wallet: the page's own wallet sign-in. */
  wallet?: { signIn: () => void; signingIn: boolean; error: unknown };
  expired?: boolean;
}) {
  const { isConnected } = useAccount();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"code" | "session" | "passkey">();
  const [error, setError] = useState<unknown>(null);

  const done = (s: PreviewSession) => {
    saveAccountSession(deployment.chainId, s);
    onSignedIn?.(s);
  };
  const run = async (what: "code" | "session" | "passkey", step: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await step();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  };
  const sendCode = () =>
    run("code", async () => {
      await byoaApi.emailCode(email.trim());
      setSentTo(email.trim());
      setCode("");
    });
  const signInWithCode = () =>
    run("session", async () => done(await byoaApi.emailSession(sentTo!, code.trim())));
  const signInWithPasskey = () =>
    run("passkey", async () => {
      const optionsJSON = await byoaApi.passkeySignInOptions();
      const response = await startAuthentication({ optionsJSON });
      done(await byoaApi.passkeySession(response));
    });

  return (
    <div className="flex max-w-md flex-col gap-5 text-sm">
      {expired && (
        <p className="text-warn" role="status">
          Your sign-in expired. Sign in again to carry on where you were.
        </p>
      )}
      {!sentTo ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void sendCode();
          }}
        >
          <Input
            label="Your work email"
            type="email"
            inputMode="email"
            autoComplete="email"
            mono={false}
            value={email}
            onChange={setEmail}
            placeholder="you@company.com"
            hint="We'll email you a 6-digit code. No password."
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={busy === "code"} disabled={!email.includes("@")}>
              Email me a code
            </Button>
            {passkeysWork() && (
              <Button
                kind="secondary"
                loading={busy === "passkey"}
                onClick={() => void signInWithPasskey()}
              >
                Sign in with a passkey
              </Button>
            )}
          </div>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void signInWithCode();
          }}
        >
          <Input
            label={`The code we sent to ${sentTo}`}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            hint="It works for 10 minutes. Check spam if it hasn't arrived."
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={busy === "session"} disabled={code.length !== 6}>
              Sign in
            </Button>
            <button type="button" className={linkClass} onClick={() => void sendCode()}>
              Send a new code
            </button>
            <button type="button" className={linkClass} onClick={() => setSentTo(undefined)}>
              Use another email
            </button>
          </div>
        </form>
      )}
      <ErrorText error={error} />

      {wallet && (
        <div className="flex flex-col items-start gap-2 border-t border-line pt-4">
          <p className="text-muted">Or use a crypto wallet. You won't send anything or pay gas.</p>
          {!isConnected ? (
            <ConnectButton />
          ) : (
            <>
              <Button kind="secondary" loading={wallet.signingIn} onClick={wallet.signIn}>
                {wallet.signingIn ? "Sign in your wallet…" : "Sign in with your wallet"}
              </Button>
              <ErrorText error={wallet.error} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * After an email sign-in: one tap to add a passkey, so next time needs no code. Hidden where the
 * browser can't make one, and once dismissed.
 */
export function PasskeyOffer({ session }: { session: PreviewSession }) {
  const [state, setState] = useState<"offer" | "busy" | "added" | "hidden">(() =>
    passkeysWork() && session.account ? "offer" : "hidden",
  );
  const [error, setError] = useState<unknown>(null);
  if (state === "hidden") return null;
  if (state === "added")
    return <p className="text-sm text-safe">Passkey added. Next time, sign in with one tap.</p>;
  const add = async () => {
    setState("busy");
    setError(null);
    try {
      const optionsJSON = await byoaApi.passkeyAddOptions(session.session);
      const response = await startRegistration({ optionsJSON });
      await byoaApi.passkeyAdd(session.session, response);
      setState("added");
    } catch (e) {
      setError(e);
      setState("offer");
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted">Sign in with one tap next time:</span>
      <Button kind="secondary" size="sm" loading={state === "busy"} onClick={() => void add()}>
        Add a passkey
      </Button>
      <button type="button" className={linkClass} onClick={() => setState("hidden")}>
        Not now
      </button>
      <ErrorText error={error} />
    </div>
  );
}
