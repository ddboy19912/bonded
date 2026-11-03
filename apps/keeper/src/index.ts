import { Database } from "@bonded/db";
import {
  claimsEngineAbi,
  coverManagerAbi,
  mandateModuleFactoryAbi,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
} from "@bondedhq/shared";
import { getAbiItem, type Address } from "viem";
import type { ServiceChain } from "./chain.js";
export * from "./chain.js";
export * from "./solana.js";
export * from "./gate-anchor.js";

/** BondedTypes.BreachType.Deferred: an unexplained drop found by reconcile(). */
const DEFERRED = 3;
/** Why the keeper doesn't file a Deferred breach recorded by a MandateModule. */
export const MODULE_DEFERRED_NOT_COVERED =
  "Deferred breaches on smart-account modules aren't covered: the account's owner can move funds outside the module, so ClaimsEngine refuses them";

/** One durable scanner and transaction sender per chain. Finalized cursor mismatch fails closed. */
export class Keeper {
  private lastAccrual = 0;
  constructor(
    readonly db: Database,
    readonly chain: ServiceChain,
    readonly confirmations = 5n,
    /**
     * How often to accrue every active policy's premium. Each accrual is a transaction, so this
     * sets most of the keeper's gas use. Claims, cancellations and new cover accrue on chain when
     * they happen, so this only keeps the pool's income and lapses current between those.
     */
    readonly accrueIntervalMs = 60 * 60_000,
  ) {}
  /** Index a confirmed batch, accrue policies independently, then retry saved breaches. */
  async tick() {
    const c = await this.db.pool.connect();
    const id = this.chain.deployment.chainId;
    let locked = false;
    try {
      locked = (await c.query("SELECT pg_try_advisory_lock(7003,$1) AS locked", [id])).rows[0]
        .locked;
      if (!locked) return;
      await this.scan();
      if (Date.now() - this.lastAccrual >= this.accrueIntervalMs) {
        const policies = await this.db.pool.query(
          "SELECT policy_id FROM keeper_policies WHERE chain_id=$1",
          [id],
        );
        for (const p of policies.rows) {
          try {
            const policy = await this.chain.read.readContract({
              address: this.chain.deployment.coverManager,
              abi: coverManagerAbi,
              functionName: "getPolicy",
              args: [BigInt(p.policy_id)],
            });
            if (policy.status === 1)
              await this.chain.send(this.chain.deployment.coverManager, coverManagerAbi, "accrue", [
                BigInt(p.policy_id),
              ]);
          } catch {
            await this.db.publish("keeper.accrual_failed", { chainId: id, policyId: p.policy_id });
          }
        }
        this.lastAccrual = Date.now();
      }
      await this.claim();
    } finally {
      if (locked) await c.query("SELECT pg_advisory_unlock(7003,$1)", [id]);
      c.release();
    }
  }
  /**
   * Commit discovered vaults, policies and breaches with their confirmed block cursor. MandateModules
   * (smart accounts) are tracked exactly like vaults: same breach log, events and claims.
   */
  private async scan() {
    const { read, deployment: d } = this.chain;
    if ((await read.getChainId()) !== d.chainId) throw new Error("RPC chain mismatch");
    const cursor = (
      await this.db.pool.query("SELECT * FROM keeper_cursors WHERE chain_id=$1 AND registry=$2", [
        d.chainId,
        d.registry.toLowerCase(),
      ])
    ).rows[0];
    if (cursor) {
      const previous = await read.getBlock({ blockNumber: BigInt(cursor.block_number) });
      if (previous.hash !== cursor.block_hash)
        throw new Error("keeper cursor reorg: operator reconciliation required");
    }
    const from = cursor ? BigInt(cursor.block_number) + 1n : BigInt(d.deployedAtBlock);
    const head = await read.getBlockNumber({ cacheTime: 0 });
    if (head < this.confirmations || from > head - this.confirmations) return;
    const to = head - this.confirmations < from + 499n ? head - this.confirmations : from + 499n;
    const created = await read.getLogs({
      address: d.factory,
      event: getAbiItem({ abi: mandateVaultFactoryAbi, name: "VaultCreated" }),
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    const modules = d.moduleFactory
      ? await read.getLogs({
          address: d.moduleFactory,
          event: getAbiItem({ abi: mandateModuleFactoryAbi, name: "ModuleCreated" }),
          fromBlock: from,
          toBlock: to,
          strict: true,
        })
      : [];
    const bound = await read.getLogs({
      address: d.coverManager,
      event: getAbiItem({ abi: coverManagerAbi, name: "CoverBound" }),
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    const known = await this.db.pool.query("SELECT address FROM keeper_vaults WHERE chain_id=$1", [
      d.chainId,
    ]);
    const vaults = [
      ...new Set([
        ...known.rows.map((v): Address => v.address),
        ...created.map((v) => v.args.vault.toLowerCase() as Address),
        ...modules.map((m) => m.args.module.toLowerCase() as Address),
      ]),
    ];
    const breaches = (
      await Promise.all(
        vaults.map((address) =>
          read.getLogs({
            address,
            event: getAbiItem({ abi: mandateVaultAbi, name: "BreachRecorded" }),
            fromBlock: from,
            toBlock: to,
            strict: true,
          }),
        ),
      )
    ).flat();
    // The agent's trades through each vault or module (only its key can call execute): what the
    // agent page's trading status and the gas estimate are read from.
    const executed = vaults.length
      ? await read.getLogs({
          address: vaults,
          event: getAbiItem({ abi: mandateVaultAbi, name: "Executed" }),
          fromBlock: from,
          toBlock: to,
          strict: true,
        })
      : [];
    const gasOf = new Map<string, Promise<bigint | null>>();
    const block = await read.getBlock({ blockNumber: to });
    // What each breach was and when, for observed breach rates (GET /stats/observed-rates). Read
    // before the transaction; breaches are rare, so a few reads per batch at most.
    const agentOf = new Map<string, Promise<bigint>>();
    const timeOf = new Map<bigint, Promise<bigint>>();
    const details = await Promise.all(
      breaches.map(async (b) => {
        const vault = b.address.toLowerCase();
        if (!agentOf.has(vault))
          agentOf.set(
            vault,
            read.readContract({
              address: b.address,
              abi: mandateVaultAbi,
              functionName: "agentId",
            }),
          );
        if (!timeOf.has(b.blockNumber))
          timeOf.set(
            b.blockNumber,
            read.getBlock({ blockNumber: b.blockNumber }).then((x) => x.timestamp),
          );
        return {
          agentId: (await agentOf.get(vault)!).toString(),
          at: new Date(Number(await timeOf.get(b.blockNumber)!) * 1000),
        };
      }),
    );
    const trades = await Promise.all(
      executed.map(async (log) => {
        if (!timeOf.has(log.blockNumber))
          timeOf.set(
            log.blockNumber,
            read.getBlock({ blockNumber: log.blockNumber }).then((x) => x.timestamp),
          );
        if (!gasOf.has(log.transactionHash))
          gasOf.set(
            log.transactionHash,
            read
              .getTransactionReceipt({ hash: log.transactionHash })
              .then((r) => r.gasUsed)
              .catch(() => null),
          );
        return {
          at: new Date(Number(await timeOf.get(log.blockNumber)!) * 1000),
          gas: await gasOf.get(log.transactionHash)!,
        };
      }),
    );
    await this.db.transaction(async (c) => {
      for (const address of vaults)
        await c.query("INSERT INTO keeper_vaults VALUES($1,$2) ON CONFLICT DO NOTHING", [
          d.chainId,
          address,
        ]);
      for (const p of bound) {
        const added = await c.query(
          "INSERT INTO keeper_policies VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [d.chainId, p.args.policyId.toString(), p.args.vault.toLowerCase()],
        );
        if (added.rowCount) await this.db.countFunnel("cover_bought", c);
      }
      for (const [i, log] of executed.entries()) {
        const vault = log.address.toLowerCase();
        const before = await c.query(
          "SELECT 1 FROM vault_trades WHERE chain_id=$1 AND vault=$2 LIMIT 1",
          [d.chainId, vault],
        );
        const added = await c.query(
          `INSERT INTO vault_trades(id,chain_id,vault,target,selector,outflow_usd6,tx_hash,block_number,occurred_at,gas_used)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [
            `${d.chainId}:${log.transactionHash}:${log.logIndex}`,
            d.chainId,
            vault,
            log.args.target.toLowerCase(),
            log.args.selector.toLowerCase(),
            log.args.outflowUsd6.toString(),
            log.transactionHash,
            log.blockNumber.toString(),
            trades[i]!.at,
            trades[i]!.gas?.toString() ?? null,
          ],
        );
        if (added.rowCount && !before.rowCount)
          await this.db.countFunnel("first_vault_trade", c, trades[i]!.at);
      }
      for (const [i, b] of breaches.entries())
        await c.query(
          `INSERT INTO handled_events(id,chain_id,vault,breach_id,agent_id,breach_type,blocked,occurred_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [
            `${d.chainId}:${b.transactionHash}:${b.logIndex}`,
            d.chainId,
            b.address.toLowerCase(),
            b.args.breachId.toString(),
            details[i]!.agentId,
            b.args.breachType,
            b.args.blocked,
            details[i]!.at,
          ],
        );
      await c.query(
        `INSERT INTO keeper_cursors(chain_id,block_number,block_hash,registry) VALUES($1,$2,$3,$4)
         ON CONFLICT(chain_id,registry) DO UPDATE SET block_number=$2,block_hash=$3`,
        [d.chainId, to.toString(), block.hash, d.registry.toLowerCase()],
      );
    });
  }
  /** True if `address` is a MandateModule (not a vault). Deployments before modules have none. */
  private async isModule(address: Address) {
    const factory = this.chain.deployment.moduleFactory;
    if (!factory) return false;
    return this.chain.read.readContract({
      address: factory,
      abi: mandateModuleFactoryAbi,
      functionName: "isModule",
      args: [address],
    });
  }
  /** Pay eligible breaches; only classify a no-match after indexing through its block. */
  private async claim() {
    const { read, deployment: d } = this.chain;
    const pending = await this.db.pool.query(
      "SELECT * FROM handled_events WHERE chain_id=$1 AND status='pending' ORDER BY id",
      [d.chainId],
    );
    for (const e of pending.rows) {
      try {
        const breach = await read.readContract({
          address: e.vault as Address,
          abi: mandateVaultAbi,
          functionName: "getBreach",
          args: [BigInt(e.breach_id)],
        });
        if (breach.claimed || breach.blocked || breach.lossUsd6 === 0n) {
          await this.db.pool.query("UPDATE handled_events SET status=$2,error=NULL WHERE id=$1", [
            e.id,
            breach.claimed ? "claimed" : "ignored",
          ]);
          continue;
        }
        if (breach.breachType === DEFERRED && (await this.isModule(e.vault as Address))) {
          await this.db.pool.query(
            "UPDATE handled_events SET status='ignored',error=$2 WHERE id=$1",
            [e.id, MODULE_DEFERRED_NOT_COVERED],
          );
          continue;
        }
        // Keep historical policies: activePolicyOf is cleared when a policy closes.
        const policies = await this.db.pool.query(
          "SELECT policy_id FROM keeper_policies WHERE chain_id=$1 AND vault=$2 ORDER BY policy_id",
          [d.chainId, e.vault],
        );
        let claimed = false;
        for (const p of policies.rows) {
          const policyId = BigInt(p.policy_id);
          const [start, end] = await read.readContract({
            address: d.coverManager,
            abi: coverManagerAbi,
            functionName: "coverageWindow",
            args: [policyId],
          });
          const window = await read.readContract({
            address: d.claimsEngine,
            abi: claimsEngineAbi,
            functionName: "claimWindow",
          });
          const now = (await read.getBlock()).timestamp;
          if (breach.timestamp < start || breach.timestamp > end || now > end + window) continue;
          // Simulation repeats the checks after accrual, including lapse, deductible and liquidity,
          // and a rejected simulation (say, PoolShortfall) broadcasts nothing. So the claim counts
          // as filed only once its transaction is broadcast: the owner hears "claim filed" once,
          // from that first broadcast (owner-alerts.ts). A failed attempt only sets the error.
          const filed = async () => {
            await this.db.pool.query(
              "UPDATE handled_events SET claim_filed_at=coalesce(claim_filed_at,now()) WHERE id=$1",
              [e.id],
            );
          };
          const hash = await this.chain.send(
            d.claimsEngine,
            claimsEngineAbi,
            "fileClaim",
            [policyId, [BigInt(e.breach_id)]],
            {
              beforeBroadcast: async () => {},
              onBroadcast: filed,
              onReverted: async () => {},
            },
          );
          await this.db.transaction(async (c) => {
            await c.query(
              "UPDATE handled_events SET status='claimed',tx_hash=$2,error=NULL,claim_filed_at=coalesce(claim_filed_at,now()) WHERE id=$1",
              [e.id, hash],
            );
            await this.db.publish(
              "claim.paid",
              { chainId: d.chainId, vault: e.vault, breachId: e.breach_id, hash },
              c,
            );
          });
          claimed = true;
          break;
        }
        if (!claimed) {
          // Both policy and breach logs are committed through the same cursor. A later
          // policy cannot cover an earlier block, but may cover an earlier transaction at
          // the SAME timestamp (coverageWindow is inclusive). Wait until the scanner has
          // reached a strictly later timestamp before making this classification terminal.
          const cursor = (
            await this.db.pool.query(
              "SELECT block_number FROM keeper_cursors WHERE chain_id=$1 AND registry=$2",
              [d.chainId, d.registry.toLowerCase()],
            )
          ).rows[0];
          const scanned = cursor
            ? await read.getBlock({ blockNumber: BigInt(cursor.block_number) })
            : undefined;
          const complete = !!scanned && scanned.timestamp > breach.timestamp;
          await this.db.pool.query("UPDATE handled_events SET status=$2,error=$3 WHERE id=$1", [
            e.id,
            complete ? "ignored" : "pending",
            complete
              ? "no policy covers this breach within its claim window"
              : "waiting for policy indexing past breach timestamp",
          ]);
        }
      } catch {
        await this.db.pool.query("UPDATE handled_events SET error=$2 WHERE id=$1", [
          e.id,
          "claim failed; will retry",
        ]);
      }
    }
  }
}
