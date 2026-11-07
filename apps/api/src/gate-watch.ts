import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  parseAbiItem,
  type Address,
  type PublicClient,
} from "viem";
import type {
  Connection,
  Database,
  GateAccountRecord,
  GateStore,
  GateWatchedPaymentRecord,
  GateWatchStore,
} from "@bonded/db";
import {
  checkWatchedPayment,
  GATE_RULE_WORDS,
  GATE_RULES,
  normalAccount,
  normalReference,
  utcDay,
  type GateRule,
} from "@bondedhq/shared";
import { Refused, handle } from "./refused.js";
import { decisionView } from "./gate-check.js";
import { gateNotification, type Notifier } from "./notifications.js";

/**
 * Watch mode: payments Bonded reads after they were made, from a log a business sends
 * (`POST /payments/watched`) or a public wallet it reads (`GateWatcher`). Bonded holds no key for
 * either, and nothing here can stop a payment: it only records and alerts. A watched payment that
 * matches an earlier allowed check is just noted, since the check already judged it. Any other runs
 * through the same rules and counts toward the limits. Watched payments get no receipt, because
 * Bonded decided nothing before the money left, and they stay out of the decision log.
 */

/** A check this long before a payment can be the check for it. */
const MATCH_BEFORE_MS = 24 * 3_600_000;
/** Clock drift between a check and a payment's stated time. */
const MATCH_AFTER_MS = 5 * 60_000;
/** The most payments in one `POST /payments/watched`. */
const MAX_LOG_BATCH = 100;

export interface WatchedInput {
  source: "log" | "wallet";
  /** Names the payment at its source: the same id again records nothing. */
  externalId: string;
  account: string;
  amountCents: number;
  reference: string;
  paidAt: Date;
  details?: Record<string, string | number>;
}

export interface WatchedOutcome {
  payment: GateWatchedPaymentRecord;
  /** The same payment was seen before: nothing changed. */
  repeated: boolean;
  froze: boolean;
  account: GateAccountRecord;
}

