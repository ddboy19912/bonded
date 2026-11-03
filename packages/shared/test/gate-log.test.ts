import { generatePrivateKey } from "viem/accounts";
import { keccak256, stringToHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  gateAccountKey,
  gateDayNumber,
  gateLogLeaf,
  gateLogProof,
  gateLogRoot,
  gateReceiptDay,
  gateReceiptHash,
  signGateReceipt,
  verifyGateLogProof,
  type GateReceipt,
} from "../src/index.js";

const hashes = (n: number, tag = "receipt"): Hex[] =>
  Array.from({ length: n }, (_, i) => keccak256(stringToHex(`${tag} ${i}`)));
/** The three receipts GateAnchor.t.sol checks on chain. */
const ABC = ["a", "b", "c"].map((s) => keccak256(stringToHex(`receipt ${s}`)));

describe("gate log roots", () => {
  it("proves every receipt of a day, whatever the day's size", () => {
    for (let n = 1; n <= 17; n++) {
      const day = hashes(n);
      const root = gateLogRoot(day);
      day.forEach((h, i) => {
        const proof = gateLogProof(day, i);
        expect(proof).toMatchObject({ index: i, count: n });
        expect(verifyGateLogProof(h, proof, root)).toBe(true);
      });
    }
  });

  it("has an empty proof for a day of one", () => {
    const [only] = hashes(1);
    expect(gateLogProof([only!], 0).siblings).toEqual([]);
    expect(verifyGateLogProof(only!, gateLogProof([only!], 0), gateLogRoot([only!]))).toBe(true);
  });

  it("fails a receipt that isn't in the day, a wrong proof and a wrong root", () => {
    const day = hashes(6);
    const root = gateLogRoot(day);
    const proof = gateLogProof(day, 2);
    const stranger = keccak256(stringToHex("a receipt from another day"));
    expect(verifyGateLogProof(stranger, proof, root)).toBe(false);
    // A real receipt with another receipt's proof, or at another place.
    expect(verifyGateLogProof(day[3]!, proof, root)).toBe(false);
    expect(verifyGateLogProof(day[2]!, { ...proof, index: 3 }, root)).toBe(false);
    // The wrong count, or a changed, missing or extra sibling.
    expect(verifyGateLogProof(day[2]!, { ...proof, count: 7 }, root)).toBe(false);
    const [first, ...rest] = proof.siblings;
    expect(verifyGateLogProof(day[2]!, { ...proof, siblings: [stranger, ...rest] }, root)).toBe(
      false,
    );
    expect(verifyGateLogProof(day[2]!, { ...proof, siblings: rest }, root)).toBe(false);
    expect(
      verifyGateLogProof(day[2]!, { ...proof, siblings: [...proof.siblings, first!] }, root),
    ).toBe(false);
    expect(verifyGateLogProof(day[2]!, proof, gateLogRoot(hashes(5)))).toBe(false);
    // An inner node can't pass for a receipt.
    expect(verifyGateLogProof(first!, { index: 1, count: 3, siblings: rest }, root)).toBe(false);
    // Junk never throws.
    expect(verifyGateLogProof("0x1234", proof, root)).toBe(false);
    expect(verifyGateLogProof(day[2]!, { index: 0, count: 0, siblings: [] }, root)).toBe(false);
  });

  it("commits to the order, the count and every receipt", () => {
    const day = hashes(4);
    const root = gateLogRoot(day);
    expect(gateLogRoot([day[1]!, day[0]!, day[2]!, day[3]!])).not.toBe(root);
    expect(gateLogRoot(day.slice(0, 3))).not.toBe(root);
    expect(gateLogRoot([...day, day[3]!])).not.toBe(root);
    expect(gateLogRoot([...day])).toBe(root);
  });

  it("matches the tree GateAnchor checks on chain", () => {
    // The same receipts and root as test_VerifiesAReceiptInThePostedRoot in GateAnchor.t.sol.
    expect(gateLogRoot(ABC)).toBe(
      "0x95bb38e2b18256453824ab978b374e9660ccba0d7f130a959ffd7cbb17b31326",
    );
    expect(gateLogProof(ABC, 0).siblings).toEqual([gateLogLeaf(ABC[1]!), gateLogLeaf(ABC[2]!)]);
    expect(gateLogProof(ABC, 2).siblings).toHaveLength(1);
  });

  it("refuses an empty day and an index outside it", () => {
    expect(() => gateLogRoot([])).toThrow();
    expect(() => gateLogProof(hashes(3), 3)).toThrow();
    expect(() => gateLogProof(hashes(3), -1)).toThrow();
  });

  it("takes a signed receipt's hash as its leaf", async () => {
    const receipt: GateReceipt = {
      decisionId: "6f1c2b9e-1d2a-4c3b-9a8e-0f1e2d3c4b5a",
      gateAccountId: "0b5e7c1a-2f3d-4e5f-8a9b-1c2d3e4f5a6b",
      kind: "invoice",
      decision: "pass",
      result: "allowed",
      mode: "enforce",
      rules: [],
      amountCents: 61_240,
      payee: "GB29NWBK60161331926819",
      reference: "NIM-1",
      inputHash: `0x${"11".repeat(32)}`,
      mandateHash: `0x${"22".repeat(32)}`,
      mandateVersion: 1,
      checkedAt: Date.parse("2026-11-02T23:59:59Z") / 1000,
    };
    const signed = await signGateReceipt(receipt, generatePrivateKey());
    const day = [gateReceiptHash(signed.receipt), ...hashes(2)];
    const root = gateLogRoot(day);
    expect(verifyGateLogProof(day[0]!, gateLogProof(day, 0), root)).toBe(true);
    // Any edit to the receipt changes its hash, so it falls out of the root.
    const edited = gateReceiptHash({ ...receipt, amountCents: 61_241 });
    expect(verifyGateLogProof(edited, gateLogProof(day, 0), root)).toBe(false);
    expect(gateReceiptDay(receipt)).toBe("2026-11-02");
  });
});

describe("GateAnchor's names for accounts and days", () => {
  it("names an account by its UUID's 16 bytes", () => {
    expect(gateAccountKey("0B5E7C1A-2F3D-4E5F-8A9B-1C2D3E4F5A6B")).toBe(
      "0x0b5e7c1a2f3d4e5f8a9b1c2d3e4f5a6b",
    );
    expect(() => gateAccountKey("acct-1")).toThrow();
  });
  it("numbers a day from 1970", () => {
    expect(gateDayNumber("1970-01-01")).toBe(0);
    expect(gateDayNumber("2026-11-02")).toBe(20_759);
    expect(() => gateDayNumber("2026-02-30")).toThrow();
    expect(() => gateDayNumber("2026-11-2")).toThrow();
  });
});
