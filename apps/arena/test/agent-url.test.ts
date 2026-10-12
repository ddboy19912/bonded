import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  type AgentUrlMessage,
  agentUrlCodeHash,
  AgentUrlReplayGuard,
  answerAgentUrlVerify,
  verifyAgentUrlRequest,
} from "@bondedhq/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentUrlClient,
  ArenaGateway,
  registrableDomain,
  StaticRunnerTokens,
  verifyAgentUrl,
} from "../src/index.js";

// Lets a test make a public-looking name resolve to an internal address (DNS rebinding).
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  const lookup = (hostname: string, options: unknown, callback: unknown) => {
    const answer = callback as (e: Error | null, a: { address: string; family: number }[]) => void;
    if (hostname === "rebind.example") return answer(null, [{ address: "10.0.0.7", family: 4 }]);
    if (hostname === "nxdomain.example")
      return answer(Object.assign(new Error("not found"), { code: "ENOTFOUND" }), []);
    // Deterministic: localhost is 127.0.0.1 alone.
    if (hostname === "localhost") return answer(null, [{ address: "127.0.0.1", family: 4 }]);
    return (actual.lookup as (...a: unknown[]) => void)(hostname, options, callback);
  };
  return { ...actual, lookup };
});

const SECRET = "bonded_as_unit-test-secret-000000000000";
const servers: Server[] = [];
const timers: NodeJS.Timeout[] = [];
afterEach(() => {
  for (const t of timers.splice(0)) clearInterval(t);
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

/** An agent URL on this machine; `handler` sees each call with its raw body. */
async function agent(handler: Handler): Promise<{ url: string; calls: AgentUrlMessage[] }> {
  const calls: AgentUrlMessage[] = [];
  const replay = new AgentUrlReplayGuard();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      void verifyAgentUrlRequest({ secret: SECRET, body, headers: req.headers, replay }).then(
        (checked) => {
          if (checked.ok) calls.push(checked.message);
          handler(req, res, checked.ok ? body : "");
        },
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/agent`, calls };
}

const local = (limits = {}) => new AgentUrlClient({ allowLoopback: true, limits });
const NOT_PUBLIC =
  "Your URL's host isn't reachable on the public internet: it must resolve to a public address";
const RATE_LIMITED = "Bonded has called your URL too often in the last minute; try again shortly";

/** An agent that answers verify properly, with the proof. */
const proving: Handler = (_req, res, body) => {
  const message = body ? (JSON.parse(body) as AgentUrlMessage) : undefined;
  if (message?.type !== "verify") return void res.writeHead(204).end();
  void answerAgentUrlVerify(SECRET, message, "v1.4.2").then((answer) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer));
  });
};

describe("which URLs an agent may register", () => {
  const strict = new AgentUrlClient();
  it("must be public https", () => {
    expect(strict.urlProblem("https://agent.example.com/bonded")).toBeUndefined();
    expect(strict.urlProblem("http://agent.example.com/bonded")).toBe("Your URL must use https");
    expect(strict.urlProblem("ftp://agent.example.com")).toBe("Your URL must use https");
    expect(strict.urlProblem("not a url")).toBe("That isn't a URL");
    expect(strict.urlProblem("https://user:pw@agent.example.com")).toMatch(/user name/);
    for (const url of [
      "https://127.0.0.1/",
      "https://10.0.0.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/",
      "https://[fd00::1]/",
      "https://localhost/",
      "https://localhost./",
      // Names that only exist inside a network, refused before any lookup.
      "https://broadcasthost/",
      "https://printer.local/",
      "https://db.railway.internal/",
      "https://metadata.google.internal/",
      "https://router.home.arpa/",
      "https://x.localhost/",
      "https://nothing.invalid/",
    ])
      expect(strict.urlProblem(url), url).toBe(NOT_PUBLIC);
  });

  it("must use port 443 (any port only on this machine, for a local rating)", () => {
    expect(strict.urlProblem("https://agent.example.com:443/")).toBeUndefined();
    for (const port of [22, 81, 8443, 6379])
      expect(strict.urlProblem(`https://agent.example.com:${port}/`)).toBe(
        "Your URL must use the standard https port (443)",
      );
    expect(local().urlProblem("http://127.0.0.1:3000/")).toBeUndefined();
    expect(local().urlProblem("https://agent.example.com:8443/")).toMatch(/port \(443\)/);
  });

  it("can't be one of Bonded's own hosts or the gateway itself", async () => {
    for (const url of [
      "https://bonded-nu.vercel.app/api",
      "https://www.bondedhq.xyz/api",
      "https://BONDEDHQ.xyz./",
      "https://api-production-ba50.up.railway.app/x",
      "https://x.arena-worker-production.up.railway.app/",
      "https://BONDED-NU.vercel.app./",
    ])
      expect(strict.urlProblem(url), url).toBe("Your URL is one of Bonded's own addresses");
    // Other Railway and Vercel apps are fine.
    expect(strict.urlProblem("https://my-agent.up.railway.app/")).toBeUndefined();
    const extra = new AgentUrlClient({ refusedHosts: ["bonded.example"] });
    expect(extra.urlProblem("https://api.bonded.example/")).toMatch(/Bonded's own/);

    const gateway = new ArenaGateway({
      tokens: new StaticRunnerTokens(),
      publicUrl: "https://gateway.bonded.test",
      agentUrl: { allowLoopback: true },
    });
    expect(gateway.agentUrls.urlProblem("https://gateway.bonded.test/e/x/done")).toMatch(
      /Bonded's own/,
    );
    const localGateway = new ArenaGateway({
      tokens: new StaticRunnerTokens(),
      agentUrl: { allowLoopback: true },
    });
    const base = await localGateway.listen();
    try {
      expect(localGateway.agentUrls.urlProblem(`${base}/healthz`)).toMatch(/Bonded's own/);
      // A different port on the same machine is another service (a local agent).
      expect(localGateway.agentUrls.urlProblem("http://127.0.0.1:1/agent")).toBeUndefined();
    } finally {
      await localGateway.close();
    }
  });

  it("refuses a name that resolves to an internal address, when it connects, in the same words as one that doesn't resolve", async () => {
    const logged: string[] = [];
    const client = new AgentUrlClient({ log: (line) => logged.push(line) });
    const cancel = { type: "cancel", episodeId: "e" } as const;
    const rebind = await client.send("https://rebind.example/agent", SECRET, cancel);
    const missing = await client.send("https://nxdomain.example/agent", SECRET, cancel);
    expect(rebind).toEqual({ ok: false, problem: NOT_PUBLIC, caused: "agent" });
    expect(missing).toEqual(rebind);
    // The detail stays on the server, without the secret.
    expect(logged.join("\n")).toMatch(/nxdomain\.example failed: ENOTFOUND/);
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("knows the site a host belongs to", () => {
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("Example.COM.")).toBe("example.com");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("my-agent.up.railway.app")).toBe("my-agent.up.railway.app");
    expect(registrableDomain("x.my-agent.vercel.app")).toBe("my-agent.vercel.app");
    expect(registrableDomain("93.184.216.34")).toBe("93.184.216.34");
  });
});

describe("calling an agent URL", () => {
  it("signs every call so the agent can verify it, and verify returns the version", async () => {
    const { url, calls } = await agent((req, res, body) =>
      body ? proving(req, res, body) : void res.writeHead(401).end(),
    );
    const result = await verifyAgentUrl(url, SECRET, { allowLoopback: true });
    expect(result).toEqual({ ok: true, version: "v1.4.2", codeHash: agentUrlCodeHash("v1.4.2") });
    expect(calls).toHaveLength(1);
    // With the wrong secret the agent refuses it, and the sentence says why.
    expect(
      await verifyAgentUrl(url, "bonded_as_wrong-secret-000000000000000", { allowLoopback: true }),
    ).toEqual({
      ok: false,
      problem: "Your URL answered 401: check that your agent uses the agent secret Bonded gave you",
    });
  });

  it("requires proof of the secret, so an echo server can't pass", async () => {
    // The review's proof of concept: a server that echoes the body knows no secret.
    const echo = await agent((_req, res, body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    const proofless = await agent((_req, res, body) => {
      const message = JSON.parse(body) as { challenge: string };
      res.end(JSON.stringify({ challenge: message.challenge, proof: "ab".repeat(32) }));
    });
    for (const url of [echo.url, proofless.url])
      expect(await verifyAgentUrl(url, SECRET, { allowLoopback: true })).toMatchObject({
        ok: false,
        problem: expect.stringMatching(/without proving it holds the agent secret/),
      });
    const text = await agent((_req, res) => res.end("hello"));
    expect(await verifyAgentUrl(text.url, SECRET, { allowLoopback: true })).toMatchObject({
      ok: false,
      problem: "Your URL answered the check, but not with JSON",
    });
    const accepted = await agent((_req, res) => res.writeHead(202).end());
    expect(await verifyAgentUrl(accepted.url, SECRET, { allowLoopback: true })).toMatchObject({
      ok: false,
      problem: "Your URL answered 202 to the check; it must be 200",
    });
  });

  it("doesn't follow a redirect", async () => {
    let hit = false;
    const inside = await agent((_req, res) => {
      hit = true;
      res.end("{}");
    });
    const redirect = await agent((_req, res) => res.writeHead(307, { location: inside.url }).end());
    const call = await local().send(redirect.url, SECRET, { type: "cancel", episodeId: "e" });
    expect(call).toMatchObject({
      ok: false,
      problem:
        "Your URL answered with a redirect; Bonded doesn't follow redirects, so give the final URL",
    });
    expect(hit).toBe(false);
  });

  it("holds every call to one deadline: a URL that never answers, or dribbles", async () => {
    const client = local({ answerMs: 300 });
    const silent = await agent(() => {});
    let start = Date.now();
    expect(await client.send(silent.url, SECRET, { type: "cancel", episodeId: "e" })).toEqual({
      ok: false,
      problem: "Your URL didn't answer within 0.3 seconds",
      caused: "agent",
    });
    expect(Date.now() - start).toBeLessThan(1_500);
    const dribble = await agent((_req, res) => {
      res.writeHead(200);
      const drip = setInterval(() => res.write(" "), 40);
      timers.push(drip);
      res.on("close", () => clearInterval(drip));
    });
    start = Date.now();
    const call = await client.send(dribble.url, SECRET, { type: "cancel", episodeId: "e" });
    expect(call.ok === false && call.problem).toMatch(/didn't answer within/);
    expect(Date.now() - start).toBeLessThan(1_500);
  });

  it("reads at most 64 KiB of an answer", async () => {
    const big = await agent((_req, res) => res.end("x".repeat(100 * 1024)));
    expect(await local().send(big.url, SECRET, { type: "cancel", episodeId: "e" })).toMatchObject({
      ok: false,
      problem: "Your URL's answer was over 64 KiB",
    });
  });

  it("says what a non-2xx answer or a closed port was", async () => {
    const missing = await agent((_req, res) => res.writeHead(404).end());
    expect(await local().send(missing.url, SECRET, { type: "cancel", episodeId: "e" })).toEqual({
      ok: false,
      problem: "Your URL answered 404",
      status: 404,
      caused: "agent",
    });
    expect(
      await local().send("http://127.0.0.1:1/agent", SECRET, { type: "cancel", episodeId: "e" }),
    ).toMatchObject({ ok: false, problem: "Nothing accepted a connection at your URL" });
  });

  it("limits episode calls per registration, so one operator can't use up another's", async () => {
    const ok = await agent((_req, res) => res.writeHead(204).end());
    const client = local({ callsPerMinute: 2, callBurst: 2 });
    const cancel = (episodeId: string) => ({ type: "cancel", episodeId }) as const;
    const as = (registration: string) => ({ registration });
    expect((await client.send(ok.url, SECRET, cancel("e1"), as("noisy"))).ok).toBe(true);
    expect((await client.send(`${ok.url}?x`, SECRET, cancel("e2"), as("noisy"))).ok).toBe(true);
    expect(await client.send(ok.url, SECRET, cancel("e3"), as("noisy"))).toEqual({
      ok: false,
      problem: RATE_LIMITED,
      caused: "bonded",
    });
    // Another agent on the same host still gets its calls.
    expect((await client.send(ok.url, SECRET, cancel("e4"), as("victim"))).ok).toBe(true);
    expect(ok.calls).toHaveLength(3);
  });

  it("limits verify calls by host name (trailing dot or not), domain and resolved address", async () => {
    const ok = await agent(proving);
    const port = new URL(ok.url).port;
    const client = local({ verifiesPerMinute: 1, verifyBurst: 1 });
    expect((await client.verify(`http://localhost:${port}/`, SECRET)).ok).toBe(true);
    // The same host with a trailing dot is the same bucket.
    expect(await client.verify(`http://localhost.:${port}/`, SECRET)).toEqual({
      ok: false,
      problem: RATE_LIMITED,
    });
    // Another name for the same address: refused at connect time by the address's bucket.
    expect(await client.verify(`http://127.0.0.1:${port}/`, SECRET)).toEqual({
      ok: false,
      problem: RATE_LIMITED,
    });
    expect(ok.calls).toHaveLength(1);
  });

  it("drops the longest-idle buckets first, not the oldest", async () => {
    const ok = await agent((_req, res) => res.writeHead(204).end());
    const client = local({ callsPerMinute: 0.001, callBurst: 1, maxBuckets: 2 });
    const send = (registration: string, id: string) =>
      client.send(ok.url, SECRET, { type: "cancel", episodeId: id }, { registration });
    expect((await send("a", "1")).ok).toBe(true);
    expect((await send("b", "2")).ok).toBe(true);
    // "a" is used again (refused), so it is the most recent; a third bucket drops "b".
    expect((await send("a", "3")).ok).toBe(false);
    expect((await send("c", "4")).ok).toBe(true);
    // "a" is still remembered as spent: re-registering buckets can't reset it.
    expect((await send("a", "5")).ok).toBe(false);
  });

  it("gives a registration one episode at a time, whatever URL it uses", async () => {
    const client = local();
    const release = await client.acquire("agent:1", "ep-1", 0);
    await expect(client.acquire("agent:1", "ep-2", 150)).rejects.toThrow(
      /still busy with episode ep-1/,
    );
    const other = await client.acquire("agent:2", "ep-3", 0);
    release();
    other();
    (await client.acquire("agent:1", "ep-2", 0))();
  });
});
