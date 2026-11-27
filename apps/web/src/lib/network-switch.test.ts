import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserRejectedRequestError } from "viem";

const { account, switchChain } = vi.hoisted(() => ({
  account: { current: {} as Record<string, unknown> },
  switchChain: vi.fn(),
}));
vi.mock("wagmi/actions", () => ({
  getAccount: () => account.current,
  switchChain,
}));

import { robinhoodTestnet } from "../config";
import { ensureTestnet } from "./network";

const rabby = { id: "io.rabby", name: "Rabby Wallet" };
// wagmi wraps a failed "add network" as a refusal, with the wallet's own error underneath.
const wrapped = (inner: Error & { code?: number }) => new UserRejectedRequestError(inner);

beforeEach(() => {
  switchChain.mockReset();
  account.current = { isConnected: true, chainId: 1, connector: rabby };
});

describe("switching before a transaction", () => {
  it("does nothing on the testnet or with no wallet", async () => {
    account.current = { isConnected: true, chainId: robinhoodTestnet.id, connector: rabby };
    await ensureTestnet();
    account.current = { isConnected: false };
    await ensureTestnet();
    expect(switchChain).not.toHaveBeenCalled();
  });

  it("says the switch was declined when the user said no", async () => {
    switchChain.mockRejectedValue(
      wrapped(Object.assign(new Error("User rejected the request."), { code: 4001 })),
    );
    await expect(ensureTestnet()).rejects.toThrow(/The switch was declined, so nothing was sent/);
  });

  it("points to adding the network by hand when the wallet couldn't add it", async () => {
    switchChain.mockRejectedValue(
      wrapped(Object.assign(new Error("Internal error"), { code: -32603 })),
    );
    await expect(ensureTestnet()).rejects.toThrow(
      /couldn't switch to Robinhood Chain testnet\. Add Robinhood Chain testnet by hand/,
    );
  });
});
