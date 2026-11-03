import { GateStore, type Database, type GateMandateSnapshot } from "@bonded/db";
import {
  gateAccountKey,
  gateAnchorAbi,
  gateDayNumber,
  gateLogRoot,
  gateMandateHash,
  gateReceiptHash,
  type EvmDeployment,
  type SignedGateReceipt,
} from "@bondedhq/shared";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { connectChain, type ServiceChain } from "./chain.js";

const DAY_MS = 86_400_000;
const ZERO = `0x${"0".repeat(64)}`;

/** GateAnchor already holds a different hash for this: never overwritten, left to the operator. */
class HashConflict extends Error {
  constructor() {
    super("a different hash is already posted on chain for this");
  }
}

/** Where the payment gate's hashes are posted: GateAnchor, sent from the poster's key. */
export interface GateAnchorTarget {
  chain: ServiceChain;
  address: Address;
}

/**
 * GateAnchor at `address`, posting from `key`. It may be on another chain than the protocol's
 * deployment, so the chain id is read from the RPC; an address without code stops here.
 */
export async function connectGateAnchor(
  deployment: EvmDeployment,
  rpcUrl: string,
  key: Hex,
  address: Address,
): Promise<GateAnchorTarget> {
  const read = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await read.getChainId();
  if (!(await read.getCode({ address }))) throw new Error("no contract at GATE_ANCHOR_ADDRESS");
  return { chain: connectChain({ ...deployment, chainId }, rpcUrl, key), address };
}

export interface GateAnchorOptions {
  now?: () => number;
  /**
   * How long after a UTC day ends before its root is made (default 10 minutes), so a check that
   * started just before midnight has been written.
   */
  graceMs?: number;
  /** How many finished days back to look for days without a root (default 7). */
  lookbackDays?: number;
  /** Most mandate versions and roots posted per tick, each (default 50). */
  batch?: number;
}

/**
 * The payment gate's transparency job (apps/api/GATE.md, "Hashes on chain"). Each tick it makes
 * the log root (`gateLogRoot`) of every finished UTC day that has decisions and no root, and
 * stores it. With a target, it then posts what isn't on chain yet: every mandate version's hash
 * and every day's root, to GateAnchor. Without one it only makes and stores the roots.
 *
 * Posting is safe to repeat: GateAnchor refuses to overwrite, so the job reads first, and a hash
 * already there (a send whose outcome was unknown) is recorded as posted. A different hash already
 * there is never overwritten: it is recorded as an error for the operator.
 */
export class GateAnchorJob {
  readonly store: GateStore;
  private readonly now: () => number;
  constructor(
    readonly db: Database,
    readonly target?: GateAnchorTarget,
    readonly options: GateAnchorOptions = {},
  ) {
    this.store = new GateStore(db, gateMandateHash);
    this.now = options.now ?? Date.now;
  }

  /** One pass, under a lock so two keepers never post the same hash. */
  async tick(): Promise<{ sealed: number; posted: number; failed: number }> {
    const c = await this.db.pool.connect();
    let locked = false;
    try {
      locked = (await c.query("SELECT pg_try_advisory_lock(7026, 0) AS locked")).rows[0].locked;
      if (!locked) return { sealed: 0, posted: 0, failed: 0 };
      const sealed = await this.seal();
      const { posted, failed } = this.target
        ? await this.post(this.target)
        : { posted: 0, failed: 0 };
      return { sealed, posted, failed };
    } finally {
      if (locked) await c.query("SELECT pg_advisory_unlock(7026, 0)");
      c.release();
    }
  }

  /** Make and store the root of each finished day with decisions and no root yet. */
  async seal(): Promise<number> {
    const grace = this.options.graceMs ?? 10 * 60_000;
    // The start of the latest day that ended at least `grace` ago (the day after it, at 00:00).
    const until = Math.floor((this.now() - grace) / DAY_MS) * DAY_MS;
    const since = until - (this.options.lookbackDays ?? 7) * DAY_MS;
    let sealed = 0;
    for (const { accountId, day } of await this.store.daysWithoutRoot(
      new Date(since),
      new Date(until),
    )) {
      const decisions = await this.store.dayDecisions(accountId, day);
      if (!decisions.length) continue;
      const hashes = decisions.map((d) =>
        gateReceiptHash((d.receipt as SignedGateReceipt).receipt),
      );
      if (
        await this.store.addLogRoot({
          accountId,
          day,
          root: gateLogRoot(hashes),
          receipts: hashes.length,
        })
      )
        sealed++;
    }
    return sealed;
  }

  /** Post every mandate hash and day root not on chain yet. */
  async post(target: GateAnchorTarget): Promise<{ posted: number; failed: number }> {
    const { chain, address } = target;
    const batch = this.options.batch ?? 50;
    const where = { chainId: chain.deployment.chainId, contract: address };
    let posted = 0;
    let failed = 0;
    const one = async (
      accountId: string,
      which: { version: number } | { day: string },
      hash: Hex,
      read: () => Promise<{ hash: Hex }>,
      send: () => Promise<Hex>,
    ) => {
      try {
        const onChain = (await read()).hash;
        if (onChain !== ZERO) {
          if (onChain.toLowerCase() !== hash.toLowerCase()) throw new HashConflict();
          await this.store.markPosted(accountId, which, { ...where, txHash: null });
        } else {
          await this.store.markPosted(accountId, which, { ...where, txHash: await send() });
        }
        posted++;
      } catch (error) {
        failed++;
        await this.store.postFailed(accountId, which, postError(error));
      }
    };

    for (const m of await this.store.unpostedMandates(batch)) {
      const account = gateAccountKey(m.accountId);
      const version = BigInt(m.version);
      const hash = m.hash as Hex;
      // The hash is recomputed from the stored mandate: one that doesn't match is never posted.
      if (gateMandateHash(m.mandate as GateMandateSnapshot) !== hash) {
        failed++;
        await this.store.postFailed(
          m.accountId,
          { version: m.version },
          "the stored mandate doesn't match its hash",
        );
        continue;
      }
      await one(
        m.accountId,
        { version: m.version },
        hash,
        () =>
          chain.read.readContract({
            address,
            abi: gateAnchorAbi,
            functionName: "mandateHashOf",
            args: [account, version],
          }),
        () => chain.send(address, gateAnchorAbi, "postMandate", [account, version, hash]),
      );
    }
    for (const r of await this.store.unpostedRoots(batch)) {
      const account = gateAccountKey(r.accountId);
      const day = gateDayNumber(r.day);
      const root = r.root as Hex;
      await one(
        r.accountId,
        { day: r.day },
        root,
        () =>
          chain.read.readContract({
            address,
            abi: gateAnchorAbi,
            functionName: "logRootOf",
            args: [account, day],
          }),
        () => chain.send(address, gateAnchorAbi, "postLogRoot", [account, day, root]),
      );
    }
    return { posted, failed };
  }
}

/**
 * Why a post failed, without the error's message: an RPC error can carry the RPC URL and its key.
 * A contract's refusal is named (NotPoster, DayNotOver, ...).
 */
function postError(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName)
      return `GateAnchor refused it (${revert.data.errorName}); will retry`;
    return `post failed (${error.name}); will retry`;
  }
  if (error instanceof HashConflict) return error.message;
  return `post failed (${error instanceof Error ? error.name : "unknown error"}); will retry`;
}
