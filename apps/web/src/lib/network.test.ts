import { describe, expect, it } from "vitest";
import { robinhoodTestnet } from "../config";
import { isPhantom, networkNote } from "./network";

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
