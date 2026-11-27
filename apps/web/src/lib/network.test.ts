import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { robinhoodTestnet } from "../config";
import { chainLogo } from "./chain-logos";
import { isPhantom, networkNote, useChainName } from "./network";

describe("the network note beside an on-chain action", () => {
  it("says nothing on the testnet or with no wallet", () => {
    expect(networkNote(robinhoodTestnet.id)).toBeNull();
    expect(networkNote(undefined)).toBeNull();
  });

  it("says the wallet will be asked to switch when it is on another network", () => {
    expect(networkNote(1)).toMatch(/ask to switch to Robinhood Chain testnet/);
  });

  it("recognises Phantom, whose failed switches read as refusals", () => {
    expect(isPhantom({ id: "app.phantom", name: "Phantom" })).toBe(true);
    expect(isPhantom({ id: "io.rabby", name: "Rabby Wallet" })).toBe(false);
  });
});

describe("network logos", () => {
  it("has a logo for the testnet and common networks, none for unknown ones", () => {
    expect(chainLogo(robinhoodTestnet.id)).toMatch(/robinhood\.svg$/);
    expect(chainLogo(1)).toMatch(/ethereum\.svg$/);
    expect(chainLogo(8453)).toMatch(/base\.svg$/);
    expect(chainLogo(987654321)).toBeUndefined();
    expect(chainLogo(undefined)).toBeUndefined();
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
