import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  type Abi,
  type AbiEvent,
  type Hex,
} from "viem";
import { bondedRegistryAbi, mandateVaultFactoryAbi, suggestMandate } from "@bondedhq/shared";
import type { OfficialPrefill } from "../components/preview-report";
import { deployment } from "../config";
import { byoaApi } from "../lib/byoa-api";
import { saveSession } from "../lib/connect";
import { iso } from "../test/byoa-fixtures";
import { NewAgent } from "./NewAgent";

const chain = vi.hoisted(() => ({
  capabilities: {} as unknown,
  sendCalls: [] as unknown[],
  receipts: [] as unknown[][],
  writes: 0,
  /** Each one-by-one transaction, in order: its function and arguments. */
  written: [] as { functionName: string; args: unknown[] }[],
  /** The receipt logs of the nth one-by-one transaction (1-based). */
  txLogs: {} as Record<number, unknown[]>,
  /** Which one-by-one prompts (1-based) the user turns down. */
  rejectWrites: [] as number[],
  /** Batch ids waited on, and how many waits time out first. */
  waits: [] as string[],
  waitTimeouts: 0,
  /** Errors the next waits throw, in order (e.g. EIP-5792's unknown batch). */
  waitErrors: [] as unknown[],
  /** The chain's client, when a test needs one: its block and the logs it finds. */
  client: undefined as unknown,
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: "0x00000000000000000000000000000000000000a1",
    isConnected: true,
    chainId: 46630,
  }),
  useSignMessage: () => ({ signMessageAsync: async () => "0x5151" }),
  useWriteContract: () => ({
    writeContractAsync: async (call: { functionName: string; args: unknown[] }) => {
      chain.writes++;
      if (chain.rejectWrites.includes(chain.writes))
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      chain.written.push({ functionName: call.functionName, args: call.args });
      return `0x${chain.writes.toString(16)}`;
    },
  }),
  useBalance: () => ({ data: undefined }),
}));
vi.mock("wagmi/actions", () => ({
  getCapabilities: async () => chain.capabilities,
  getGasPrice: async () => 1n,
  sendCalls: async (_: unknown, args: unknown) => {
    chain.sendCalls.push(args);
    return { id: `batch-${chain.sendCalls.length}` };
  },
  waitForCallsStatus: async (_: unknown, { id }: { id: string }) => {
    chain.waits.push(id);
    if (chain.waitErrors.length) throw chain.waitErrors.shift();
    if (chain.waitTimeouts > 0) {
      chain.waitTimeouts--;
      throw new Error("Timed out while waiting for call bundle.");
    }
    return {
      status: "success",
      receipts: [
        { logs: chain.receipts[Number(id.split("-")[1]) - 1] ?? [], transactionHash: "0xab" },
      ],
    };
  },
  getPublicClient: () => chain.client,
  readContract: async () => undefined,
  waitForTransactionReceipt: async (_: unknown, { hash }: { hash: string }) => ({
    status: "success",
    logs: chain.txLogs[Number(hash)] ?? [],
  }),
}));
vi.mock("../wagmi", () => ({ wagmiConfig: {} }));
vi.mock("../lib/self-serve", async (load) => ({
  ...(await load<typeof import("../lib/self-serve")>()),
  registerForRatings: vi.fn(async () => ({})),
}));

/** A log of `eventName`, as a receipt carries it. */
function log(abi: Abi, eventName: string, args: Record<string, unknown>, address: string) {
  const event = getAbiItem({ abi, name: eventName }) as AbiEvent;
  const indexed = Object.fromEntries(
    event.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]]),
  );
  const rest = event.inputs.filter((i) => !i.indexed);
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args: indexed } as never),
    data: encodeAbiParameters(
      rest,
      rest.map((i) => args[i.name!]),
    ),
    blockNumber: 1n,
    transactionHash: "0xab",
    logIndex: 0,
    blockHash: "0x01",
    transactionIndex: 0,
    removed: false,
  };
}

const WALLET = "0x00000000000000000000000000000000000000a1";
const VAULT = "0x00000000000000000000000000000000000000f1";
const registered = (agentId = 77n) =>
  log(
    bondedRegistryAbi as Abi,
    "Registered",
    { agentId, agentURI: "x", owner: WALLET },
    deployment.registry,
  );
const vaultCreated = (agentId = 77n) =>
  log(
    mandateVaultFactoryAbi as Abi,
    "VaultCreated",
    { vault: VAULT, agentId, guardian: WALLET, agent: WALLET, mandateHash: `0x${"1".repeat(64)}` },
    deployment.factory,
  );
