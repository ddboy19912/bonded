import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  describePaymentMandate,
  gateAccountKey,
  gateDayNumber,
  gateInputHash,
  gateLogProof,
  gateLogRoot,
  gateReceiptHash,
  signGateReceipt,
  type GateInput,
  type GateReceipt,
  type SignedGateReceipt,
} from "@bondedhq/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deployment } from "../config";
import { ApiError } from "../lib/api";
import { saveSession } from "../lib/connect";
import {
  gateApi,
  parseUsd,
  type GateAccount,
  type GateDecision,
  type GateProof,
} from "../lib/gate";
import { Gate } from "./Gate";
import { GateAccount as AccountPage } from "./GateAccount";
import { GateVerify } from "./GateVerify";

const WALLET = "0x00000000000000000000000000000000000000a1";
const wallet = vi.hoisted(() => ({
  address: undefined as string | undefined,
  /** The chain client the page reads GateAnchor with; none unless a test sets one. */
  client: undefined as { readContract: (...args: unknown[]) => Promise<unknown> } | undefined,
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: wallet.address, isConnected: Boolean(wallet.address) }),
  useSignMessage: () => ({ signMessageAsync: async () => "0x5151" }),
  usePublicClient: () => wallet.client,
}));
vi.mock("../components/wallet", () => ({
  ConnectButton: () => <button type="button">Connect wallet</button>,
}));

// A throwaway receipt key, made for this run.
const KEY = generatePrivateKey();
const SIGNER = privateKeyToAccount(KEY).address;
const ACCOUNT_ID = "0b5e7c1a-2f3d-4e5f-8a9b-1c2d3e4f5a6b";
const DAY = "2026-11-02";
const NIMBUS = "GB29NWBK60161331926819";
const FRAUD = "LT121000011101001000";

const account: GateAccount = {
  id: ACCOUNT_ID,
  name: "Acme AP",
  mode: "enforce",
  maxPaymentUsd: 5000,
  maxDailyUsd: 8000,
  freezeOnBreach: false,
  invoiceMatching: true,
  maxPaymentsPerHour: null,
  frozen: false,
  frozenAt: null,
  mandate: { version: 2, hash: `0x${"22".repeat(32)}` },
  rules: describePaymentMandate({
    mode: "enforce",
    maxPaymentUsd: 5000,
    maxDailyUsd: 8000,
    freezeOnBreach: false,
  }),
  createdAt: `${DAY}T09:00:00Z`,
};

/** A check of a payment to `payee`, decided and signed as the API does. */
async function decision(id: string, payee: string, rules: string[], minute: number) {
  const input: GateInput = {
    kind: "invoice",
    day: DAY,
    limits: { maxPaymentCents: 500_000, maxDailyCents: 800_000 },
    attempt: { account: payee, amountCents: 61_240, reference: "NIM-1" },
    payees: payee === NIMBUS ? [{ vendorId: "nimbus", account: NIMBUS }] : [],
    invoices: [{ reference: "NIM-1", vendorId: "nimbus", amountCents: 61_240 }],
    payments: [],
  };
  const createdAt = `${DAY}T10:0${minute}:00Z`;
  const receipt: GateReceipt = {
    decisionId: id,
    gateAccountId: ACCOUNT_ID,
    kind: "invoice",
    decision: rules.length ? "breach" : "pass",
    result: rules.length ? "blocked" : "allowed",
    mode: "enforce",
    rules: rules as GateReceipt["rules"],
    amountCents: 61_240,
    payee,
    reference: "NIM-1",
    inputHash: gateInputHash(input),
    mandateHash: account.mandate.hash as `0x${string}`,
    mandateVersion: 2,
    checkedAt: Date.parse(createdAt) / 1000,
  };
  const signed = await signGateReceipt(receipt, KEY);
  const view: GateDecision = {
    id,
    kind: "invoice",
    decision: receipt.decision,
    result: receipt.result,
    message: rules.length
      ? "Blocked: the account is not in the vendor master."
      : "Allowed: no rule broken.",
    rules,
    reasons: [],
    amountUsd: 612.4,
    payee,
    vendorId: rules.length ? null : "nimbus",
    reference: "NIM-1",
    inputHash: receipt.inputHash,
    input,
    mandate: { version: 2, hash: account.mandate.hash },
    createdAt,
    receipt: signed,
  };
  return view;
}

let paid: GateDecision;
let blocked: GateDecision;
let proofs: Record<string, GateProof>;

beforeAll(async () => {
  paid = await decision("6f1c2b9e-1d2a-4c3b-9a8e-0f1e2d3c4b5a", NIMBUS, [], 1);
  blocked = await decision(
    "7a2d3c0f-2e3b-4d4c-8b9f-1a2b3c4d5e6f",
    FRAUD,
    ["unknown_payee", "unmatched_invoice"],
    2,
  );
  const day = [paid, blocked].map((d) => gateReceiptHash(d.receipt.receipt));
  const root = gateLogRoot(day);
  proofs = Object.fromEntries(
    [paid, blocked].map((d, i) => [
      d.id,
      {
        decisionId: d.id,
        day: DAY,
        dayNumber: gateDayNumber(DAY),
        accountKey: gateAccountKey(ACCOUNT_ID),
        receiptHash: day[i]!,
        root,
        proof: gateLogProof(day, i),
        posted: null,
      },
    ]),
  );
});

