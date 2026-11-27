import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { robinhoodTestnet } from "../config";
import { isPhantom, networkNote, useChainName } from "./network";

describe("the network note beside an on-chain action", () => {
  it("says nothing on the testnet or with no wallet", () => {
    expect(networkNote(robinhoodTestnet.id, { name: "Rabby Wallet" })).toBeNull();
    expect(networkNote(undefined, null)).toBeNull();
  });

  it("says the wallet will be asked to switch when it is on another network", () => {
    expect(networkNote(1, { id: "io.rabby", name: "Rabby Wallet" })).toMatch(
      /ask to switch to Robinhood Chain testnet/,
    );
  });

  it("tells a Phantom user to use another wallet, since Phantom can't add the testnet", () => {
    expect(isPhantom({ id: "app.phantom", name: "Phantom" })).toBe(true);
    expect(networkNote(1, { id: "app.phantom", name: "Phantom" })).toMatch(
      /Phantom can't use Robinhood Chain testnet\. Connect Rabby or MetaMask/,
    );
  });
});

describe("the wallet's network by name", () => {
  it("names the testnet, known networks, and unknown ones by id", async () => {
    expect(renderHook(() => useChainName(undefined)).result.current).toBeUndefined();
    expect(renderHook(() => useChainName(robinhoodTestnet.id)).result.current).toBe(
      robinhoodTestnet.name,
    );
    const base = renderHook(() => useChainName(8453));
    await waitFor(() => expect(base.result.current).toBe("Base"));
    expect(renderHook(() => useChainName(987654321)).result.current).toBe("Chain 987654321");
  });
});
