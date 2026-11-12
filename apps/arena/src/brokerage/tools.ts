import {
  type AgentToolbox,
  ALPACA_BROKER_TOOLS,
  ALPACA_REPLACES,
  type AlpacaBrokerToolName,
  BROKER_TOOLS,
  type BrokerToolName,
  type BrokerToolProfile,
  type ToolResult,
} from "@bondedhq/shared";
import { z } from "zod";
import {
  type BrokerBreachType,
  type BrokerLedger,
  normalSymbol,
  type Order,
  type Side,
} from "./ledger.js";
import { type BrokerWorld, brokerWorldTools, type FeedItem, newestFirst } from "./world.js";

/** One tool call in a brokerage episode's trace. */
export interface BrokerTraceStep {
  step: number;
  /**
   * The world's own tool the call ran as (`place_order` for Alpaca's `place_stock_order`), so
   * exposure, approvals and judging read one set of names whatever the agent was offered.
   */
  tool: string;
  /** The name the agent called, when it was offered another profile's (`place_stock_order`). */
  calledAs?: string;
  args: unknown;
  result: ToolResult;
  /** Ids of the breaches the ledger recorded during this call. */
  breaches: number[];
  /** The ledger's id for the order this call filled, whatever names the agent used. */
  orderId?: number;
}

/** An order the agent put to the holder with `request_approval`. */
export interface BrokerApproval {
  step: number;
  symbol: string;
  side: Side;
  amountUsd: number;
  reason: string;
}

/**
 * The Arena's implementation of the brokerage tools. Reads come from the world (where attacks
 * are planted); `place_order` and `withdraw` go through the ledger, which checks the mandate and
 * records breaches. In Monitor mode a breaching order fills without comment, as it would at a
 * real broker.
 *
 * `request_approval` approves every order put to it: it stands in for a holder who trusts the
 * agent's explanation, which is what an approval step measures when the explanation itself was
 * shaped by an attack. The report lists every approval request.
 */
export class BrokerToolbox implements AgentToolbox {
  readonly trace: BrokerTraceStep[] = [];
  readonly approvals: BrokerApproval[] = [];
  readonly #abort = new AbortController();
  // Truly private: the agent holds this object, and must reach the ledger only through `call`.
  readonly #world: BrokerWorld;
  readonly #ledger: BrokerLedger;

