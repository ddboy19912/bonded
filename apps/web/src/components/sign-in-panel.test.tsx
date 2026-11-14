import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deployment } from "../config";
import { byoaApi, type PreviewSession } from "../lib/byoa-api";
import { loadAccountSession } from "../lib/connect";
import { PasskeyOffer, SignInPanel } from "./sign-in-panel";

const webauthn = vi.hoisted(() => ({
  supported: true,
  startAuthentication: vi.fn(async () => ({ id: "cred-1" })),
  startRegistration: vi.fn(async () => ({ id: "cred-2" })),
}));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => webauthn.supported,
  startAuthentication: webauthn.startAuthentication,
  startRegistration: webauthn.startRegistration,
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: undefined, isConnected: false }) }));
vi.mock("./wallet", () => ({
  ConnectButton: () => <button type="button">Connect wallet</button>,
}));

const SESSION: PreviewSession = {
  session: "acct-sess",
  wallet: "0x00000000000000000000000000000000000000c7",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  account: { email: "dana@fund.example" },
};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  webauthn.supported = true;
});

describe("SignInPanel", () => {
  it("signs in with a passkey, keeping the account's session", async () => {
    vi.spyOn(byoaApi, "passkeySignInOptions").mockResolvedValue({ challenge: "c" } as never);
    const made = vi.spyOn(byoaApi, "passkeySession").mockResolvedValue(SESSION);
    const signedIn = vi.fn();
    render(<SignInPanel onSignedIn={signedIn} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(signedIn).toHaveBeenCalledWith(SESSION));
    expect(made).toHaveBeenCalledWith({ id: "cred-1" });
    expect(loadAccountSession(deployment.chainId)).toEqual(SESSION);
  });

  it("shows why a code was refused, and lets the code be sent again", async () => {
    const code = vi.spyOn(byoaApi, "emailCode").mockResolvedValue({ sent: true });
    vi.spyOn(byoaApi, "emailSession").mockRejectedValue(
      new Error("That code isn't right. Check the latest email and try again."),
    );
    render(<SignInPanel />);
    fireEvent.change(screen.getByLabelText("Your work email"), {
      target: { value: "dana@fund.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    fireEvent.change(await screen.findByLabelText(/The code we sent/), {
      target: { value: "111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/code isn't right/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    await waitFor(() => expect(code).toHaveBeenCalledTimes(2));
    expect(loadAccountSession(deployment.chainId)).toBeUndefined();
  });

  it("offers no passkey where the browser can't make one, and shows a wallet only when asked", () => {
    webauthn.supported = false;
    render(<SignInPanel />);
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect wallet" })).toBeNull();
    cleanup();
    render(<SignInPanel wallet={{ signIn: () => {}, signingIn: false, error: null }} />);
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
  });
});

describe("PasskeyOffer", () => {
  it("adds a passkey to the signed-in account", async () => {
    vi.spyOn(byoaApi, "passkeyAddOptions").mockResolvedValue({ challenge: "c" } as never);
    const added = vi
      .spyOn(byoaApi, "passkeyAdd")
      .mockResolvedValue({ id: "cred-2", name: "Passkey" });
    render(<PasskeyOffer session={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    expect(await screen.findByText(/Passkey added/)).toBeTruthy();
    expect(added).toHaveBeenCalledWith("acct-sess", { id: "cred-2" });
  });

  it("isn't offered to a wallet's session", () => {
    render(<PasskeyOffer session={{ ...SESSION, account: undefined }} />);
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
  });
});