const stored = () =>
  JSON.parse(
    localStorage.getItem(`bonded:onboarding:${deployment.chainId}:${WALLET}`) ?? "null",
  ) as {
    agentId?: string;
    vault?: string;
    done: string[];
    batch?: { id: string; calls: string[] };
  } | null;

// The limits and the bond help are edited in dialogs, which ask the screen's width.
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});
/** The mandate's limits and details open in a dialog; "Done" closes it again. */
const openLimits = () =>
  fireEvent.click(screen.getByRole("button", { name: "Edit limits and details" }));
const closeLimits = () => fireEvent.click(screen.getByRole("button", { name: "Done" }));

function show(prefill?: OfficialPrefill) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter
      initialEntries={[
        prefill
          ? { pathname: "/agents/new", search: `?preview=${prefill.previewId}`, state: { prefill } }
          : "/agents/new",
      ]}
    >
      <QueryClientProvider client={client}>
        <NewAgent />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  chain.capabilities = {};
  chain.sendCalls = [];
  chain.receipts = [];
  chain.writes = 0;
  chain.written = [];
  chain.txLogs = {};
  chain.rejectWrites = [];
  chain.waits = [];
  chain.waitTimeouts = 0;
  chain.waitErrors = [];
  chain.client = undefined;
});

describe("Onboarding your own agent", () => {
  it("offers the two ways to connect, with the code hash optional under Advanced", () => {
    show();
    fireEvent.click(screen.getByRole("radio", { name: /My own agent/ }));
    expect(screen.getByRole("link", { name: "Test your agent first" }).getAttribute("href")).toBe(
      "/agents/test",
    );
    expect(screen.getByRole("radio", { name: /It's online at a URL/ })).toHaveProperty(
      "checked",
      true,
    );
    // URL mode needs a URL, and says so in the list of what's missing.
    expect(screen.getByText("Paste your agent's URL.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your agent's URL"), {
      target: { value: "https://agent.example/bonded" },
    });
    expect(screen.queryByText("Paste your agent's URL.")).toBeNull();
    // No code hash needed: it fills itself in.
    expect(screen.queryByText("Enter your agent's code hash.")).toBeNull();
    const advanced = screen.getByRole("button", { name: "Advanced (optional)" });
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByLabelText("Code hash").getAttribute("placeholder")).toBe(
      "Filled in automatically",
    );
    fireEvent.change(screen.getByLabelText("Code hash"), { target: { value: "0x12" } });
    expect(screen.getAllByText(/A code hash is 0x and 64 hex digits/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Then you connect it and check the connection, here/)).toBeTruthy();
  });

  it("with the runner, needs no URL and says the command comes right after", () => {
    show();
    fireEvent.click(screen.getByRole("radio", { name: /My own agent/ }));
    fireEvent.click(screen.getByRole("radio", { name: /On my computer or server/ }));
    expect(screen.queryByLabelText("Your agent's URL")).toBeNull();
    expect(screen.getByText(/Right after onboarding you get the runner's command/)).toBeTruthy();
  });

  it("fills itself in from a preview when made official", () => {
    show({
      previewId: "p1",
      mode: "chain",
      connection: "runner",
      agentUrl: null,
      codeHash: { value: `0x${"b".repeat(64)}`, source: "declared" },
    });
    expect(screen.getByText("Filled in from your preview")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /My own agent/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: /On my computer or server/ })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("radio", { name: /^Chain/ })).toHaveProperty("checked", true);
    expect(
      screen.getByRole("button", { name: "Advanced (optional)" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect((screen.getByLabelText("Code hash") as HTMLInputElement).value).toBe(
      `0x${"b".repeat(64)}`,
    );
  });

  it("carries an Agent URL over, and shows where an automatic code hash came from", () => {
    show({
      previewId: "p2",
      mode: "tools",
      connection: "url",
      agentUrl: "https://agent.example/bonded",
      codeHash: { value: `0x${"c".repeat(64)}`, source: "url", detail: "v1.4.2" },
    });
    expect((screen.getByLabelText("Your agent's URL") as HTMLInputElement).value).toBe(
      "https://agent.example/bonded",
    );
    expect((screen.getByLabelText("Code hash") as HTMLInputElement).value).toBe("");
    expect(
      screen.getByText(/In your preview it came from the version your agent reported \(v1.4.2\)/),
    ).toBeTruthy();
  });
});

describe("Onboarding, the wallet side", () => {
  it("counts one confirmation per transaction for a wallet that can't batch", async () => {
    show();
    expect(await screen.findByText(/^7 wallet confirmations, then one signature/)).toBeTruthy();
  });

  it("counts one per batch for a wallet that batches, and sends three batches", async () => {
    chain.capabilities = { 46630: { atomic: { status: "supported" } } };
    const vault = "0x00000000000000000000000000000000000000f1";
    chain.receipts = [
      [
        log(
          bondedRegistryAbi as Abi,
          "Registered",
          { agentId: 77n, agentURI: "x", owner: "0x00000000000000000000000000000000000000a1" },
          deployment.registry,
        ),
      ],
      [
        log(
          mandateVaultFactoryAbi as Abi,
          "VaultCreated",
          {
            vault,
            agentId: 77n,
            guardian: "0x00000000000000000000000000000000000000a1",
            agent: "0x00000000000000000000000000000000000000a1",
            mandateHash: `0x${"1".repeat(64)}`,
          },
          deployment.factory,
        ),
      ],
    ];
    show();
    expect(
      await screen.findByText(
        /^3 wallet confirmations \(your wallet sends them in batches, instead of 7\)/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Onboard the agent" }));
    await waitFor(() => expect(screen.getByText("Agent 77 is set up.")).toBeTruthy());
    expect(chain.sendCalls).toHaveLength(3);
    expect(chain.writes).toBe(0);
    const counts = (chain.sendCalls as { calls: unknown[]; forceAtomic: boolean }[]).map((c) => [
      c.calls.length,
      c.forceAtomic,
    ]);
    expect(counts).toEqual([
      [3, true],
      [2, true],
      [2, true],
    ]);
    // The deposit's batch goes to the vault the receipt named, not a guess.
    const last = (chain.sendCalls[2] as { calls: { to: string }[] }).calls;
    expect(last[1]!.to).toBe(vault);
  });

  it("saves a batch's id before waiting, and after a timeout follows that batch instead of sending it again", async () => {
    chain.capabilities = { 46630: { atomic: { status: "supported" } } };
    chain.receipts = [[registered()], [vaultCreated()]];
    chain.waitTimeouts = 1;
    show();
    // The wallet's batching is known before onboarding starts.
    await screen.findByText(/^3 wallet confirmations/);
    fireEvent.click(await screen.findByRole("button", { name: "Onboard the agent" }));
    await screen.findByRole("button", { name: "Resume onboarding" });
    expect(screen.getByText(/Resume to keep following the same batch/)).toBeTruthy();
    expect(screen.getByText(/with a batch your wallet was sent still to confirm/)).toBeTruthy();
    expect(chain.sendCalls).toHaveLength(1);
    expect(stored()).toMatchObject({
      done: [],
      batch: { id: "batch-1", calls: ["register", "faucet", "approveBond"] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume onboarding" }));
    await waitFor(() => expect(screen.getByText("Agent 77 is set up.")).toBeTruthy());
    // batch-1 was followed again, not re-sent: three batches in all, as without the timeout.
    expect(chain.waits).toEqual(["batch-1", "batch-1", "batch-2", "batch-3"]);
    expect(chain.sendCalls).toHaveLength(3);
    expect(stored()).toBeNull();
  });

  describe("a batch the wallet no longer knows (EIP-5792 code 5730)", () => {
    const unknownBatch = Object.assign(new Error("Unknown bundle id"), { code: 5730 });
    const withChain = (logs: unknown[]) => {
      const getLogs = vi.fn(async () => logs);
      chain.client = { getBlockNumber: async () => 100n, getLogs };
      return getLogs;
    };
    async function start() {
      chain.capabilities = { 46630: { atomic: { status: "supported" } } };
      chain.waitErrors = [unknownBatch];
      show();
      await screen.findByText(/^3 wallet confirmations/);
      fireEvent.click(screen.getByRole("button", { name: "Onboard the agent" }));
    }

    it("finds its effects on chain and settles it as confirmed, without sending it again", async () => {
      chain.receipts = [[], [vaultCreated()]];
      // The agent this wallet registered after the batch was sent: the batch went through.
      const getLogs = withChain([registered()]);
      await start();
      await waitFor(() => expect(screen.getByText("Agent 77 is set up.")).toBeTruthy());
      expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 100n }));
      expect(chain.sendCalls).toHaveLength(3);
      expect(chain.waits).toEqual(["batch-1", "batch-2", "batch-3"]);
      expect(stored()).toBeNull();
    });

    it("with nothing from it on chain, keeps it and only sends it again when asked", async () => {
      chain.receipts = [[], [registered()], [vaultCreated()]];
      withChain([]);
      await start();
      expect(
        await screen.findByText(
          /Your wallet doesn't know this batch and nothing from it reached the chain/,
        ),
      ).toBeTruthy();
      // Saved still, and never sent again on its own.
      expect(stored()).toMatchObject({
        done: [],
        batch: { id: "batch-1", calls: ["register", "faucet", "approveBond"], fromBlock: "100" },
      });
      expect(chain.sendCalls).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Resume onboarding" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Send it again" }));
      await waitFor(() => expect(screen.getByText("Agent 77 is set up.")).toBeTruthy());
      // The first group once more (batch-2), then the other two.
      expect(chain.sendCalls).toHaveLength(4);
      expect((chain.sendCalls[1] as { calls: unknown[] }).calls).toHaveLength(3);
      expect(stored()).toBeNull();
    });
  });

  describe("one by one, each confirmed transaction is saved before the next prompt", () => {
    // Without batching the order is: register, faucet, approve bond, create vault, stake,
    // approve deposit, deposit.
    it("keeps agent 77 when the prompt after register is turned down, and resumes without registering again", async () => {
      chain.txLogs = { 1: [registered()] };
      chain.rejectWrites = [2];
      show();
      fireEvent.click(await screen.findByRole("button", { name: "Onboard the agent" }));
      await screen.findByRole("button", { name: "Resume onboarding" });
      expect(stored()).toMatchObject({ agentId: "77", done: ["register"] });
      expect(chain.written.map((w) => w.functionName)).toEqual(["register"]);
      chain.txLogs = { 5: [vaultCreated()] };
      fireEvent.click(screen.getByRole("button", { name: "Resume onboarding" }));
      await waitFor(() => expect(screen.getByText("Agent 77 is set up.")).toBeTruthy());
      const names = chain.written.map((w) => w.functionName);
      expect(names.filter((n) => n === "register")).toHaveLength(1);
      expect(names.slice(1)).toEqual([
        "faucet",
        "approve",
        "createVault",
        "stake",
        "approve",
        "deposit",
      ]);
      // The vault is created for the agent the first prompt registered.
      expect(chain.written.find((w) => w.functionName === "createVault")!.args[3]).toBe(77n);
      expect(stored()).toBeNull();
    });

    it("keeps the vault when staking is turned down after it was created, and resumes without a second vault", async () => {
      chain.txLogs = { 1: [registered()], 4: [vaultCreated()] };
      chain.rejectWrites = [5];
      show();
      fireEvent.click(await screen.findByRole("button", { name: "Onboard the agent" }));
      await screen.findByRole("button", { name: "Resume onboarding" });
      expect(stored()).toMatchObject({
        agentId: "77",
        vault: VAULT,
        done: ["register", "faucet", "vault"],
      });
      fireEvent.click(screen.getByRole("button", { name: "Resume onboarding" }));
      await waitFor(() => expect(screen.getByText("Agent 77 is set up.")).toBeTruthy());
      const names = chain.written.map((w) => w.functionName);
      expect(names.filter((n) => n === "createVault")).toHaveLength(1);
      expect(names.filter((n) => n === "register")).toHaveLength(1);
      // After the resume: the bond again (its approval is re-sent), then the deposit, to that vault.
      expect(names.slice(4)).toEqual(["approve", "stake", "approve", "deposit"]);
      expect(chain.written.at(-2)!.args[0]).toBe(VAULT);
    });
  });

  it("explains the bond and recommends one for the cover wanted", () => {
    show();
    // The help is a dialog, opened from the funds step, and gives its answer back to the bond field.
    fireEvent.click(screen.getByRole("button", { name: "Help me size the bond" }));
    expect(screen.getByText(/the bond pays first, then the cover pool/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cover you want"), { target: { value: "20000" } });
    expect(screen.getByText("BBB to AAA (10% of the cover)")).toBeTruthy();
    expect(screen.getByText(/without a score yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use this bond" }));
    expect(screen.queryByText("BBB to AAA (10% of the cover)")).toBeNull();
    expect((screen.getByLabelText(/Operator bond/) as HTMLInputElement).value).toBe("6000");
  });

  it("says on the card when a limit in the dialog is wrong, and stops onboarding", () => {
    show();
    expect(screen.queryByText(/Needs a fix:/)).toBeNull();
    openLimits();
    fireEvent.change(screen.getByLabelText("Per-trade limit"), { target: { value: "abc" } });
    closeLimits();
    // The dialog is closed, so the problem has to show on the page itself.
    expect(screen.getByText(/Needs a fix:/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Onboard the agent" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it.each(["Maximum slippage", "Maximum drawdown"])(
    "stops onboarding when %s is cleared, since a blank percentage must not become 0",
    (field) => {
      show();
      const onboard = () =>
        screen.getByRole("button", { name: "Onboard the agent" }) as HTMLButtonElement;
      expect(onboard().disabled).toBe(false);
      openLimits();
      fireEvent.change(screen.getByLabelText(new RegExp(`^${field}`)), { target: { value: "" } });
      closeLimits();
      expect(
        screen.getByText(new RegExp(`Needs a fix: ${field}: Enter a percentage`)),
      ).toBeTruthy();
      expect(onboard().disabled).toBe(true);
      // The same problem is listed once beside the button, naming the field.
      expect(screen.getAllByText(new RegExp(`${field}: Enter a percentage`))).toHaveLength(2);
      // Fixing it lets the owner go on.
      openLimits();
      fireEvent.change(screen.getByLabelText(new RegExp(`^${field}`)), { target: { value: "2" } });
      closeLimits();
      expect(screen.queryByText(/Needs a fix:/)).toBeNull();
      expect(onboard().disabled).toBe(false);
    },
  );

  it("prefills the mandate from the preview's suggestion, with presets", async () => {
    saveSession(deployment.chainId, {
      session: "sess",
      wallet: "0x00000000000000000000000000000000000000a1",
      expiresAt: iso(3_600_000),
    });
    const suggest = vi.spyOn(byoaApi, "suggestedMandate").mockResolvedValue({
      tokens: ["tTSLA"],
      contracts: [{ address: deployment.router, label: "the test exchange" }],
      largestTradeUsd: 900,
      basis: {
        sources: ["check", "preview"],
        trades: 3,
        tokens: ["tTSLA"],
        largestTradeUsd: 900,
        usedRouter: true,
        transfers: 0,
        approvals: 1,
      },
      notes: ["Add your refund address: the agent made no transfers."],
      recommended: "active",
      presets: [
        {
          id: "conservative",
          label: "Conservative trader",
          line: "Enforce, the tokens it used.",
          mode: "enforce",
          tokens: ["tTSLA"],
          maxTxUsd: 1200,
          maxDailyUsd: 4000,
          rules: { assets: [deployment.tsla] },
        },
        {
          id: "active",
          label: "Active trader",
          line: "Enforce, more headroom.",
          mode: "enforce",
          tokens: ["tTSLA", "tNVDA"],
          maxTxUsd: 3000,
          maxDailyUsd: 15000,
          rules: { assets: [deployment.tsla, deployment.nvda] },
        },
      ],
    });
    show({ previewId: "p1", mode: "tools", connection: "url", agentUrl: null, codeHash: null });
    expect(
      await screen.findByText(/its largest trade was 900 USD, through the test exchange/),
    ).toBeTruthy();
    expect(suggest).toHaveBeenCalledWith({ kind: "preview", id: "p1" }, "sess");
    expect(
      screen.getByText(/From your passing check and your preview \(3 trades\): it traded tTSLA/),
    ).toBeTruthy();
    expect(screen.getByText(/Add your refund address/)).toBeTruthy();
    // The API's recommended preset is picked first.
    expect(screen.getByRole("radio", { name: /^Active trader/ })).toHaveProperty("checked", true);
    // The card says the limits in a line; the fields are in the dialog.
    expect(screen.getByText(/3000 USD a trade · 15000 USD a day/)).toBeTruthy();
    openLimits();
    expect((screen.getByLabelText("Daily limit") as HTMLInputElement).value).toBe("15000");
    closeLimits();
    fireEvent.click(screen.getByRole("radio", { name: /^Conservative trader/ }));
    openLimits();
    expect((screen.getByLabelText("Per-trade limit") as HTMLInputElement).value).toBe("1200");
    fireEvent.change(screen.getByLabelText("Per-trade limit"), { target: { value: "2000" } });
    closeLimits();
    expect(screen.getByRole("radio", { name: /^Custom/ })).toHaveProperty("checked", true);
  });
});

describe("a mandate preset is the mandate that is submitted", () => {
  // The suggestion exactly as the API builds it (Conservative: no destinations, 1% slippage,
  // 10% drawdown), for an agent seen trading tTSLA up to 900 USD.
  const suggestion = () =>
    suggestMandate({
      chainId: deployment.chainId,
      market: {
        usdg: deployment.usdg,
        router: deployment.router,
        tokens: { tTSLA: deployment.tsla, tAMZN: deployment.amzn, tNVDA: deployment.nvda },
      },
      trading: {
        trades: 3,
        tokens: ["tTSLA", "tUSDG"],
        usedRouter: true,
        transfers: 0,
        approvals: 0,
        largestTradeUsd: 900,
        totalOutflowUsd: 2_000,
      },
      sources: ["preview"],
    });
  /** The params of the createVault call the wallet was actually sent, decoded. */
  const createVaultParams = () => {
    const call = (chain.sendCalls[1] as { calls: { data: Hex }[] }).calls[0]!;
    const decoded = decodeFunctionData({ abi: mandateVaultFactoryAbi as Abi, data: call.data });
    expect(decoded.functionName).toBe("createVault");
    return (decoded.args as unknown[])[0] as {
      mode: number;
      assets: string[];
      targets: string[];
      destinations: string[];
      maxTxNotionalUsd6: bigint;
      maxDailyNotionalUsd6: bigint;
      maxDrawdownBps: number;
      maxSlippageBps: number;
    };
  };
  async function onboardFromPreset(edit?: () => void) {
    chain.capabilities = { 46630: { atomic: { status: "supported" } } };
    chain.receipts = [[registered()], [vaultCreated()]];
    saveSession(deployment.chainId, {
      session: "sess",
      wallet: WALLET,
      expiresAt: iso(3_600_000),
    });
    vi.spyOn(byoaApi, "suggestedMandate").mockResolvedValue(suggestion());
    show({
      previewId: "p1",
      mode: "tools",
      connection: "url",
      agentUrl: "https://agent.example/bonded",
      codeHash: null,
    });
    await screen.findByText(/^3 wallet confirmations/);
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: /^Conservative trader/ })).toHaveProperty(
        "checked",
        true,
      ),
    );
    edit?.();
    fireEvent.click(screen.getByRole("button", { name: "Onboard the agent" }));
    await waitFor(() => expect(chain.sendCalls.length).toBeGreaterThanOrEqual(2));
    return createVaultParams();
  }

  it("Conservative: its destinations, slippage and drawdown, not the form's defaults", async () => {
    const params = await onboardFromPreset();
    openLimits();
    expect((screen.getByLabelText(/^Maximum slippage/) as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText(/^Maximum drawdown/) as HTMLInputElement).value).toBe("10");
    expect(params.destinations).toEqual([]);
    expect(params.maxSlippageBps).toBe(100);
    expect(params.maxDrawdownBps).toBe(1000);
    expect(params.mode).toBe(1);
    expect(params.assets.map((a) => a.toLowerCase())).toEqual(
      [deployment.usdg, deployment.tsla].map((a) => a.toLowerCase()),
    );
    expect(params.targets.map((a) => a.toLowerCase())).toEqual([deployment.router.toLowerCase()]);
    // 900 USD with 1.25x headroom, rounded up to a hundred; four times that a day.
    expect(params.maxTxNotionalUsd6).toBe(1_200n * 1_000_000n);
    expect(params.maxDailyNotionalUsd6).toBe(4_800n * 1_000_000n);
  });

  it("an edit makes it Custom, marks the field, and changes only that rule", async () => {
    const params = await onboardFromPreset(() => {
      openLimits();
      fireEvent.change(screen.getByLabelText(/^Maximum slippage/), { target: { value: "2" } });
      expect(screen.getByLabelText("Maximum slippage(edited)")).toBeTruthy();
      closeLimits();
      expect(screen.getByRole("radio", { name: /^Custom/ })).toHaveProperty("checked", true);
      expect(screen.getByText("Conservative trader, edited: maximum slippage.")).toBeTruthy();
    });
    expect(params.maxSlippageBps).toBe(200);
    // The rest is still the preset's.
    expect(params.maxDrawdownBps).toBe(1000);
    expect(params.destinations).toEqual([]);
    expect(params.maxTxNotionalUsd6).toBe(1_200n * 1_000_000n);
  });
});