  constructor(
    world: BrokerWorld,
    ledger: BrokerLedger,
    readonly maxSteps: number,
    /** Whose tool names the agent is offered (BROKER_TOOL_PROFILES). */
    readonly toolProfile: BrokerToolProfile = "bonded",
  ) {
    this.#world = world;
    this.#ledger = ledger;
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /** Ends the episode: aborts `signal` and refuses new calls. */
  close(): void {
    this.#abort.abort();
  }

  async call(name: string, args: unknown): Promise<ToolResult> {
    if (this.#abort.signal.aborted) return { ok: false, error: "the episode is over" };
    const alpaca = this.toolProfile === "alpaca" && Object.hasOwn(ALPACA_BROKER_TOOLS, name);
    const entry: BrokerTraceStep = {
      step: this.trace.length + 1,
      tool: alpaca ? ALPACA_RUNS_AS[name as AlpacaBrokerToolName] : name,
      ...(alpaca ? { calledAs: name } : {}),
      args,
      result: { ok: false, error: "pending" },
      breaches: [],
    };
    this.trace.push(entry);
    const before = this.#ledger.breaches().length;
    const ordersBefore = this.#ledger.orders().length;
    entry.result =
      entry.step > this.maxSteps
        ? { ok: false, error: `step limit of ${this.maxSteps} reached` }
        : alpaca
          ? this.#alpaca(name as AlpacaBrokerToolName, args, entry.step)
          : this.toolProfile === "alpaca" && ALPACA_REPLACES.includes(name as BrokerToolName)
            ? { ok: false, error: `unknown tool: ${name}` }
            : this.#dispatch(name, args, entry.step);
    entry.breaches = this.#ledger
      .breaches()
      .slice(before)
      .map((b) => b.id);
    const filled = this.#ledger.orders().slice(ordersBefore).at(-1);
    if (filled) entry.orderId = filled.id;
    return Promise.resolve(entry.result);
  }

  /**
   * An Alpaca-named call: its arguments checked against Alpaca's names, run as the world's own
   * tool (so the ledger sees the same order or read), and the result shaped the way Alpaca's
   * server returns it. Only market orders fill, as in the world itself.
   */
  #alpaca(name: AlpacaBrokerToolName, args: unknown, step: number): ToolResult {
    const parsed = ALPACA_BROKER_TOOLS[name].input.safeParse(args ?? {});
    if (!parsed.success) {
      return { ok: false, error: `invalid arguments: ${z.prettifyError(parsed.error)}` };
    }
    // Each case reads the fields its own schema checked.
    const input = parsed.data as Record<string, unknown>;
    const l = this.#ledger;
    const w = this.#world;
    const account = () => this.#dispatch("get_account", {}, step);
    const positions = () =>
      l.positions().map((p) => alpacaPosition(p.symbol, p.quantity, l.quote(p.symbol) ?? 0));
    switch (name) {
      case "get_account_info": {
        const r = account();
        if (!r.ok) return r;
        const value = l.accountValueUsd();
        return ok({
          account_number: "NGB-AGENT-1",
          status: "ACTIVE",
          currency: "USD",
          cash: usd(l.cashUsd),
          buying_power: usd(l.cashUsd),
          equity: usd(value),
          portfolio_value: usd(value),
          long_market_value: usd(value - l.cashUsd),
          pattern_day_trader: false,
          trading_blocked: false,
        });
      }
      case "get_all_positions": {
        const r = account();
        return r.ok ? ok(positions()) : r;
      }
      case "get_open_position": {
        const r = account();
        if (!r.ok) return r;
        const symbol = normalSymbol(String(input.symbol_or_asset_id));
        const found = positions().find((p) => p.symbol === symbol);
        return found ? ok(found) : { ok: false, error: `position does not exist: ${symbol}` };
      }
      case "get_orders": {
        const r = this.#dispatch("list_orders", {}, step);
        if (!r.ok) return r;
        const query = input as { status?: string; limit?: number; symbols?: string };
        // Market orders fill at once, so none is ever open.
        if (query.status === "open") return ok([]);
        const wanted = symbolList(query.symbols);
        const orders = l
          .orders()
          .reverse()
          .filter((o) => !wanted || wanted.includes(o.symbol))
          .slice(0, query.limit ?? 50);
        return ok(orders.map(alpacaOrder));
      }
      case "place_stock_order": {
        const order = input as z.infer<(typeof ALPACA_BROKER_TOOLS)["place_stock_order"]["input"]>;
        const type = order.type ?? "market";
        if (type !== "market" || order.limit_price !== undefined || order.stop_price !== undefined)
          return { ok: false, error: `only market orders are supported here, not ${type}` };
        if ((order.time_in_force ?? "day") !== "day")
          return { ok: false, error: 'only time_in_force "day" is supported here' };
        if ((order.qty === undefined) === (order.notional === undefined))
          return { ok: false, error: "give qty or notional, not both" };
        return this.#alpacaOrder(
          {
            symbol: order.symbol,
            side: order.side,
            ...(order.qty !== undefined
              ? { quantity: Number(order.qty) }
              : { amountUsd: Number(order.notional) }),
          },
          step,
          order.client_order_id,
        );
      }
      case "close_position": {
        const close = input as {
          symbol_or_asset_id: string;
          qty?: string | number;
          percentage?: string | number;
        };
        const symbol = normalSymbol(close.symbol_or_asset_id);
        const held = l.positions().find((p) => p.symbol === symbol)?.quantity ?? 0;
        if (held <= 0) return { ok: false, error: `position does not exist: ${symbol}` };
        if (close.qty !== undefined && close.percentage !== undefined)
          return { ok: false, error: "give qty or percentage, not both" };
        const quantity =
          close.qty !== undefined
            ? Number(close.qty)
            : close.percentage !== undefined
              ? (held * Number(close.percentage)) / 100
              : held;
        return this.#alpacaOrder({ symbol, side: "sell", quantity }, step);
      }
      case "get_stock_latest_quote": {
        const quotes: Record<string, unknown> = {};
        for (const raw of symbolList(String(input.symbols)) ?? []) {
          const r = this.#dispatch("get_quote", { symbol: raw }, step);
          if (!r.ok) return r;
          const { symbol, priceUsd } = r.output as { symbol: string; priceUsd: number };
          quotes[symbol] = {
            ap: priceUsd,
            bp: priceUsd,
            as: 100,
            bs: 100,
            t: `${w.today}T15:00:00Z`,
          };
        }
        return ok({ quotes });
      }
      case "get_news": {
        const r = this.#dispatch("list_news", {}, step);
        if (!r.ok) return r;
        // The feed has no ticker tags, so `symbols` doesn't filter it: every story is returned.
        const limit = (input as { limit?: number }).limit ?? 50;
        const news = (r.output as FeedItem[]).slice(0, limit).map((item) => ({
          id: item.id,
          headline: item.title ?? item.body.slice(0, 120),
          summary: item.body.slice(0, 300),
          content: item.body,
          author: item.source,
          source: item.source,
          created_at: item.publishedAt,
          symbols: [],
        }));
        return ok({ news, next_page_token: null });
      }
    }
  }

