import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deployment } from "../config";
import { byoaApi, type PreviewSession } from "../lib/byoa-api";
import { loadAccountSession, saveAccountSession } from "../lib/connect";
import { HeaderSignIn, SignInButton } from "./sign-in";

const webauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(async () => ({ id: "cred-1" })),
  startRegistration: vi.fn(async () => ({ id: "cred-2" })),
}));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: webauthn.startAuthentication,
  startRegistration: webauthn.startRegistration,
}));
const wallet = vi.hoisted(() => ({ connected: false, openConnect: vi.fn() }));
vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: wallet.connected ? "0x00000000000000000000000000000000000000a1" : undefined,
    isConnected: wallet.connected,
  }),
  useSignMessage: () => ({ signMessageAsync: async () => "0x5151" }),
}));
vi.mock("./wallet", () => ({
  ConnectButton: () => <button type="button">Wallet 0xa1</button>,
  useOpenConnect: () => wallet.openConnect,
}));

const SESSION: PreviewSession = {
  session: "acct-sess",
  wallet: "0x00000000000000000000000000000000000000c7",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  account: { email: "dana@fund.example" },
};

beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  wallet.connected = false;
  wallet.openConnect.mockReset();
});

/** Passkeys work only on their own domain: in these tests, jsdom's localhost. */
const passkeyDomain = () => vi.stubEnv("VITE_PASSKEY_RP_ID", "localhost");

async function emailIn() {
  vi.spyOn(byoaApi, "emailCode").mockResolvedValue({ sent: true });
  const made = vi.spyOn(byoaApi, "emailSession").mockResolvedValue(SESSION);
  fireEvent.click(screen.getByRole("button", { name: /Continue with email/ }));
  fireEvent.change(screen.getByLabelText("Your work email"), {
    target: { value: "dana@fund.example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
  expect(await screen.findByText("Check your email")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Sign-in code"), { target: { value: "12 34 56" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(made).toHaveBeenCalledWith("dana@fund.example", "123456"));
}

describe("SignInButton", () => {
  it("is one button; its modal offers email and a wallet, and no passkey off its domain", () => {
    render(<SignInButton />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("dialog", { name: "Sign in to Bonded" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue with email/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use a crypto wallet/ })).toBeTruthy();
    // On a preview address (not bondedhq.xyz) a passkey can't work, so it isn't offered.
    expect(screen.queryByRole("button", { name: /passkey/ })).toBeNull();
  });

  it("signs in with an email code, keeping the account's session, and closes", async () => {
    const signedIn = vi.fn();
    render(<SignInButton onSignedIn={signedIn} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await emailIn();
    await waitFor(() => expect(signedIn).toHaveBeenCalledWith(SESSION));
    expect(loadAccountSession(deployment.chainId)).toEqual(SESSION);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers a passkey after an email sign-in, and adds it", async () => {
    passkeyDomain();
    vi.spyOn(byoaApi, "passkeyAddOptions").mockResolvedValue({ challenge: "c" } as never);
    const added = vi.spyOn(byoaApi, "passkeyAdd").mockResolvedValue({ id: "cred-2", name: "Mac" });
    render(<SignInButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await emailIn();
    expect(await screen.findByText("Add a passkey?")).toBeTruthy();
    // Kept back until the offer is answered, so the page doesn't move on underneath it.
    expect(loadAccountSession(deployment.chainId)).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await waitFor(() => expect(added).toHaveBeenCalledWith("acct-sess", { id: "cred-2" }));
    expect(loadAccountSession(deployment.chainId)).toEqual(SESSION);
  });

  it("signs in anyway when the passkey offer is turned down", async () => {
    passkeyDomain();
    render(<SignInButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await emailIn();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(loadAccountSession(deployment.chainId)).toEqual(SESSION);
  });

  it("signs in with a passkey on its own domain", async () => {
    passkeyDomain();
    vi.spyOn(byoaApi, "passkeySignInOptions").mockResolvedValue({ challenge: "c" } as never);
    const made = vi.spyOn(byoaApi, "passkeySession").mockResolvedValue(SESSION);
    render(<SignInButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: /Sign in with a passkey/ }));
    await waitFor(() => expect(made).toHaveBeenCalledWith({ id: "cred-1" }));
    expect(loadAccountSession(deployment.chainId)).toEqual(SESSION);
  });

  it("opens the wallet picker, then asks for the signature once the wallet connects", async () => {
    const signIn = vi.fn();
    const { rerender } = render(
      <SignInButton wallet={{ signIn, signingIn: false, error: null }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: /Use a crypto wallet/ }));
    await waitFor(() => expect(wallet.openConnect).toHaveBeenCalled());
    expect(signIn).not.toHaveBeenCalled();
    wallet.connected = true;
    rerender(<SignInButton wallet={{ signIn, signingIn: false, error: null }} />);
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  });

  it("says plainly when the API has no email sign-in yet", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    render(<SignInButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: /Continue with email/ }));
    fireEvent.change(screen.getByLabelText("Your work email"), {
      target: { value: "dana@fund.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(await screen.findByText(/isn't switched on here yet/)).toBeTruthy();
    expect(screen.queryByText(/operator token/)).toBeNull();
  });
});

describe("HeaderSignIn", () => {
  it("shows Sign in, the email account once signed in, and signs it out", async () => {
    render(<HeaderSignIn />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    cleanup();
    saveAccountSession(deployment.chainId, SESSION);
    render(<HeaderSignIn />);
    fireEvent.click(screen.getByRole("button", { name: "dana@fund.example" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(loadAccountSession(deployment.chainId)).toBeUndefined();
  });

  it("is the wallet's own button once a wallet is connected", () => {
    wallet.connected = true;
    render(<HeaderSignIn />);
    expect(screen.getByRole("button", { name: "Wallet 0xa1" })).toBeTruthy();
  });
});
