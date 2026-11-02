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
import { gateApi, type GateAccount, type GateDecision, type GateProof } from "../lib/gate";
import { Gate } from "./Gate";

const WALLET = "0x00000000000000000000000000000000000000a1";
const wallet = vi.hoisted(() => ({ address: undefined as string | undefined }));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: wallet.address, isConnected: Boolean(wallet.address) }),
  useSignMessage: () => ({ signMessageAsync: async () => "0x5151" }),
  usePublicClient: () => undefined,
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
});
afterEach(() => {
  cleanup();
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

  it("shows the rules in plain words, the vendors, every version's hash and the log", async () => {
    signedIn();
    show();
    expect(await screen.findByText("No single payment over $5,000.")).toBeTruthy();
    expect(screen.getByText("Enforce")).toBeTruthy();
    expect(await screen.findByText("GB29 NWBK 6016 1331 9268 19")).toBeTruthy();
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

  it("says when the wallet has no gate account", async () => {
    vi.mocked(gateApi.accounts).mockResolvedValue({ items: [] });
    signedIn();
    show();
    expect(await screen.findByText("No gate accounts yet")).toBeTruthy();
  });
});
