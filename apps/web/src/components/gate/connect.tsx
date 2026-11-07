import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Badge } from "@/components/shadcn/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/shadcn/tabs";
import { Table, TableBody, TableCell, TableRow } from "@/components/shadcn/table";
import { apiUrl } from "../../config";
import { ago, short } from "../../lib/format";
import { gateApi, type GateAccount } from "../../lib/gate";
import { CodeBlock } from "../code-block";
import { Loading, Unavailable, linkClass } from "../ui";
import { CARD_PROVIDERS } from "./cards";
import { ChainLogo, ModalButton } from "./common";

const SDK = `import { guardPayments, paymentGate } from "@bondedhq/sdk";

const gate = paymentGate({ apiKey: process.env.BONDED_GATE_KEY! });
const pay = guardPayments(bank.pay, { guard: gate });

await pay({ account: "LT12 1000 0111 0100 1000", amountUsd: 612.4, invoiceReference: "NIM-88412" });`;

const MCP = `import { paymentGate } from "@bondedhq/sdk";
import { guardMcpPayHandler } from "@bondedhq/sdk/mcp";

const gate = paymentGate({ apiKey: process.env.BONDED_GATE_KEY! });

server.registerTool("pay", config, guardMcpPayHandler(pay, { guard: gate }));`;

const API = `curl ${apiUrl}/payments/check \\
  -H "Authorization: Bearer $BONDED_GATE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"account":"LT12 1000 0111 0100 1000","amountUsd":612.40,"invoiceReference":"NIM-88412"}'`;

const LOG = `curl ${apiUrl}/payments/watched \\
  -H "Authorization: Bearer $BONDED_GATE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"payments":[{"id":"pay-001","account":"LT12 1000 0111 0100 1000","amountUsd":612.40,"paidAt":"2026-11-07T10:00:00Z"}]}'`;

const DAY = 86_400_000;
/** The keeper reads wallets every 30 seconds: ten minutes means it has fallen behind. */
const WALLET_BEHIND = 10 * 60_000;

/** How many show before "Show all". */
const SHOWN = 5;

interface Row {
  id: string;
  name: string;
  what: string;
  at: string | null;
  liveFor: number;
  never: string;
  stale: string;
  chainId?: number;
}

const isLive = (r: Row) => r.at !== null && Date.now() - Date.parse(r.at) < r.liveFor;
/** What needs a look goes first: stale, then never used, then live. */
const rank = (r: Row) => (isLive(r) ? 2 : r.at ? 0 : 1);

/** One thing that reports to the account: its name, whether it's live, and when it last did. */
function Connection({ row }: { row: Row }) {
  const live = isLive(row);
  return (
    <TableRow>
      <TableCell className="max-w-0 whitespace-normal">
        <span className="flex items-center gap-2">
          <ChainLogo chainId={row.chainId} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{row.name}</span>
            <span className="block truncate text-xs text-muted">{row.what}</span>
          </span>
        </span>
      </TableCell>
      <TableCell className="w-24">
        <Badge variant={live ? "safe" : row.at ? "warn" : "outline"}>
          {live ? "Live" : row.at ? row.stale : row.never}
        </Badge>
      </TableCell>
      <TableCell className="w-20 text-right text-muted">{row.at ? ago(row.at) : "Never"}</TableCell>
    </TableRow>
  );
}

function ConnectionList({ rows }: { rows: Row[] }) {
  return (
    <Table className="table-fixed">
      <TableBody>
        {rows.map((r) => (
          <Connection key={r.id} row={r} />
        ))}
      </TableBody>
    </Table>
  );
}