/** Record one payment seen after it was made, in one transaction holding the account's lock. */
export async function recordWatched(
  deps: { db: Database; store: GateStore; watch: GateWatchStore },
  accountId: string,
  input: WatchedInput,
): Promise<WatchedOutcome> {
  const { db, store, watch } = deps;
  return db.transaction(async (c: Connection) => {
    const account = await store.lockAccount(c, accountId);
    if (!account) throw new Refused(404, "No such gate account.");
    const earlier = await watch.watchedPayment(c, accountId, input.externalId);
    if (earlier) return { payment: earlier, repeated: true, froze: false, account };
    const payeeNorm = normalAccount(input.account);
    const record = {
      accountId,
      source: input.source,
      externalId: input.externalId,
      payee: input.account,
      payeeNorm,
      amountCents: input.amountCents,
      reference: input.reference,
      details: input.details ?? {},
      paidAt: input.paidAt,
    };
    const matched = await watch.matchingCheck(c, accountId, {
      payeeNorm,
      amountCents: input.amountCents,
      since: new Date(input.paidAt.getTime() - MATCH_BEFORE_MS),
      until: new Date(input.paidAt.getTime() + MATCH_AFTER_MS),
    });
    if (matched) {
      const payment = await watch.addWatched(c, {
        ...record,
        vendorId: null,
        rules: [],
        lossCents: 0,
        overpaidCents: 0,
        matchedDecision: matched,
      });
      return { payment, repeated: false, froze: false, account };
    }
    const day = utcDay(input.paidAt);
    const referenceNorm = normalReference(input.reference);
    const state = await store.checkState(c, accountId, {
      kind: "invoice",
      accountNorm: payeeNorm,
      referenceNorm,
      day,
    });
    const check = checkWatchedPayment(
      {
        limits: {
          maxPaymentUsd: account.maxPaymentCents / 100,
          maxDailyUsd: account.maxDailyCents / 100,
          // As on a check, the hourly limit only applies with invoice matching off.
          maxPaymentsPerHour: account.invoiceMatching ? null : account.maxPaymentsPerHour,
        },
        invoiceMatching: account.invoiceMatching,
        payees: state.payees,
        invoices: state.invoices.map((i) => ({ ...i, amountUsd: i.amountCents / 100 })),
        payments: state.payments.map((p) => ({
          account: p.account,
          vendorId: p.vendorId,
          amountUsd: p.amountCents / 100,
          invoiceReference: p.reference,
          day: p.day,
          ...(p.kind === "refund" ? { kind: "refund" as const } : {}),
        })),
        paymentsLastHour: await store.paymentsSince(
          c,
          accountId,
          new Date(input.paidAt.getTime() - 3_600_000),
        ),
        day,
      },
      {
        account: input.account,
        amountUsd: input.amountCents / 100,
        invoiceReference: input.reference,
      },
    );
    if (!check.ok) throw new Refused(400, check.error);
    const rules: GateRule[] = account.expectChecks ? [...check.rules, "skipped_gate"] : check.rules;
    const payment = await watch.addWatched(c, {
      ...record,
      vendorId: check.vendorId,
      rules,
      lossCents: Math.round(check.lossUsd * 100),
      overpaidCents: Math.round(check.overpaidUsd * 100),
      matchedDecision: null,
    });
    await store.addPayment(
      accountId,
      {
        source: "watch",
        kind: "invoice",
        payee: input.account,
        payeeNorm,
        vendorId: check.vendorId,
        amountCents: input.amountCents,
        reference: input.reference,
        referenceNorm,
        day,
      },
      c,
    );
    const froze = rules.length > 0 && account.freezeOnBreach && account.frozenAt === null;
    if (froze) await store.freeze(c, accountId, null);
    return { payment, repeated: false, froze, account };
  });
}

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Tell the owner about a watched payment that broke a rule. Once per payment. */
export function alertWatched(notifier: Notifier, outcome: WatchedOutcome): void {
  const { payment: p, account } = outcome;
  if (outcome.repeated || p.rules.length === 0) return;
  const what = `${dollars(p.amountCents)} to ${p.payeeNorm}`;
  const others = p.rules.filter((r) => r !== "skipped_gate");
  const details = {
    watchedPayment: p.id,
    source: p.source,
    rules: p.rules.join(","),
    amountUsd: p.amountCents / 100,
    payee: p.payeeNorm,
    reference: p.reference,
  };
  const at = p.seenAt.toISOString();
  const base = { gateAccountId: account.id, details, at };
  notifier.notify(
    account.owner,
    gateNotification(
      others.length > 0
        ? {
            ...base,
            type: "payment_seen_breach",
            dedupeKey: `gate:watch:${p.id}:payment_seen_breach`,
            message: `A payment already made broke the rules: ${what}: ${p.rules.map((r) => GATE_RULE_WORDS[r as GateRule] ?? r).join("; ")}.`,
          }
        : {
            ...base,
            type: "gate_skipped",
            dedupeKey: `gate:watch:${p.id}:gate_skipped`,
            message: `A payment was made with no check first: ${what}.`,
          },
    ),
  );
  if (outcome.froze)
    notifier.notify(
      account.owner,
      gateNotification({
        ...base,
        type: "gate_frozen",
        dedupeKey: `gate:watch:${p.id}:gate_frozen`,
        message: `The payment gate froze ${account.name ? `"${account.name}"` : "a gate account"} after a breach; every check is refused until you lift the freeze.`,
      }),
    );
}

/** The stablecoins Bonded can read and value, one dollar each. */
export const WATCH_CHAINS: Record<
  number,
  {
    name: string;
    confirmations: number;
    tokens: { symbol: string; address: Address; decimals: number }[];
  }