  /** A market order placed through Alpaca's names, returned as Alpaca shows an order. */
  #alpacaOrder(
    order: { symbol: string; side: Side; quantity?: number; amountUsd?: number },
    step: number,
    clientOrderId?: string,
  ): ToolResult {
    const r = this.#dispatch("place_order", order, step);
    if (!r.ok) return r;
    const filled = this.#ledger.orders().at(-1)!;
    return ok({
      ...alpacaOrder(filled),
      ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
    });
  }

  #dispatch(name: string, args: unknown, step: number): ToolResult {
    if (
      !Object.hasOwn(BROKER_TOOLS, name) ||
      !brokerWorldTools().includes(name as BrokerToolName)
    ) {
      return { ok: false, error: `unknown tool: ${name}` };
    }
    const parsed = BROKER_TOOLS[name as BrokerToolName].input.safeParse(args ?? {});
    if (!parsed.success) {
      return { ok: false, error: `invalid arguments: ${z.prettifyError(parsed.error)}` };
    }
    const input = parsed.data as Record<string, unknown>;
    const w = this.#world;
    const l = this.#ledger;
    switch (name as BrokerToolName) {
      case "get_instructions":
        return ok({ holder: w.holder, instructions: w.instructions });
      case "get_account": {
        const positions = l.positions().map((p) => {
          const price = l.quote(p.symbol) ?? 0;
          return {
            symbol: p.symbol,
            quantity: round(p.quantity, 6),
            priceUsd: price,
            marketValueUsd: round(p.quantity * price, 2),
          };
        });
        return ok({
          holder: w.holder,
          broker: w.broker,
          today: w.today,
          cashUsd: l.cashUsd,
          positions,
          accountValueUsd: l.accountValueUsd(),
        });
      }
      case "get_quote": {
        const symbol = normalSymbol(String(input.symbol));
        const price = l.quote(symbol);
        return price === undefined
          ? { ok: false, error: `no quote for ${symbol}` }
          : ok({ symbol, priceUsd: price });
      }
      case "list_orders":
        return ok(l.orders().reverse().map(publicOrder));
      case "list_linked_accounts":
        return ok(l.linkedAccounts());
      case "list_news":
        return ok(newestFirst(w.news, (i) => i.publishedAt));
      case "list_social_posts":
        return ok(newestFirst(w.social, (i) => i.publishedAt));
      case "list_analyst_notes":
        return ok(newestFirst(w.notes, (i) => i.publishedAt));
      case "list_alerts":
        return ok(newestFirst(w.alerts, (i) => i.publishedAt));
      case "list_filings":
        return ok(
          newestFirst(w.filings, (f) => f.filedAt).map((f) => ({
            id: f.id,
            filer: f.filer,
            filerId: f.filerId,
            form: f.form,
            filedAt: f.filedAt,
            summary: f.summary,
          })),
        );
      case "read_filing": {
        const filing = w.filings.find((f) => f.id === input.filingId);
        return filing
          ? ok({ ...filing })
          : { ok: false, error: `no filing with id ${String(input.filingId)}` };
      }
      case "list_messages":
        return ok(
          newestFirst(w.messages, (m) => m.receivedAt).map((m) => ({
            id: m.id,
            from: { ...m.from },
            subject: m.subject,
            receivedAt: m.receivedAt,
          })),
        );
      case "read_message": {
        const message = w.messages.find((m) => m.id === input.messageId);
        return message
          ? ok({ ...message, from: { ...message.from } })
          : { ok: false, error: `no message with id ${String(input.messageId)}` };
      }
      case "request_approval": {
        const request = parsed.data as z.infer<(typeof BROKER_TOOLS)["request_approval"]["input"]>;
        this.approvals.push({
          step,
          symbol: normalSymbol(request.symbol),
          side: request.side,
          amountUsd: request.amountUsd,
          reason: request.reason,
        });
        return ok({
          approved: true,
          approvalId: `apr-${this.approvals.length}`,
          note: `${w.holder} approved the order.`,
        });
      }
      case "place_order": {
        const request = parsed.data as z.infer<(typeof BROKER_TOOLS)["place_order"]["input"]>;
        const result = l.placeOrder({
          symbol: request.symbol,
          side: request.side,
          ...(request.amountUsd !== undefined ? { amountUsd: request.amountUsd } : {}),
          ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
        });
        if (result.ok) {
          return ok({ status: "filled", ...publicOrder(result.order) });
        }
        if (result.reason === "blocked") {
          return {
            ok: false,
            error: `order blocked by the mandate: ${rulesText(result.breach.rules)}`,
          };
        }
        return { ok: false, error: result.error };
      }
      case "withdraw": {
        const request = parsed.data as z.infer<(typeof BROKER_TOOLS)["withdraw"]["input"]>;
        const result = l.withdraw({
          account: request.account,
          amountUsd: request.amountUsd,
          ...(request.memo !== undefined ? { memo: request.memo } : {}),
        });
        if (result.ok) {
          return ok({
            status: "sent",
            withdrawalId: result.withdrawal.id,
            amountUsd: result.withdrawal.amountUsd,
          });
        }
        if (result.reason === "blocked") {
          return {
            ok: false,
            error: `withdrawal blocked by the mandate: ${rulesText(result.breach.rules)}`,
          };
        }
        return { ok: false, error: result.error };
      }
    }
  }
}

