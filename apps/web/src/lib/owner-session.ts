import { useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { deployment } from "../config";
import { byoaApi, type PreviewSession } from "./byoa-api";
import {
  SESSION_EVENT,
  clearAccountSession,
  clearSession,
  loadAccountSession,
  loadSession,
  saveSession,
} from "./connect";

/**
 * The owner's session (12 hours), shared by the preview pages, the owner's agent pages, the gate
 * and the inbox, so checks, Agent URLs and settings need no signature each time. An email
 * account's session (email code or passkey, docs/ACCOUNTS.md) counts first: it needs no wallet.
 * Otherwise it is the connected wallet's, opened by one signature.
 */
export function useOwnerSession(path: "/previews/session" | "/self/session" = "/self/session") {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const current = () =>
    loadAccountSession(deployment.chainId) ?? loadSession(deployment.chainId, address);
  const [session, setSession] = useState<PreviewSession | undefined>(current);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const reload = () => setSession(current());
    reload();
    // Signing in elsewhere on the page (another panel) counts here too.
    window.addEventListener(SESSION_EVENT, reload);
    return () => window.removeEventListener(SESSION_EVENT, reload);
    // `current` reads the address; it is the only input.
  }, [address]);
  /** Signs in with the connected wallet (email accounts sign in with `SignInPanel`). */
  const signIn = async () => {
    if (!address) return;
    setSigningIn(true);
    setError(null);
    try {
      const s = await byoaApi.signIn(signMessageAsync, address, path);
      saveSession(deployment.chainId, s);
      setSession(s);
    } catch (e) {
      setError(e);
    } finally {
      setSigningIn(false);
    }
  };
  const forget = () => {
    if (session?.account) clearAccountSession(deployment.chainId);
    else if (address) clearSession(deployment.chainId, address);
    setSession(undefined);
  };
  return {
    session,
    /** The email account's address, when the session is an account's. */
    email: session?.account?.email,
    signIn,
    signingIn,
    error,
    forget,
    sign: signMessageAsync,
  };
}
