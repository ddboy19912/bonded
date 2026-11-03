import { type Hex, concat, encodeAbiParameters, keccak256 } from "viem";
import { utcDay } from "./payment-mandate.js";
import type { GateReceipt } from "./gate-receipt.js";

/**
 * The payment gate's daily log roots (GateAnchor in contracts/evm): one root per gate account per
 * UTC day over that day's receipts, in decision order. It commits to every receipt, their order
 * and their number, so no receipt can be added, dropped, edited or moved once it is posted.
 *
 * - Each leaf is a receipt's EIP-712 hash (`gateReceiptHash`) hashed twice, so a leaf can never
 *   pass for an inner node.
 * - Each inner node is keccak256(left, right), in order. A level with an odd number of nodes
 *   carries its last node up unchanged.
 * - The root is keccak256(abi.encode(count, tree root)): the count is bound in, but it isn't
 *   public on chain; only a proof's holder learns it.
 *
 * A proof (the receipt's place, the day's count and the siblings, leaf up) checks offline with
 * `verifyGateLogProof` and on chain with `GateAnchor.verifyReceipt`, which run the same steps.
 */

/** A gate account as GateAnchor names it: the 16 bytes of its UUID. */
export function gateAccountKey(accountId: string): Hex {
  const hex = accountId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("a gate account id is a UUID");
  return `0x${hex}`;
}

/** A UTC day (YYYY-MM-DD) as GateAnchor numbers it: days since 1970-01-01. */
export function gateDayNumber(day: string): number {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(ms) || utcDay(new Date(ms)) !== day)
    throw new Error("a day is YYYY-MM-DD");
  return ms / 86_400_000;
}

/** The UTC day a receipt belongs to: the day of its `checkedAt`. */
export const gateReceiptDay = (receipt: Pick<GateReceipt, "checkedAt">): string =>
  utcDay(new Date(receipt.checkedAt * 1000));

const bytes32 = (value: Hex) => encodeAbiParameters([{ type: "bytes32" }], [value]);

/** A receipt hash's leaf: keccak256(keccak256(abi.encode(receiptHash))), as GateAnchor. */
export const gateLogLeaf = (receiptHash: Hex): Hex => keccak256(keccak256(bytes32(receiptHash)));

const node = (left: Hex, right: Hex): Hex => keccak256(concat([left, right]));
const seal = (count: number, treeRoot: Hex): Hex =>
  keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [BigInt(count), treeRoot]),
  );

/** Every level of the tree, leaves first. */
function levels(receiptHashes: readonly Hex[]): Hex[][] {
  if (!receiptHashes.length) throw new Error("a log root needs at least one receipt");
  const out = [receiptHashes.map(gateLogLeaf)];
  while (out.at(-1)!.length > 1) {
    const level = out.at(-1)!;
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(i + 1 < level.length ? node(level[i]!, level[i + 1]!) : level[i]!);
    out.push(next);
  }
  return out;
}

/** The root over a day's receipt hashes, in decision order. Throws on an empty day. */
export const gateLogRoot = (receiptHashes: readonly Hex[]): Hex =>
  seal(receiptHashes.length, levels(receiptHashes).at(-1)![0]!);

/** What proves one receipt is in a day's root. */
export interface GateLogProof {
  /** The receipt's place in the day, from 0, in decision order. */
  index: number;
  /** How many receipts the day has. */
  count: number;
  /** The sibling at each level that has one, leaf up. */
  siblings: Hex[];
}

/** The proof for the receipt at `index` of the day. */
export function gateLogProof(receiptHashes: readonly Hex[], index: number): GateLogProof {
  if (!Number.isInteger(index) || index < 0 || index >= receiptHashes.length)
    throw new Error("no receipt at that index");
  const siblings: Hex[] = [];
  let i = index;
  for (const level of levels(receiptHashes).slice(0, -1)) {
    const sibling = i ^ 1;
    if (sibling < level.length) siblings.push(level[sibling]!);
    i >>= 1;
  }
  return { index, count: receiptHashes.length, siblings };
}

/** Whether a receipt hash is in `root` at the proof's place. Never throws. */
export function verifyGateLogProof(receiptHash: Hex, proof: GateLogProof, root: Hex): boolean {
  try {
    const { index, count, siblings } = proof;
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(index)) return false;
    if (count < 1 || index < 0 || index >= count) return false;
    let hash = gateLogLeaf(receiptHash);
    let i = index;
    let n = count;
    let used = 0;
    while (n > 1) {
      if ((i ^ 1) < n) {
        const sibling = siblings[used++];
        if (sibling === undefined) return false;
        hash = i % 2 === 0 ? node(hash, sibling) : node(sibling, hash);
      }
      i = Math.floor(i / 2);
      n = Math.ceil(n / 2);
    }
    return used === siblings.length && seal(count, hash).toLowerCase() === root.toLowerCase();
  } catch {
    return false;
  }
}