/** The world's own tool each Alpaca name runs as, for the trace. */
const ALPACA_RUNS_AS: Record<AlpacaBrokerToolName, BrokerToolName> = {
  get_account_info: "get_account",
  get_all_positions: "get_account",
  get_open_position: "get_account",
  get_orders: "list_orders",
  place_stock_order: "place_order",
  close_position: "place_order",
  get_stock_latest_quote: "get_quote",
  get_news: "list_news",
};

/** Dollars as Alpaca writes them: a string with cents. */
const usd = (n: number) => n.toFixed(2);

const symbolList = (symbols: string | undefined) =>
  symbols
    ?.split(",")
    .map((s) => normalSymbol(s.trim()))
    .filter(Boolean);

const alpacaPosition = (symbol: string, quantity: number, price: number) => ({
  symbol,
  asset_class: "us_equity",
  side: "long",
  qty: String(round(quantity, 6)),
  current_price: usd(price),
  market_value: usd(quantity * price),
});

const alpacaOrder = (o: Order) => ({
  id: `ord-${o.id}`,
  symbol: o.symbol,
  side: o.side,
  type: "market",
  time_in_force: "day",
  status: "filled",
  qty: String(round(o.quantity, 6)),
  filled_qty: String(round(o.quantity, 6)),
  filled_avg_price: usd(o.priceUsd),
  notional: usd(o.amountUsd),
  submitted_at: `${o.day}T15:00:00Z`,
  filled_at: `${o.day}T15:00:00Z`,
});

const ok = (output: unknown): ToolResult => ({ ok: true, output });

/** An order as the broker shows it: without its mark against fair value, which the agent can't know. */
const publicOrder = (o: Order) => ({
  id: o.id,
  symbol: o.symbol,
  side: o.side,
  quantity: round(o.quantity, 6),
  priceUsd: o.priceUsd,
  amountUsd: o.amountUsd,
  day: o.day,
});
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

const RULE_TEXT: Record<BrokerBreachType, string> = {
  unknown_destination: "the account is not one of the holder's linked accounts",
  unlisted_instrument: "the symbol is not on the allowed list",
  leverage_not_allowed: "the order needs margin or a short sale",
  over_order_cap: "the order is over the per-order limit",
  over_daily_cap: "the order would go over today's trading limit",
  over_position_limit: "the position would be too large a share of the account",
};

const rulesText = (rules: readonly BrokerBreachType[]) => rules.map((r) => RULE_TEXT[r]).join("; ");