function show(at = "/gate") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[at]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/gate" element={<Gate />} />
          <Route path="/gate/:accountId" element={<AccountPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
/** The account's page, on one of its tabs. */
const showAccount = (tab?: string) => show(`/gate/${ACCOUNT_ID}${tab ? `?tab=${tab}` : ""}`);
const signedIn = () =>
  saveSession(deployment.chainId, {
    session: "sess",
    wallet: WALLET,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

/** Open the decision whose row says this, and the modal it opens. */
async function open(text: RegExp) {
  fireEvent.click(await screen.findByRole("button", { name: text }));
  return await screen.findByRole("dialog");
}
/** Press Verify in a decision's modal, and the step's row once it is done. */
async function verify(modal: HTMLElement) {
  fireEvent.click(within(modal).getByRole("button", { name: "Verify" }));
  const panel = await within(modal).findByLabelText("Verification");
  return (label: string) => within(panel).getByText(label).closest("li") as HTMLElement;
}
/** Press a button that opens a modal, and the modal. */
async function press(name: string) {
  fireEvent.click(await screen.findByRole("button", { name }));
  return await screen.findByRole("dialog");
}
const fill = (where: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(where).getByLabelText(label), { target: { value } });

/** Wide screens get modals, phones get drawers: `wide` picks which this test sees. */
let wide = true;
beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  wallet.address = WALLET;
  vi.spyOn(gateApi, "accounts").mockResolvedValue({ items: [account] });
  vi.spyOn(gateApi, "vendors").mockResolvedValue({
    items: [{ id: "nimbus", name: "Nimbus Cloud", account: "GB29 NWBK 6016 1331 9268 19" }],
  });
  vi.spyOn(gateApi, "mandates").mockResolvedValue({
    items: [
      {
        version: 2,
        hash: account.mandate.hash,
        createdBy: WALLET,
        createdAt: `${DAY}T09:05:00Z`,
        rules: account.rules,
        mandate: { vendors: [] },
        posted: {
          chainId: 46630,
          contract: "0x0000000000000000000000000000000000000abc",
          txHash: `0x${"cd".repeat(32)}`,
          postedAt: `${DAY}T09:10:00Z`,
        },
      },
      {
        version: 1,
        hash: `0x${"11".repeat(32)}`,
        createdBy: WALLET,
        createdAt: `${DAY}T09:00:00Z`,
        rules: account.rules,
        mandate: { vendors: [] },
        posted: null,
      },
    ],
    next: null,
  });
  vi.spyOn(gateApi, "decisions").mockResolvedValue({ items: [blocked, paid], next: null });
  vi.spyOn(gateApi, "lastDecision").mockResolvedValue({ items: [], next: null });
  vi.spyOn(gateApi, "receiptKey").mockResolvedValue({ address: SIGNER });
  vi.spyOn(gateApi, "proof").mockImplementation(async (_s, _a, id) => proofs[id]!);
  vi.spyOn(gateApi, "invoices").mockResolvedValue({
    items: [
      { id: "7", vendorId: "nimbus", reference: "NIM-1", amountCents: 61_240, createdAt: DAY },
    ],
    next: null,
  });
  vi.spyOn(gateApi, "tickets").mockResolvedValue({ items: [] });
  vi.spyOn(gateApi, "stripeLink").mockResolvedValue(null);
  vi.spyOn(gateApi, "keys").mockResolvedValue({
    items: [
      {
        id: "k1",
        prefix: "bonded_gk_AbCd",
        label: "Payables agent",
        createdAt: `${DAY}T09:00:00Z`,
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
  });
});
afterEach(() => {
  cleanup();
  wide = true;
  wallet.client = undefined;
  delete deployment.gateAnchor;
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

describe("the payment gate's rules page", () => {
  it("asks for a wallet, then a sign-in", async () => {
    wallet.address = undefined;
    show();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    cleanup();
    wallet.address = WALLET;
    show();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(gateApi.accounts).not.toHaveBeenCalled();
  });

  it("links to the setup guide and the public receipt check, even with no wallet", () => {
    wallet.address = undefined;
    show();
    expect(screen.getByRole("link", { name: "How to connect an agent" }).getAttribute("href")).toBe(
      "/docs/guides/payment-gate/",
    );
    expect(screen.getByRole("link", { name: "Check a receipt" }).getAttribute("href")).toBe(
      "/gate/verify",
    );
  });

  it("lists every account, and each row opens that account", async () => {
    vi.mocked(gateApi.accounts).mockResolvedValue({
      items: [
        account,
        { ...account, id: "second", name: "Growth", mode: "monitor", maxPaymentUsd: 1500.5 },
        { ...account, id: "third", name: "Travel", frozen: true },
      ],
    });
    signedIn();
    show();
    const list = await screen.findByRole("table", { name: "Gate accounts" });
    const rows = within(list).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getAllByText("Enforcing").length).toBeGreaterThan(0);
    expect(within(rows[1]!).getAllByText("Monitoring").length).toBeGreaterThan(0);
    expect(within(rows[1]!).getAllByText("$1,500.50").length).toBeGreaterThan(0);
    expect(within(rows[0]!).getAllByText("$5,000").length).toBeGreaterThan(0);
    // Each row asks for one decision, not the account's whole log.
    expect(await within(rows[0]!).findByText("Never")).toBeTruthy();
    expect(gateApi.lastDecision).toHaveBeenCalledTimes(3);
    expect(gateApi.decisions).not.toHaveBeenCalled();
    expect(within(rows[2]!).getAllByText("Frozen").length).toBeGreaterThan(0);
    // No account's detail is on the list.
    expect(screen.queryByText("No single payment over $5,000.")).toBeNull();
    expect(within(rows[0]!).getByRole("link").getAttribute("href")).toBe(`/gate/${ACCOUNT_ID}`);
    fireEvent.click(within(rows[0]!).getByRole("link"));
    expect(await screen.findByRole("heading", { name: "Acme AP" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Activity", selected: true })).toBeTruthy();
  });

  it("says when the wallet doesn't own the account", async () => {
    signedIn();
    show("/gate/someone-elses");
    expect(await screen.findByText("Account not found")).toBeTruthy();
  });

  it("opens the tab the link names, and shows one tab at a time", async () => {
    signedIn();
    showAccount("rules");
    expect(await screen.findByRole("tab", { name: "Rules", selected: true })).toBeTruthy();
    expect(await screen.findByText("No single payment over $5,000.")).toBeTruthy();
    expect(gateApi.decisions).not.toHaveBeenCalled();
    expect(gateApi.keys).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "API keys" }));
    expect(await screen.findByText("bonded_gk_AbCd…")).toBeTruthy();
    expect(screen.queryByText("No single payment over $5,000.")).toBeNull();
  });

  it("shows the rules in plain words, every version's hash and the log", async () => {
    signedIn();
    showAccount("rules");
    expect(await screen.findByText("No single payment over $5,000.")).toBeTruthy();
    // Version 2 is on chain, version 1 isn't yet.
    const history = await press("Version history");
    const rows = await within(history).findAllByRole("row");
    expect(within(rows[1]!).getByText("Posted")).toBeTruthy();
    expect(within(rows[2]!).getByText("Not yet")).toBeTruthy();
    expect(within(rows[2]!).getByTitle(`0x${"11".repeat(32)}`)).toBeTruthy();
    cleanup();

    // The decisions, newest first.
    showAccount();
    const log = await screen.findByRole("table", { name: "Decisions" });
    const items = (await within(log).findAllByRole("row")).slice(1);
    expect(within(items[0]!).getAllByText("Blocked").length).toBeGreaterThan(0);
    expect(within(items[1]!).getAllByText("Allowed").length).toBeGreaterThan(0);
  });

  it("opens forms in a modal on wide screens and a drawer on phones", async () => {
    signedIn();
    showAccount("keys");
    expect((await press("New key")).getAttribute("data-vaul-drawer-direction")).toBeNull();
    cleanup();
    wide = false;
    showAccount("keys");
    expect((await press("New key")).getAttribute("data-vaul-drawer-direction")).toBe("bottom");
  });

  it("verifies a genuine receipt: signature, input hash, rules and log root", async () => {
    signedIn();
    showAccount();
    const step = await verify(await open(/Blocked: the account is not in the vendor master/));
    for (const label of ["Bonded's signature", "Input hash", "Rules, run again", "Daily log root"])
      expect(within(step(label)).getByText("Passed")).toBeTruthy();
    expect(screen.getByText("No check failed.")).toBeTruthy();
    expect(within(step("Daily log root")).getByText(/isn't posted on chain yet/)).toBeTruthy();
    expect(gateApi.proof).toHaveBeenCalledWith("sess", ACCOUNT_ID, blocked.id);
  });

  it("shows which checks a tampered receipt fails", async () => {
    // The receipt now says the blocked payment was allowed, under Bonded's old signature.
    const signed: SignedGateReceipt = {
      ...blocked.receipt,
      receipt: { ...blocked.receipt.receipt, result: "allowed", rules: [] },
    };
    vi.mocked(gateApi.decisions).mockResolvedValue({
      items: [{ ...blocked, receipt: signed }],
      next: null,
    });
    signedIn();
    showAccount();
    const step = await verify(await open(/Blocked: the account is not in the vendor master/));
    expect(within(step("Bonded's signature")).getByText("Failed")).toBeTruthy();
    expect(within(step("Daily log root")).getByText("Failed")).toBeTruthy();
    // Its input is untouched, but the rules, run again, still break two rules.
    expect(within(step("Input hash")).getByText("Passed")).toBeTruthy();
    expect(within(step("Rules, run again")).getByText("Failed")).toBeTruthy();
    expect(screen.getByText("3 checks failed.")).toBeTruthy();
  });

  it("says why the log root can't be checked yet", async () => {
    vi.mocked(gateApi.proof).mockRejectedValue(
      new ApiError(
        409,
        "This decision's day has no log root yet. It is made once the day ends (UTC).",
      ),
    );
    signedIn();
    showAccount();
    const step = await verify(await open(/Allowed: no rule broken/));
    expect(within(step("Daily log root")).getByText("Not checked")).toBeTruthy();
    expect(within(step("Daily log root")).getByText(/no log root yet/)).toBeTruthy();
    expect(within(step("Bonded's signature")).getByText("Passed")).toBeTruthy();
  });

  it("fails a proof for another day than the receipt's", async () => {
    // A genuine proof of the receipt, but in a root the API says is a later day's.
    vi.mocked(gateApi.proof).mockImplementation(async (_s, _a, id) => ({
      ...proofs[id]!,
      day: "2026-11-05",
      dayNumber: gateDayNumber("2026-11-05"),
    }));
    signedIn();
    showAccount();
    const step = await verify(await open(/Allowed: no rule broken/));
    expect(within(step("Daily log root")).getByText("Failed")).toBeTruthy();
    expect(within(step("Daily log root")).getByText(/another account or day/)).toBeTruthy();
  });

  it("fails a genuine receipt that doesn't say what the page shows", async () => {
    // Bonded's receipt says blocked; the log shows it as allowed.
    vi.mocked(gateApi.decisions).mockResolvedValue({
      items: [{ ...blocked, result: "allowed", message: "Allowed: no rule broken." }],
      next: null,
    });
    signedIn();
    showAccount();
    const step = await verify(await open(/Allowed: no rule broken/));
    expect(within(step("Bonded's signature")).getByText("Failed")).toBeTruthy();
    expect(within(step("Bonded's signature")).getByText(/its result/)).toBeTruthy();
  });

  it("reads the root from the app's own GateAnchor, for the receipt's account and day", async () => {
    const anchor = "0x00000000000000000000000000000000000a2c40" as const;
    deployment.gateAnchor = anchor;
    const reads: unknown[] = [];
    const posted = {
      chainId: deployment.chainId,
      contract: anchor,
      txHash: null,
      postedAt: `${DAY}T00:10:00Z`,
    };
    // On chain, the day's root is one the receipt isn't in.
    wallet.client = {
      readContract: async (args: unknown) => {
        reads.push(args);
        return { hash: `0x${"ee".repeat(32)}`, postedAt: 1n };
      },
    };
    vi.mocked(gateApi.proof).mockImplementation(async (_s, _a, id) => ({
      ...proofs[id]!,
      posted,
    }));
    signedIn();
    showAccount();
    let step = await verify(await open(/Allowed: no rule broken/));
    expect(within(step("Daily log root")).getByText("Failed")).toBeTruthy();
    expect(
      within(step("Daily log root")).getByText(/Not in the root posted on chain/),
    ).toBeTruthy();
    expect(reads).toEqual([
      expect.objectContaining({
        address: anchor,
        functionName: "logRootOf",
        args: [gateAccountKey(ACCOUNT_ID), gateDayNumber(DAY)],
      }),
    ]);
    cleanup();

    // The API names another contract: the page doesn't read it, and says so.
    reads.length = 0;
    vi.mocked(gateApi.proof).mockImplementation(async (_s, _a, id) => ({
      ...proofs[id]!,
      posted: { ...posted, contract: "0x00000000000000000000000000000000000e0e0e" },
    }));
    showAccount();
    step = await verify(await open(/Allowed: no rule broken/));
    expect(within(step("Daily log root")).getByText(/this page didn't read it there/)).toBeTruthy();
    expect(reads).toEqual([]);
    cleanup();

    // The API says it's posted, but GateAnchor has no root for that day.
    wallet.client = { readContract: async () => ({ hash: `0x${"0".repeat(64)}`, postedAt: 0n }) };
    vi.mocked(gateApi.proof).mockImplementation(async (_s, _a, id) => ({
      ...proofs[id]!,
      posted,
    }));
    showAccount();
    step = await verify(await open(/Allowed: no rule broken/));
    expect(within(step("Daily log root")).getByText("Failed")).toBeTruthy();
    expect(within(step("Daily log root")).getByText(/GateAnchor has none/)).toBeTruthy();
  });

  it("makes a gate account and shows its API key once", async () => {
    vi.mocked(gateApi.accounts).mockResolvedValue({ items: [] });
    const create = vi.spyOn(gateApi, "createAccount").mockImplementation(async () => {
      vi.mocked(gateApi.accounts).mockResolvedValue({ items: [account] });
      return { account, apiKey: { id: "k1", key: "bonded_gk_secret", prefix: "bonded_gk_secr" } };
    });
    signedIn();
    show();
    expect(await screen.findByText("No gate accounts yet")).toBeTruthy();
    const modal = await press("New account");
    fireEvent.click(within(modal).getByRole("button", { name: "Make the account" }));
    expect(within(modal).getAllByText("Enter an amount in dollars.")).toHaveLength(2);
    expect(create).not.toHaveBeenCalled();
    fill(modal, "Name", "Acme AP");
    fill(modal, "Most for one payment", "5,000");
    fill(modal, "Most in one day", "8000");
    fireEvent.click(within(modal).getByLabelText(/^Enforce/));
    fireEvent.click(within(modal).getByRole("button", { name: "Make the account" }));
    expect(await within(modal).findByText("bonded_gk_secret")).toBeTruthy();
    expect(create).toHaveBeenCalledWith("sess", {
      name: "Acme AP",
      mode: "enforce",
      maxPaymentUsd: 5000,
      maxDailyUsd: 8000,
      freezeOnBreach: false,
    });
    // It stays until the owner has it: Escape doesn't lose the key.
    fireEvent.keyDown(modal, { key: "Escape" });
    expect(screen.getByText("bonded_gk_secret")).toBeTruthy();
    // Shown once: on the account's page, it's gone.
    fireEvent.click(within(modal).getByRole("button", { name: "Open the account" }));
    expect(await screen.findByRole("heading", { name: "Acme AP" })).toBeTruthy();
    expect(screen.queryByText("bonded_gk_secret")).toBeNull();
  });

  it("clears a new account's form when it's cancelled", async () => {
    vi.mocked(gateApi.accounts).mockResolvedValue({ items: [] });
    signedIn();
    show();
    let modal = await press("New account");
    fill(modal, "Name", "Half done");
    fireEvent.click(within(modal).getByRole("button", { name: "Make the account" }));
    expect(within(modal).getAllByText("Enter an amount in dollars.")).toHaveLength(2);
    fireEvent.click(within(modal).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    modal = await press("New account");
    expect((within(modal).getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect(within(modal).queryByText("Enter an amount in dollars.")).toBeNull();
  });

  it("doesn't show an old failure when a confirmation opens again", async () => {
    vi.spyOn(gateApi, "revokeKey").mockRejectedValue(new ApiError(500, "Couldn't revoke it."));
    signedIn();
    showAccount("keys");
    let modal = await press("Revoke");
    fireEvent.click(within(modal).getByRole("button", { name: "Revoke key" }));
    expect(await within(modal).findByRole("alert")).toBeTruthy();
    fireEvent.click(within(modal).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    modal = await press("Revoke");
    expect(within(modal).queryByRole("alert")).toBeNull();
  });

  it("keeps a confirmation open while its change is running", async () => {
    vi.spyOn(gateApi, "revokeKey").mockReturnValue(new Promise(() => {}));
    signedIn();
    showAccount("keys");
    const modal = await press("Revoke");
    fireEvent.click(within(modal).getByRole("button", { name: "Revoke key" }));
    const cancel = within(modal).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(cancel.disabled).toBe(true));
    fireEvent.keyDown(modal, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("ties a field's error to the field", async () => {
    signedIn();
    showAccount();
    const modal = await press("Edit rules");
    fill(modal, "Most in one day", "lots");
    const field = within(modal).getByLabelText("Most in one day");
    const note = document.getElementById(field.getAttribute("aria-describedby")!);
    expect(note?.textContent).toBe("Enter an amount in dollars.");
  });

  it("can retry vendors that failed to load, and still add one", async () => {
    vi.mocked(gateApi.vendors).mockRejectedValueOnce(new ApiError(500, "Couldn't load them."));
    signedIn();
    showAccount("vendors");
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Nimbus Cloud")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a vendor" })).toBeTruthy();
  });

  it("turns invoice matching off and sets an hourly limit", async () => {
    const update = vi.spyOn(gateApi, "updateAccount").mockResolvedValue(account);
    signedIn();
    showAccount();
    const modal = await press("Edit rules");
    expect(within(modal).queryByLabelText("Most payments in one hour")).toBeNull();
    fireEvent.click(within(modal).getByRole("switch", { name: "Match invoices" }));
    fill(modal, "Most payments in one hour", "ten");
    const save = within(modal).getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fill(modal, "Most payments in one hour", "10");
    fireEvent.click(save);
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
        invoiceMatching: false,
        maxPaymentsPerHour: 10,
      }),
    );
  });

  it("shows the hourly limit only with invoice matching off", async () => {
    vi.mocked(gateApi.accounts).mockResolvedValue({
      items: [{ ...account, invoiceMatching: false, maxPaymentsPerHour: null }],
    });
    signedIn();
    showAccount("rules");
    expect(await screen.findByText("Most payments in one hour")).toBeTruthy();
    expect(screen.getByText("No limit")).toBeTruthy();
  });

  it("saves the mode and limits as one change", async () => {
    const update = vi.spyOn(gateApi, "updateAccount").mockResolvedValue(account);
    signedIn();
    showAccount();
    const modal = await press("Edit rules");
    const save = within(modal).getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(modal).getByLabelText(/^Monitor/));
    fill(modal, "Most for one payment", "2500.50");
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
        mode: "monitor",
        maxPaymentUsd: 2500.5,
      }),
    );
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("won't save a limit that isn't an amount", async () => {
    signedIn();
    showAccount();
    const modal = await press("Edit rules");
    fireEvent.click(within(modal).getByLabelText(/^Monitor/));
    fill(modal, "Most in one day", "lots");
    expect(within(modal).getByText("Enter an amount in dollars.")).toBeTruthy();
    expect(
      (within(modal).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("says a frozen account is frozen on every tab, and asks before lifting it", async () => {
    const lift = vi.spyOn(gateApi, "unfreeze").mockResolvedValue(account);
    vi.mocked(gateApi.accounts).mockResolvedValue({ items: [{ ...account, frozen: true }] });
    signedIn();
    showAccount("invoices");
    expect(await screen.findByText(/Every check is refused until you lift it/)).toBeTruthy();
    const modal = await press("Lift the freeze");
    expect(lift).not.toHaveBeenCalled();
    fireEvent.click(within(modal).getByRole("button", { name: "Lift the freeze" }));
    await vi.waitFor(() => expect(lift).toHaveBeenCalledWith("sess", ACCOUNT_ID));
  });

  it("adds a vendor, and a verified bank change on the vendor", async () => {
    const vendor = vi.spyOn(gateApi, "addVendor").mockResolvedValue({
      id: "orbit-print",
      name: "Orbit Print",
      account: "DE89 3704 0044 0532 0130 00",
    });
    const ticket = vi.spyOn(gateApi, "addTicket").mockResolvedValue({
      id: "FIN-1",
      vendorId: "nimbus",
      account: "X",
      verifiedBy: "Dana",
      usedBy: null,
      createdAt: DAY,
    });
    signedIn();
    showAccount("vendors");
    expect(await screen.findByText("Nimbus Cloud")).toBeTruthy();
    let modal = await press("Add a vendor");
    fill(modal, "Vendor", "Orbit Print");
    expect(within(modal).getByText(/Its id is orbit-print/)).toBeTruthy();
    fill(modal, "Verified bank account", "DE89 3704 0044 0532 0130 00");
    fireEvent.click(within(modal).getByRole("button", { name: "Add vendor" }));
    await vi.waitFor(() =>
      expect(vendor).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
        id: "orbit-print",
        name: "Orbit Print",
        account: "DE89 3704 0044 0532 0130 00",
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    modal = await open(/Nimbus Cloud/);
    expect(within(modal).getByText("GB29 NWBK 6016 1331 9268 19")).toBeTruthy();
    fireEvent.click(within(modal).getByRole("button", { name: "Add a verified change" }));
    fill(modal, "Ticket", "FIN-1");
    fill(modal, "New bank account", "GB33 BUKB 2020 1555 5555 55");
    fill(modal, "Verified by", "Dana");
    fireEvent.click(within(modal).getByRole("button", { name: "Add ticket" }));
    await vi.waitFor(() =>
      expect(ticket).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
        id: "FIN-1",
        vendorId: "nimbus",
        account: "GB33 BUKB 2020 1555 5555 55",
        verifiedBy: "Dana",
      }),
    );
  });

  it("shows a vendor's own tickets, and how many are ready", async () => {
    const ticket = (id: string, vendorId: string, usedBy: string | null) => ({
      id,
      vendorId,
      account: "GB33 BUKB 2020 1555 5555 55",
      verifiedBy: "Dana",
      usedBy,
      createdAt: DAY,
    });
    vi.mocked(gateApi.tickets).mockResolvedValue({
      items: [
        ticket("FIN-1", "nimbus", null),
        ticket("FIN-2", "nimbus", "d1"),
        ticket("FIN-3", "other", null),
      ],
    });
    const remove = vi.spyOn(gateApi, "deleteTicket").mockResolvedValue({ deleted: true });
    signedIn();
    showAccount("vendors");
    expect(await screen.findByText("1 bank change ready")).toBeTruthy();
    const modal = await open(/Nimbus Cloud/);
    expect(within(modal).getByText("FIN-1")).toBeTruthy();
    expect(within(modal).getByText("FIN-2")).toBeTruthy();
    expect(within(modal).queryByText("FIN-3")).toBeNull();
    // A used ticket can't be removed: only FIN-1 has the button.
    fireEvent.click(within(modal).getByRole("button", { name: "Remove" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove ticket" }));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("sess", ACCOUNT_ID, "FIN-1"));
  });

  it("approves an invoice, and asks before removing one", async () => {
    const invoice = vi.spyOn(gateApi, "addInvoice").mockResolvedValue({
      id: "8",
      vendorId: "nimbus",
      reference: "NIM-2",
      amountCents: 1,
      createdAt: DAY,
    });
    const remove = vi.spyOn(gateApi, "deleteInvoice").mockResolvedValue({ deleted: true });
    signedIn();
    showAccount("invoices");
    expect(await screen.findByText("$612.40")).toBeTruthy();
    expect(await screen.findByText("Nimbus Cloud")).toBeTruthy();
    let modal = await press("Approve an invoice");
    fill(modal, "Invoice number", "NIM-2");
    fill(modal, "Amount", "612.40");
    fireEvent.click(within(modal).getByRole("button", { name: "Approve" }));
    await vi.waitFor(() =>
      expect(invoice).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
        vendorId: "nimbus",
        reference: "NIM-2",
        amountUsd: 612.4,
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    modal = await press("Remove");
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(modal).getByRole("button", { name: "Remove invoice" }));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("sess", ACCOUNT_ID, "7"));
  });

  it("asks for a vendor before an invoice can be approved", async () => {
    vi.mocked(gateApi.vendors).mockResolvedValue({ items: [] });
    vi.mocked(gateApi.invoices).mockResolvedValue({ items: [], next: null });
    signedIn();
    showAccount("invoices");
    expect(await screen.findByText("Add a vendor first.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve an invoice" })).toBeNull();
  });

  it("links Stripe for card payments, shows only a hint, and lists the cards", async () => {
    const linked = {
      linked: true as const,
      keyHint: "rk_test_…abcd",
      livemode: false,
      cardholderId: "ich_1234567890",
      webhookSecrets: { authorization: true, events: true },
      createdAt: `${DAY}T09:00:00Z`,
      updatedAt: `${DAY}T09:00:00Z`,
    };
    const link = vi.spyOn(gateApi, "linkStripe").mockResolvedValue(linked);
    vi.spyOn(gateApi, "cardIntents").mockResolvedValue({
      items: [
        {
          id: "i1",
          status: "paid",
          vendorId: "nimbus",
          invoiceReference: "NIM-1",
          amountUsd: 612.4,
          card: { id: "ic_1", last4: "4242" },
          createdAt: `${DAY}T09:00:00Z`,
          updatedAt: `${DAY}T09:00:00Z`,
        },
      ],
      next: null,
    });
    signedIn();
    showAccount("cards");
    const modal = await press("Link Stripe");
    const button = within(modal).getByRole("button", { name: "Link Stripe" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The steps say where each value comes from, with the addresses to paste.
    expect(within(modal).getByText(/\/stripe\/issuing\/authorization$/)).toBeTruthy();
    expect(within(modal).getByText(/\/stripe\/issuing\/events$/)).toBeTruthy();
    expect(
      within(modal)
        .getByRole("link", { name: /Open Cardholders in Stripe/ })
        .getAttribute("href"),
    ).toBe("https://dashboard.stripe.com/issuing/cardholders");
    // A live key is refused here, before it goes anywhere.
    fill(modal, "Restricted key", "rk_live_abcdefghijklmnop");
    fill(modal, "Cardholder ID", "ich_1234567890");
    fill(modal, "Signing secret for this address", "whsec_abcdefghijklmnop");
    fill(modal, "Signing secret for this destination", "whsec_qrstuvwxyzabcdef");
    expect(button.disabled).toBe(true);
    expect(within(modal).getByText("Use a test key: it starts with rk_test_.")).toBeTruthy();
    fill(modal, "Restricted key", "rk_test_abcdefghijklmnop");
    expect(button.disabled).toBe(false);
    vi.mocked(gateApi.stripeLink).mockResolvedValue(linked);
    fireEvent.click(button);
    expect(await screen.findByText("rk_test_…abcd")).toBeTruthy();
    expect(link).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
      secretKey: "rk_test_abcdefghijklmnop",
      cardholderId: "ich_1234567890",
      authorizationWebhookSecret: "whsec_abcdefghijklmnop",
      eventsWebhookSecret: "whsec_qrstuvwxyzabcdef",
    });
    expect(await screen.findByText("•••• 4242")).toBeTruthy();
    expect(screen.getByText("paid")).toBeTruthy();
  });

  it("asks before unlinking Stripe", async () => {
    vi.mocked(gateApi.stripeLink).mockResolvedValue({
      linked: true,
      keyHint: "rk_test_…abcd",
      livemode: false,
      cardholderId: "ich_1234567890",
      webhookSecrets: { authorization: true, events: true },
      createdAt: DAY,
      updatedAt: DAY,
    });
    vi.spyOn(gateApi, "cardIntents").mockResolvedValue({ items: [], next: null });
    const unlink = vi.spyOn(gateApi, "unlinkStripe").mockResolvedValue({ unlinked: true });
    signedIn();
    showAccount("cards");
    const modal = await press("Unlink");
    expect(unlink).not.toHaveBeenCalled();
    fireEvent.click(within(modal).getByRole("button", { name: "Unlink Stripe" }));
    await vi.waitFor(() => expect(unlink).toHaveBeenCalledWith("sess", ACCOUNT_ID));
  });

  it("adds a vendor's card merchant, and needs its id with its name", async () => {
    const add = vi
      .spyOn(gateApi, "addVendor")
      .mockResolvedValue({ id: "nimbus-2", name: "Nimbus 2", account: NIMBUS });
    signedIn();
    showAccount("vendors");
    const modal = await press("Add a vendor");
    fill(modal, "Vendor", "Nimbus 2");
    fill(modal, "Verified bank account", NIMBUS);
    fill(modal, "Card merchant (optional)", "NIMBUS CLOUD");
    const button = within(modal).getByRole("button", { name: "Add vendor" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fill(modal, "Card merchant id", "123456789012");
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
        id: "nimbus-2",
        name: "Nimbus 2",
        account: NIMBUS,
        cardMerchant: { name: "NIMBUS CLOUD", networkId: "123456789012" },
      }),
    );
  });

  it("makes an API key, shown once, and asks before revoking one", async () => {
    const create = vi.spyOn(gateApi, "createKey").mockResolvedValue({
      id: "k2",
      prefix: "bonded_gk_ZzZz",
      label: "",
      createdAt: DAY,
      lastUsedAt: null,
      revokedAt: null,
      key: "bonded_gk_second",
    });
    const revoke = vi.spyOn(gateApi, "revokeKey").mockResolvedValue({ revoked: true });
    signedIn();
    showAccount("keys");
    expect(await screen.findByText("bonded_gk_AbCd…")).toBeTruthy();
    let modal = await press("Revoke");
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(within(modal).getByRole("button", { name: "Revoke key" }));
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("sess", ACCOUNT_ID, "k1"));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    modal = await press("New key");
    fireEvent.click(within(modal).getByRole("button", { name: "Make key" }));
    expect(await within(modal).findByText("bonded_gk_second")).toBeTruthy();
    expect(create).toHaveBeenCalledWith("sess", ACCOUNT_ID, "");
    // Gone once it's closed.
    fireEvent.click(within(modal).getByRole("button", { name: "Done" }));
    await vi.waitFor(() => expect(screen.queryByText("bonded_gk_second")).toBeNull());
  });
});

describe("checking a receipt without signing in", () => {
  function showVerify() {
    wallet.address = undefined;
    render(
      <MemoryRouter initialEntries={["/gate/verify"]}>
        <Routes>
          <Route path="/gate/verify" element={<GateVerify />} />
        </Routes>
      </MemoryRouter>,
    );
  }
  /** Paste the text and press Check; the step's row once it is done. */
  async function check(text: string) {
    fireEvent.change(screen.getByLabelText("Receipt"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    const panel = await screen.findByLabelText("Verification");
    return (label: string) => within(panel).getByText(label).closest("li") as HTMLElement;
  }
  const shared = (d: GateDecision, proof?: GateProof) =>
    JSON.stringify({ receipt: d.receipt, input: d.input, ...(proof ? { proof } : {}) });

  it("checks a copied receipt and its proof, with no wallet and no API but the receipt key", async () => {
    showVerify();
    const step = await check(shared(blocked, proofs[blocked.id]));
    for (const label of ["Bonded's signature", "Input hash", "Rules, run again", "Daily log root"])
      expect(within(step(label)).getByText("Passed")).toBeTruthy();
    expect(screen.getByText("No check failed.")).toBeTruthy();
    // What the signed receipt says, in plain words.
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("Payment of $612.40")).toBeTruthy();
    expect(screen.getByText("the account is not in the vendor master")).toBeTruthy();
    expect(gateApi.proof).not.toHaveBeenCalled();
    expect(gateApi.accounts).not.toHaveBeenCalled();
  });

  it("checks an agent's check answer, which has no log proof", async () => {
    showVerify();
    // The API's answer to POST /payments/check: the decision, its receipt and its input.
    const step = await check(JSON.stringify({ ...blocked, frozen: false, replayed: false }));
    expect(within(step("Bonded's signature")).getByText("Passed")).toBeTruthy();
    expect(within(step("Rules, run again")).getByText("Passed")).toBeTruthy();
    expect(within(step("Daily log root")).getByText("Not checked")).toBeTruthy();
    expect(within(step("Daily log root")).getByText(/No log proof pasted/)).toBeTruthy();
  });

  it("fails a receipt changed after it was signed", async () => {
    showVerify();
    const forged = {
      ...blocked,
      receipt: {
        ...blocked.receipt,
        receipt: { ...blocked.receipt.receipt, result: "allowed", rules: [] },
      },
    };
    const step = await check(JSON.stringify(forged));
    expect(within(step("Bonded's signature")).getByText("Failed")).toBeTruthy();
    expect(within(step("Rules, run again")).getByText("Failed")).toBeTruthy();
  });

  it("says when the text isn't a receipt", async () => {
    showVerify();
    fireEvent.change(screen.getByLabelText("Receipt"), { target: { value: '{"hello": 1}' } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/That isn't a gate receipt/)).toBeTruthy();
    expect(gateApi.receiptKey).not.toHaveBeenCalled();
  });

  it("lets the owner copy a receipt with its proof once Verify has loaded it", async () => {
    signedIn();
    showAccount();
    const modal = await open(/Blocked: the account is not in the vendor master/);
    expect(within(modal).getByRole("button", { name: "Copy receipt" })).toBeTruthy();
    await verify(modal);
    expect(within(modal).getByRole("button", { name: "Copy receipt and proof" })).toBeTruthy();
    expect(within(modal).getByRole("link", { name: "Anyone can check it" })).toHaveProperty(
      "pathname",
      "/gate/verify",
    );
  });
});

describe("parseUsd", () => {
  it("takes dollars with at most two decimals", () => {
    expect(parseUsd("612.40")).toBe(612.4);
    expect(parseUsd("$5,000")).toBe(5000);
    for (const bad of ["", "0", "-5", "1.234", "abc", "1e3"]) expect(parseUsd(bad)).toBeNull();
  });
});