/** What's connected to the account, and when each last reported. */
function Connections({ account, session }: { account: GateAccount; session: string }) {
  const connections = useQuery({
    queryKey: ["gate-connections", session, account.id],
    queryFn: () => gateApi.connections(session, account.id),
    retry: false,
    refetchInterval: 30_000,
  });
  if (connections.error)
    return <Unavailable error={connections.error} onRetry={() => void connections.refetch()} />;
  if (!connections.data) return <Loading what="your connections" />;
  const { keys, wallets, log, cardHooks = [] } = connections.data;
  const rows: Row[] = [
    ...keys.map((k) => ({
      id: k.id,
      name: k.label || "API key",
      what: "Asks first",
      at: k.lastUsedAt,
      liveFor: DAY,
      never: "Not used yet",
      stale: "Quiet",
    })),
    ...wallets.map((w) => ({
      id: w.id,
      name: w.label || short(w.address, 6),
      what: `Watch · ${w.chain} wallet`,
      at: w.lastReadAt,
      liveFor: WALLET_BEHIND,
      never: "Not read yet",
      stale: "Behind",
      chainId: w.chainId,
    })),
    ...cardHooks.map((h) => ({
      id: h.id,
      name: h.label || CARD_PROVIDERS[h.provider],
      what: `Cards · ${CARD_PROVIDERS[h.provider]}`,
      at: h.lastRequestAt,
      liveFor: DAY,
      never: "Not asked yet",
      stale: "Quiet",
    })),
    ...(log.lastReportedAt
      ? [
          {
            id: "log",
            name: "Payment log",
            what: "Watch",
            at: log.lastReportedAt,
            liveFor: DAY,
            never: "Not used yet",
            stale: "Quiet",
          },
        ]
      : []),
  ].sort((a, b) => rank(a) - rank(b));
  return (
    <section aria-label="Connections" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Connections</h2>
      <ConnectionList rows={rows.slice(0, SHOWN)} />
      {rows.length > SHOWN && (
        <div>
          <ModalButton
            label={`Show all ${rows.length}`}
            variant="link"
            size="sm"
            className="px-0"
            title="Connections"
            description="What needs a look comes first."
            wide
          >
            {() => <ConnectionList rows={rows} />}
          </ModalButton>
        </div>
      )}
    </section>
  );
}

/** How to connect an agent, and what's connected now. */
export function Connect({ account, session }: { account: GateAccount; session: string }) {
  return (
    <div className="grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-8">
        <section aria-label="Ask first" className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-semibold">Ask first</h2>
            <p className="mt-1 text-sm text-muted">
              Your code asks Bonded before each payment. This is the only way to stop one.
            </p>
          </div>
          <Tabs defaultValue="sdk" className="min-w-0 gap-3">
            <TabsList>
              <TabsTrigger value="sdk">SDK</TabsTrigger>
              <TabsTrigger value="mcp">MCP</TabsTrigger>
              <TabsTrigger value="api">API</TabsTrigger>
            </TabsList>
            <TabsContent value="sdk">
              <CodeBlock code={SDK} language="ts" label="SDK" />
            </TabsContent>
            <TabsContent value="mcp">
              <CodeBlock code={MCP} language="ts" label="MCP server" />
            </TabsContent>
            <TabsContent value="api">
              <CodeBlock code={API} language="bash" label="API" />
            </TabsContent>
          </Tabs>
          <p className="text-xs text-muted">
            Your key is on the{" "}
            <Link className={linkClass} to="?tab=keys">
              API keys
            </Link>{" "}
            tab. Keep it on your server, and keep your own pay function away from the agent.
          </p>
        </section>
        <section aria-label="Cards" className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-semibold">Cards</h2>
            <p className="mt-1 text-sm text-muted">
              Your card provider asks Bonded before each charge, and a charge that breaks a rule is
              declined. Bonded holds no key.
            </p>
          </div>
          <p className="text-sm">
            Connect Stripe Issuing, Lithic or Marqeta on the{" "}
            <Link className={linkClass} to="?tab=cards">
              Cards
            </Link>{" "}
            tab.
          </p>
        </section>
        <section aria-label="Watch" className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-semibold">Watch</h2>
            <p className="mt-1 text-sm text-muted">
              Bonded reads payments after they're made, and alerts you. It can't stop them.
            </p>
          </div>
          <p className="text-sm">
            Add a public wallet on the{" "}
            <Link className={linkClass} to="?tab=watch">
              Watch
            </Link>{" "}
            tab, or send your payment log:
          </p>
          <CodeBlock code={LOG} language="bash" label="Payment log" />
        </section>
      </div>
      <Connections account={account} session={session} />
    </div>
  );
}