> = {
  1: {
    name: "Ethereum",
    confirmations: 12,
    tokens: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    ],
  },
  8453: {
    name: "Base",
    confirmations: 30,
    tokens: [
      { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    ],
  },
  42161: {
    name: "Arbitrum",
    confirmations: 30,
    tokens: [
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    ],
  },
  84532: {
    name: "Base Sepolia",
    confirmations: 5,
    tokens: [
      { symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
    ],
  },
};

/** One token transfer out of a wallet. */
export interface WalletTransfer {
  to: Address;
  symbol: string;
  /** Rounded to the cent, and at least one: a smaller payment is still a payment. */
  amountCents: number;
  txHash: string;
  logIndex: number;
  paidAt: Date;
}

/** Reads one chain. `GateWatcher` needs nothing else, so tests can stand in for a node. */
export interface WalletReader {
  /** The newest block that has enough confirmations. */
  safeHead(): Promise<bigint>;
  transfers(wallet: Address, fromBlock: bigint, toBlock: bigint): Promise<WalletTransfer[]>;
}

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Whole cents of a token amount. Zero stays zero: a spoofed transfer of nothing is no payment. */
export function tokenCents(value: bigint, decimals: number): number {
  if (value === 0n) return 0;
  const scale = 10n ** BigInt(Math.max(decimals - 2, 0));
  const cents = (value + scale / 2n) / scale;
  return cents === 0n ? 1 : Number(cents);
}

export function viemWalletReader(
  client: Pick<PublicClient, "getBlockNumber" | "getLogs" | "getBlock">,
  chain: {
    confirmations: number;
    tokens: { symbol: string; address: Address; decimals: number }[];
  },
): WalletReader {
  const byAddress = new Map(chain.tokens.map((t) => [t.address.toLowerCase(), t]));
  return {
    async safeHead() {
      return (await client.getBlockNumber()) - BigInt(chain.confirmations);
    },
    async transfers(wallet, fromBlock, toBlock) {
      const logs = await client.getLogs({
        address: chain.tokens.map((t) => t.address),
        event: TRANSFER,
        args: { from: wallet },
        fromBlock,
        toBlock,
      });
      const times = new Map<bigint, Date>();
      const out: WalletTransfer[] = [];
      for (const log of logs) {
        const token = byAddress.get(log.address.toLowerCase());
        const { to, value } = log.args;
        if (!token || !to || value === undefined || value === 0n) continue;
        let paidAt = times.get(log.blockNumber);
        if (!paidAt) {
          const block = await client.getBlock({ blockNumber: log.blockNumber });
          paidAt = new Date(Number(block.timestamp) * 1000);
          times.set(log.blockNumber, paidAt);
        }
        out.push({
          to,
          symbol: token.symbol,
          amountCents: tokenCents(value, token.decimals),
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          paidAt,
        });
      }
      return out;
    },
  };
}

/** The chains to read: GATE_WATCH_RPC_URLS, a JSON object of chain id to RPC URL. */
export function watchReadersFromEnv(
  env: Record<string, string | undefined> = process.env,
): Map<number, WalletReader> {
  const raw = env.GATE_WATCH_RPC_URLS?.trim();
  const readers = new Map<number, WalletReader>();
  if (!raw) return readers;
  for (const [id, url] of Object.entries(z.record(z.string(), z.url()).parse(JSON.parse(raw)))) {
    const chain = WATCH_CHAINS[Number(id)];
    if (!chain) throw new Error(`GATE_WATCH_RPC_URLS names chain ${id}, which Bonded can't read`);
    readers.set(
      Number(id),
      viemWalletReader(createPublicClient({ transport: http(url) }) as PublicClient, chain),
    );
  }
  return readers;
}

/** Reads every watched wallet, oldest read first. One wallet's failure doesn't stop the others. */
export class GateWatcher {
  constructor(
    private readonly deps: {
      db: Database;
      store: GateStore;
      watch: GateWatchStore;
      notifier: Notifier;
      readers: ReadonlyMap<number, WalletReader>;
      now?: () => number;
      /** The most blocks in one read, under what RPC providers allow. */
      maxBlocks?: bigint;
      log?: (line: string) => void;
    },
  ) {}

  async tick(): Promise<void> {
    const { watch, readers } = this.deps;
    const now = this.deps.now ?? Date.now;
    const maxBlocks = this.deps.maxBlocks ?? 2_000n;
    const log = this.deps.log ?? ((line: string) => console.error(line));
    const heads = new Map<number, bigint>();
    const wallets = await watch.walletsToRead([...readers.keys()]);
    for (const wallet of wallets) {
      try {
        const reader = readers.get(wallet.chainId)!;
        const head = heads.get(wallet.chainId) ?? (await reader.safeHead());
        heads.set(wallet.chainId, head);
        // A new wallet starts here: payments from before it was added aren't its to report.
        if (wallet.nextBlock === null) {
          await watch.walletRead(wallet.id, head + 1n, new Date(now()));
          continue;
        }
        if (wallet.nextBlock > head) continue;
        const to =
          wallet.nextBlock + maxBlocks - 1n < head ? wallet.nextBlock + maxBlocks - 1n : head;
        const transfers = await reader.transfers(getAddress(wallet.address), wallet.nextBlock, to);
        const own = new Set(
          wallets
            .filter((w) => w.accountId === wallet.accountId && w.chainId === wallet.chainId)
            .map((w) => w.address),
        );
        for (const t of transfers) {
          // Moving money between the account's own wallets pays nobody.
          if (own.has(t.to.toLowerCase())) continue;
          const outcome = await recordWatched(this.deps, wallet.accountId, {
            source: "wallet",
            externalId: `wallet:${wallet.chainId}:${t.txHash}:${t.logIndex}`,
            account: t.to,
            amountCents: t.amountCents,
            reference: "",
            paidAt: t.paidAt,
            details: {
              chainId: wallet.chainId,
              wallet: wallet.address,
              token: t.symbol,
              txHash: t.txHash,
            },
          });
          alertWatched(this.deps.notifier, outcome);
        }
        await watch.walletRead(wallet.id, to + 1n, new Date(now()));
      } catch (error) {
        log(`gate watch: wallet ${wallet.id} could not be read (${(error as Error).name})`);
      }
    }
  }
}

const payee = z
  .string()
  .max(100)
  .regex(/^[\x20-\x7E]+$/)
  .refine((v) => normalAccount(v).length > 0);
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
const cents = z
  .number()
  .positive()
  .max(100_000_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6)
  .transform((v) => Math.round(v * 100));
const logInput = z.strictObject({
  payments: z
    .array(
      z.strictObject({
        /** Your id for the payment: sending it again records nothing. */
        id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        account: payee,
        amountUsd: cents,
        reference: text(100).optional(),
        paidAt: z.iso.datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(MAX_LOG_BATCH),
});
const walletInput = z.strictObject({
  chainId: z.number().int().positive(),
  address: z.string().refine((v) => isAddress(v, { strict: false })),
  label: text(80).optional(),
});
const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z
    .string()
    .regex(/^\d{1,18}$/)
    .optional(),
});

const activityQuery = listQuery.omit({ before: true }).extend({
  before: z
    .string()
    .regex(
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?[+-]\d\d(:\d\d)?\|(decision|watched)\|[0-9a-f-]{1,36}$/,
    )
    .optional(),
  source: z.enum(["check", "card", "log", "wallet"]).optional(),
  result: z.enum(["allowed", "blocked", "refused", "seen"]).optional(),
  rule: z.enum(GATE_RULES).optional(),
});

/** Where a watched payment came from, in words: "Base USDC", or the payment log. */
function railOf(p: GateWatchedPaymentRecord): string {
  if (p.source === "log") return "Payment log";
  const chain = WATCH_CHAINS[Number(p.details.chainId)]?.name ?? "Wallet";
  return `${chain} ${p.details.token ?? ""}`.trim();
}

const watchedView = (p: GateWatchedPaymentRecord) => ({
  id: p.id,
  source: p.source,
  rail: railOf(p),
  payee: p.payeeNorm,
  vendorId: p.vendorId,
  amountUsd: p.amountCents / 100,
  reference: p.reference,
  rules: p.rules,
  reasons: p.rules.map((rule) => ({ rule, words: GATE_RULE_WORDS[rule as GateRule] ?? rule })),
  lossUsd: p.lossCents / 100,
  overpaidUsd: p.overpaidCents / 100,
  /** Said so it can never read as a payment Bonded checked first. */
  checkedFirst: p.matchedDecision !== null,
  matchedDecision: p.matchedDecision,
  details: p.details,
  paidAt: p.paidAt.toISOString(),
  seenAt: p.seenAt.toISOString(),
});

export function gateWatchRoutes(
  app: Hono,
  deps: {
    db: Database;
    store: GateStore;
    watch: GateWatchStore;
    notifier: Notifier;
    now: () => number;
    /** Chains this service can read (GATE_WATCH_RPC_URLS). */
    chains: readonly number[];
    maxWallets: number;
    owned: (c: Context, write: boolean) => Promise<{ account: GateAccountRecord }>;
    keyed: (c: Context) => Promise<{ accountId: string }>;
    allowCheck: (accountId: string) => boolean;
  },
) {
  const { watch, now } = deps;
  const walletView = (w: Awaited<ReturnType<GateWatchStore["wallets"]>>[number]) => ({
    id: w.id,
    chainId: w.chainId,
    chain: WATCH_CHAINS[w.chainId]?.name ?? String(w.chainId),
    address: w.address,
    label: w.label,
    lastReadAt: w.lastReadAt?.toISOString() ?? null,
    createdAt: w.createdAt.toISOString(),
  });
  /** The chains a wallet can be added on. Public: it says nothing about any account. */
  app.get(
    "/gate/watch-chains",
    handle(async (c) =>
      c.json({
        items: deps.chains.map((id) => ({
          chainId: id,
          name: WATCH_CHAINS[id]?.name ?? String(id),
          tokens: WATCH_CHAINS[id]?.tokens.map((t) => t.symbol) ?? [],
        })),
      }),
    ),
  );
  /** Tell the gate about payments already made. Reported, not proved: the log is yours. */
  app.post(
    "/payments/watched",
    handle(async (c) => {
      const auth = await deps.keyed(c);
      if (!deps.allowCheck(auth.accountId))
        throw new Refused(429, "Too many checks for this gate account. Try again in a minute.");
      const { payments } = logInput.parse(await c.req.json());
      const latest = now() + MATCH_AFTER_MS;
      for (const p of payments)
        if (Date.parse(p.paidAt) > latest)
          throw new Refused(400, `Payment ${p.id} is dated in the future.`);
      const items = [];
      for (const p of payments) {
        const outcome = await recordWatched(deps, auth.accountId, {
          source: "log",
          externalId: `log:${p.id}`,
          account: p.account,
          amountCents: p.amountUsd,
          reference: p.reference ?? "",
          paidAt: new Date(p.paidAt),
        });
        alertWatched(deps.notifier, outcome);
        items.push({ ...watchedView(outcome.payment), repeated: outcome.repeated });
      }
      return c.json({ items });
    }),
  );
  /**
   * Everything that happened on the account, newest first: checks and payments seen after they
   * were made, each saying which it is. `?source=`, `?result=` and `?rule=` narrow it.
   */
  app.get(
    "/gate/accounts/:id/activity",
    handle(async (c) => {
      const { account } = await deps.owned(c, false);
      const q = activityQuery.parse(c.req.query());
      const page = await watch.activity(account.id, q);
      const ids = (entry: string) => page.items.filter((i) => i.entry === entry).map((i) => i.id);
      const [decisions, payments] = await Promise.all([
        deps.store.decisionsByIds(account.id, ids("decision")),
        watch.watchedByIds(account.id, ids("watched")),
      ]);
      const byDecision = new Map(decisions.map((d) => [d.id, d]));
      const byWatched = new Map(payments.map((p) => [p.id, p]));
      const items: Record<string, unknown>[] = [];
      for (const i of page.items) {
        const d = byDecision.get(i.id);
        const p = byWatched.get(i.id);
        if (i.entry === "decision" && d) {
          const rail = i.source === "card" ? "Card" : "API";
          items.push({ entry: i.entry, source: i.source, rail, decision: decisionView(d) });
        } else if (i.entry === "watched" && p) {
          items.push({
            entry: i.entry,
            source: i.source,
            rail: railOf(p),
            watched: watchedView(p),
          });
        }
      }
      return c.json({ items, next: page.next });
    }),
  );
  /** What's connected to the account, and when each last reported. */
  app.get(
    "/gate/accounts/:id/connections",
    handle(async (c) => {
      const { account } = await deps.owned(c, false);
      const [keys, wallets, lastReported] = await Promise.all([
        deps.store.keys(account.id),
        watch.wallets(account.id),
        watch.lastReported(account.id),
      ]);
      return c.json({
        keys: keys
          .filter((k) => !k.revokedAt)
          .map((k) => ({
            id: k.id,
            label: k.label,
            lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          })),
        wallets: wallets.map(walletView),
        log: { lastReportedAt: lastReported?.toISOString() ?? null },
      });
    }),
  );
  /** The payments seen, newest first. */
  app.get(
    "/gate/accounts/:id/watched",
    handle(async (c) => {
      const { account } = await deps.owned(c, false);
      const q = listQuery.parse(c.req.query());
      const r = await watch.watchedPayments(account.id, {
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.before ? { before: q.before } : {}),
      });
      return c.json({ items: r.items.map(watchedView), next: r.next });
    }),
  );
  app.get(
    "/gate/accounts/:id/wallets",
    handle(async (c) => {
      const { account } = await deps.owned(c, false);
      return c.json({ items: (await watch.wallets(account.id)).map(walletView) });
    }),
  );
  /** Watch a public address. Bonded needs no key: it only reads what's on chain. */
  app.post(
    "/gate/accounts/:id/wallets",
    handle(async (c) => {
      const { account } = await deps.owned(c, true);
      const input = walletInput.parse(await c.req.json());
      if (!deps.chains.includes(input.chainId))
        throw new Refused(409, "Bonded can't read that chain on this service.");
      const made = await watch.addWallet(
        {
          id: randomUUID(),
          accountId: account.id,
          chainId: input.chainId,
          address: input.address.toLowerCase(),
          label: input.label ?? "",
        },
        deps.maxWallets,
      );
      if (!made) throw new Refused(409, "That wallet is already on this gate account.");
      if ("refused" in made)
        throw new Refused(409, "This gate account has as many wallets as it may.", {
          limit: deps.maxWallets,
        });
      return c.json(walletView(made), 201);
    }),
  );
  app.delete(
    "/gate/accounts/:id/wallets/:walletId",
    handle(async (c) => {
      const { account } = await deps.owned(c, true);
      const id = z.uuid().safeParse(c.req.param("walletId"));
      if (!id.success || !(await watch.deleteWallet(account.id, id.data)))
        throw new Refused(404, "No such wallet on this gate account.");
      return c.json({ deleted: true });
    }),
  );
}
