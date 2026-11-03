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

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={["/gate"]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/gate" element={<Gate />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
const signedIn = () =>
  saveSession(deployment.chainId, {
    session: "sess",
    wallet: WALLET,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

/** The decision's row in the log. */
const row = async (text: RegExp) => (await screen.findByText(text)).closest("li") as HTMLElement;
/** Press Verify on a row, and the step's badge once it is done. */
async function verify(item: HTMLElement) {
  fireEvent.click(within(item).getByRole("button", { name: "Verify" }));
  const panel = await within(item).findByLabelText("Verification");
  return (label: string) => within(panel).getByText(label).closest("li") as HTMLElement;
}

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
  vi.spyOn(gateApi, "receiptKey").mockResolvedValue({ address: SIGNER });
  vi.spyOn(gateApi, "proof").mockImplementation(async (_s, _a, id) => proofs[id]!);
  vi.spyOn(gateApi, "invoices").mockResolvedValue({
    items: [
      { id: "7", vendorId: "nimbus", reference: "NIM-1", amountCents: 61_240, createdAt: DAY },
    ],
    next: null,
  });
  vi.spyOn(gateApi, "tickets").mockResolvedValue({ items: [] });
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

  it("shows the rules in plain words, the vendors, every version's hash and the log", async () => {
    signedIn();
    show();
    expect(await screen.findByText("No single payment over $5,000.")).toBeTruthy();
    const rules = screen.getByRole("heading", { name: "Rules" }).closest("section") as HTMLElement;
    expect(within(rules).getByText("Enforce")).toBeTruthy();
    expect(await within(rules).findByText("GB29 NWBK 6016 1331 9268 19")).toBeTruthy();
    // Version 2 is on chain, version 1 isn't yet.
    const history = (await screen.findByRole("heading", { name: "Changes" })).closest(
      "section",
    ) as HTMLElement;
    const rows = await within(history).findAllByRole("row");
    expect(within(rows[1]!).getByText("Posted")).toBeTruthy();
    expect(within(rows[2]!).getByText("Not yet")).toBeTruthy();
    expect(within(rows[2]!).getByTitle(`0x${"11".repeat(32)}`)).toBeTruthy();
    // The decisions, newest first.
    const log = await screen.findByRole("list", { name: "Decisions" });
    const items = within(log).getAllByRole("listitem");
    expect(within(items[0]!).getByText("Blocked")).toBeTruthy();
    expect(within(items[1]!).getByText("Allowed")).toBeTruthy();
  });

  it("verifies a genuine receipt: signature, input hash, rules and log root", async () => {
    signedIn();
    show();
    const step = await verify(await row(/Blocked: the account is not in the vendor master/));
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
    show();
    const step = await verify(await row(/Blocked: the account is not in the vendor master/));
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
    show();
    const step = await verify(await row(/Allowed: no rule broken/));
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
    show();
    const step = await verify(await row(/Allowed: no rule broken/));
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
    show();
    const step = await verify(await row(/Allowed: no rule broken/));
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
    show();
    let step = await verify(await row(/Allowed: no rule broken/));
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
    show();
    step = await verify(await row(/Allowed: no rule broken/));
    expect(within(step("Daily log root")).getByText(/this page didn't read it there/)).toBeTruthy();
    expect(reads).toEqual([]);
    cleanup();

    // The API says it's posted, but GateAnchor has no root for that day.
    wallet.client = { readContract: async () => ({ hash: `0x${"0".repeat(64)}`, postedAt: 0n }) };
    vi.mocked(gateApi.proof).mockImplementation(async (_s, _a, id) => ({
      ...proofs[id]!,
      posted,
    }));
    show();
    step = await verify(await row(/Allowed: no rule broken/));
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
    expect(await screen.findByRole("heading", { name: "New gate account" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make the account" }));
    expect(screen.getAllByText("Enter an amount in dollars.")).toHaveLength(2);
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Acme AP" } });
    fireEvent.change(screen.getByLabelText("Most for one payment"), {
      target: { value: "5,000" },
    });
    fireEvent.change(screen.getByLabelText("Most in one day"), { target: { value: "8000" } });
    fireEvent.click(screen.getByLabelText(/^Enforce/));
    fireEvent.click(screen.getByRole("button", { name: "Make the account" }));
    expect(await screen.findByText("bonded_gk_secret")).toBeTruthy();
    expect(create).toHaveBeenCalledWith("sess", {
      name: "Acme AP",
      mode: "enforce",
      maxPaymentUsd: 5000,
      maxDailyUsd: 8000,
      freezeOnBreach: false,
    });
    expect(await screen.findByText("No single payment over $5,000.")).toBeTruthy();
    // Shown once: leaving for another new account and coming back doesn't show it again.
    fireEvent.click(screen.getByRole("button", { name: "New account" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("No single payment over $5,000.")).toBeTruthy();
    expect(screen.queryByText("bonded_gk_secret")).toBeNull();
  });

  it("switches the mode and saves new limits", async () => {
    const update = vi.spyOn(gateApi, "updateAccount").mockResolvedValue(account);
    signedIn();
    show();
    const settings = (await screen.findByRole("heading", { name: "Settings" })).closest(
      "section",
    ) as HTMLElement;
    fireEvent.click(within(settings).getByLabelText(/^Monitor/));
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith("sess", ACCOUNT_ID, { mode: "monitor" }),
    );
    const save = within(settings).getByRole("button", { name: "Save limits" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(settings).getByLabelText("Most for one payment"), {
      target: { value: "2500.50" },
    });
    // Once the mode change is done, the button takes the new limit.
    await vi.waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
        maxPaymentUsd: 2500.5,
        maxDailyUsd: 8000,
      }),
    );
  });

  it("adds a vendor, approves an invoice and adds a verified bank change", async () => {
    const vendor = vi.spyOn(gateApi, "addVendor").mockResolvedValue({
      id: "orbit-print",
      name: "Orbit Print",
      account: "DE89 3704 0044 0532 0130 00",
    });
    const invoice = vi.spyOn(gateApi, "addInvoice").mockResolvedValue({
      id: "8",
      vendorId: "nimbus",
      reference: "NIM-2",
      amountCents: 1,
      createdAt: DAY,
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
    show();
    const section = async (name: string) =>
      (await screen.findByRole("heading", { name })).closest("section") as HTMLElement;

    const rules = await section("Rules");
    fireEvent.click(within(rules).getByRole("button", { name: "Add a vendor" }));
    fireEvent.change(within(rules).getByLabelText("Vendor"), {
      target: { value: "Orbit Print" },
    });
    expect(within(rules).getByText(/Its id is orbit-print/)).toBeTruthy();
    fireEvent.change(within(rules).getByLabelText("Verified bank account"), {
      target: { value: "DE89 3704 0044 0532 0130 00" },
    });
    fireEvent.click(within(rules).getByRole("button", { name: "Add vendor" }));
    await vi.waitFor(() =>
      expect(vendor).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
        id: "orbit-print",
        name: "Orbit Print",
        account: "DE89 3704 0044 0532 0130 00",
      }),
    );

    const invoices = await section("Approved invoices");
    expect(await within(invoices).findByText("$612.40")).toBeTruthy();
    expect(within(invoices).getByText("Nimbus Cloud")).toBeTruthy();
    fireEvent.click(within(invoices).getByRole("button", { name: "Approve an invoice" }));
    fireEvent.change(within(invoices).getByLabelText("Invoice number"), {
      target: { value: "NIM-2" },
    });
    fireEvent.change(within(invoices).getByLabelText("Amount"), { target: { value: "612.40" } });
    fireEvent.click(within(invoices).getByRole("button", { name: "Approve" }));
    await vi.waitFor(() =>
      expect(invoice).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
        vendorId: "nimbus",
        reference: "NIM-2",
        amountUsd: 612.4,
      }),
    );

    const changes = await section("Bank changes");
    fireEvent.click(await within(changes).findByRole("button", { name: "Add a verified change" }));
    fireEvent.change(within(changes).getByLabelText("Ticket"), { target: { value: "FIN-1" } });
    fireEvent.change(within(changes).getByLabelText("New bank account"), {
      target: { value: "GB33 BUKB 2020 1555 5555 55" },
    });
    fireEvent.change(within(changes).getByLabelText("Verified by"), {
      target: { value: "Dana" },
    });
    fireEvent.click(within(changes).getByRole("button", { name: "Add ticket" }));
    await vi.waitFor(() =>
      expect(ticket).toHaveBeenCalledWith("sess", ACCOUNT_ID, {
        id: "FIN-1",
        vendorId: "nimbus",
        account: "GB33 BUKB 2020 1555 5555 55",
        verifiedBy: "Dana",
      }),
    );
  });

  it("makes an API key, shown once, and revokes one", async () => {
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
    show();
    const keys = (await screen.findByRole("heading", { name: "API keys" })).closest(
      "section",
    ) as HTMLElement;
    expect(await within(keys).findByText("bonded_gk_AbCd…")).toBeTruthy();
    fireEvent.click(within(keys).getByRole("button", { name: "Revoke" }));
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("sess", ACCOUNT_ID, "k1"));
    fireEvent.click(within(keys).getByRole("button", { name: "New key" }));
    const make = within(keys).getByRole("button", { name: "Make key" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(make.disabled).toBe(false));
    fireEvent.click(make);
    expect(await within(keys).findByText("bonded_gk_second")).toBeTruthy();
    expect(create).toHaveBeenCalledWith("sess", ACCOUNT_ID, "");
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
    show();
    const item = await row(/Blocked: the account is not in the vendor master/);
    expect(within(item).getByRole("button", { name: "Copy receipt" })).toBeTruthy();
    await verify(item);
    expect(within(item).getByRole("button", { name: "Copy receipt and proof" })).toBeTruthy();
    expect(within(item).getByRole("link", { name: "Anyone can check it" })).toHaveProperty(
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
