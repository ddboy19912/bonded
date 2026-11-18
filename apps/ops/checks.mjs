// Every check the ops dashboard runs. Each returns { group, name, status, value, detail, link }
// where status is "ok", "low", "down" or "manual". Keys come from the repo's .env and stay on
// this machine: the browser only ever sees the results.
import { createPublicClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const DEFAULTS = {
  apiUrl: "https://api-production-ba50.up.railway.app",
  webUrl: "https://www.bondedhq.xyz",
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com/address/",
  faucet: "https://faucet.testnet.chain.robinhood.com",
  minEth: 0.01,
  minOpenRouterUsd: 5,
};

// Wallets that pay gas. KEEPER_KEY matters most: if it runs dry, on-chain actions stop.
const WALLET_KEYS = [
  ["Keeper", "KEEPER_KEY"],
  ["Deployer", "DEPLOYER_PRIVATE_KEY"],
  ["Demo agent", "DEMO_AGENT_KEY"],
  ["Bounty hunter", "BOUNTY_HUNTER_PRIVATE_KEY"],
  ["Operator", "OPERATOR_KEY"],
  ["Agent", "AGENT_KEY"],
  ["User", "USER_KEY"],
  ["Attester", "ATTESTER_KEY"],
  ["Gate anchor", "GATE_ANCHOR_KEY"],
];

// Things with no API worth calling. Shown as reminders with a link.
const MANUAL = [
  {
    name: "Railway usage and plan",
    detail: "Runs the API, keeper and Arena worker",
    link: "https://railway.com/account/usage",
  },
  {
    name: "Phala Cloud credits",
    detail: "Runs the TEE agent",
    link: "https://cloud.phala.network/dashboard",
  },
  {
    name: "Vercel usage",
    detail: "Hosts the web app and blog",
    link: "https://vercel.com/dashboard",
  },
  {
    name: "GitHub billing",
    detail: "Actions are paused until this is fixed",
    link: "https://github.com/settings/billing",
  },
  {
    name: "UptimeRobot",
    detail: "Emails when the API's /health fails",
    link: "https://dashboard.uptimerobot.com/monitors",
  },
  {
    name: "Resend (email)",
    detail: "Sends alerts from notify.bondedhq.xyz",
    link: "https://resend.com/domains",
  },
  {
    name: "Domain bondedhq.xyz",
    detail: "Bought 2026-10-11. Renews around 2027-10-11. Keep auto-renew on",
    link: null,
  },
];

export function config(env = process.env) {
  return {
    apiUrl: env.OPS_API_URL || DEFAULTS.apiUrl,
    webUrl: env.OPS_WEB_URL || DEFAULTS.webUrl,
    rpcUrl: env.RPC_URL || DEFAULTS.rpcUrl,
    minEth: Number(env.OPS_MIN_ETH || DEFAULTS.minEth),
    minOpenRouterUsd: Number(env.OPS_MIN_OPENROUTER_USD || DEFAULTS.minOpenRouterUsd),
  };
}

/**
 * Extra wallets to watch by address alone (no key), for the ones Railway's services sign with
 * when their keys aren't in this machine's .env: `OPS_WATCH_ADDRESSES="Keeper (Railway)=0x...,
 * Attester (Railway)=0x..."`. Blank or malformed entries are skipped.
 */
export function watchedFromEnv(env = process.env) {
  const out = [];
  for (const part of (env.OPS_WATCH_ADDRESSES ?? "").split(",")) {
    const [label, address] = part.split("=").map((x) => x?.trim());
    if (label && address && /^0x[0-9a-fA-F]{40}$/.test(address)) out.push({ label, address });
  }
  return out;
}

/** The checks and previews waiting or running, from the API's /status. */
export function queueResult(body, link) {
  const lanes = Object.values(body.lanes ?? {});
  const running = lanes.reduce((n, lane) => n + (lane.running ?? 0), 0);
  const queued = lanes.reduce((n, lane) => n + (lane.queued ?? 0), 0);
  const oldest = Math.max(0, ...lanes.map((lane) => lane.oldestQueuedSeconds ?? 0));
  const stale = lanes.reduce((n, lane) => n + (lane.staleRunning ?? 0), 0);
  const stuck = stale > 0 || oldest > 30 * 60;
  return {
    group: "Services",
    name: "Test queue",
    status: stuck ? "low" : "ok",
    value: `${running} running, ${queued} waiting`,
    detail: stale
      ? `${stale} job(s) lost their worker`
      : queued
        ? `Oldest waiting ${Math.round(oldest / 60)} min${oldest > 30 * 60 ? " (over 30 min)" : ""}`
        : "Nothing waiting",
    link,
  };
}

export function grade(value, min) {
  return value >= min ? "ok" : "low";
}

// One entry per distinct address, so roles that share a key show once with every role named.
export function walletsFromEnv(env = process.env) {
  const byAddress = new Map();
  for (const [role, key] of WALLET_KEYS) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    let address;
    try {
      address = privateKeyToAccount(raw.startsWith("0x") ? raw : `0x${raw}`).address;
    } catch {
      continue;
    }
    const entry = byAddress.get(address) ?? { address, roles: [] };
    entry.roles.push(role);
    byAddress.set(address, entry);
  }
  return [...byAddress.values()];
}

async function fetchWithTimeout(url, init = {}, ms = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkApi(cfg) {
  const link = `${cfg.apiUrl}/status`;
  try {
    const res = await fetchWithTimeout(link);
    const body = await res.json();
    const lanes = Object.entries(body.lanes ?? {});
    const sick = lanes.filter(([, lane]) => !lane.healthy).map(([name]) => name);
    const results = [
      {
        group: "Services",
        name: "Bonded API",
        status: body.ok ? "ok" : "down",
        value: body.ok ? "Up" : "Not ok",
        detail: `Version ${body.version ?? "unknown"}`,
        link,
      },
      {
        group: "Services",
        name: "Arena gateway",
        status: body.gateway?.up ? "ok" : "down",
        value: body.gateway?.up ? "Up" : body.gateway?.configured ? "Down" : "Not configured",
        detail: sick.length
          ? `Unhealthy lanes: ${sick.join(", ")}`
          : `${lanes.length} lanes healthy`,
        link,
      },
      queueResult(body, link),
    ];
    return results;
  } catch (error) {
    return [
      {
        group: "Services",
        name: "Bonded API",
        status: "down",
        value: "Unreachable",
        detail: error.message,
        link,
      },
    ];
  }
}

async function checkPage(name, url) {
  try {
    const res = await fetchWithTimeout(url);
    return {
      group: "Services",
      name,
      status: res.ok ? "ok" : "down",
      value: res.ok ? "Up" : `HTTP ${res.status}`,
      detail: url,
      link: url,
    };
  } catch (error) {
    return {
      group: "Services",
      name,
      status: "down",
      value: "Unreachable",
      detail: error.message,
      link: url,
    };
  }
}

async function checkWallets(cfg, env) {
  const wallets = walletsFromEnv(env);
  for (const { label, address } of watchedFromEnv(env)) {
    const known = wallets.find((w) => w.address.toLowerCase() === address.toLowerCase());
    if (known) known.roles.push(label);
    else wallets.push({ address, roles: [label] });
  }
  if (wallets.length === 0) {
    return [
      {
        group: "Gas wallets (Robinhood testnet)",
        name: "No wallet keys in .env",
        status: "manual",
        value: "-",
        detail: "Add KEEPER_KEY and friends to .env",
        link: null,
      },
    ];
  }
  const client = createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 10_000 }) });
  return Promise.all(
    wallets.map(async ({ address, roles }) => {
      const base = {
        group: "Gas wallets (Robinhood testnet)",
        name: roles.join(", "),
        link: `${DEFAULTS.explorer}${address}`,
        address,
      };
      try {
        const eth = Number(formatEther(await client.getBalance({ address })));
        return {
          ...base,
          status: grade(eth, cfg.minEth),
          value: `${eth.toFixed(4)} ETH`,
          detail: `Alert below ${cfg.minEth} ETH`,
          faucet: DEFAULTS.faucet,
        };
      } catch (error) {
        return {
          ...base,
          status: "down",
          value: "RPC error",
          detail: error.shortMessage ?? error.message,
        };
      }
    }),
  );
}

async function checkOpenRouter(cfg, env) {
  const key = env.OPENROUTER_API_KEY?.trim();
  const base = {
    group: "Credits",
    name: "OpenRouter",
    link: "https://openrouter.ai/settings/credits",
  };
  if (!key)
    return { ...base, status: "manual", value: "-", detail: "OPENROUTER_API_KEY not set in .env" };
  try {
    const res = await fetchWithTimeout("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok)
      return {
        ...base,
        status: "down",
        value: `HTTP ${res.status}`,
        detail: "Key rejected or API down",
      };
    const { data } = await res.json();
    const left = data.total_credits - data.total_usage;
    return {
      ...base,
      status: grade(left, cfg.minOpenRouterUsd),
      value: `$${left.toFixed(2)} left`,
      detail: `$${data.total_usage.toFixed(2)} used of $${data.total_credits.toFixed(2)} · alert below $${cfg.minOpenRouterUsd}`,
    };
  } catch (error) {
    return { ...base, status: "down", value: "Unreachable", detail: error.message };
  }
}

export async function runChecks(env = process.env) {
  const cfg = config(env);
  const [api, web, blog, docs, wallets, openRouter] = await Promise.all([
    checkApi(cfg),
    checkPage("Web app", cfg.webUrl),
    checkPage("Blog", `${cfg.webUrl}/blog/`),
    checkPage("Docs", `${cfg.webUrl}/docs/`),
    checkWallets(cfg, env),
    checkOpenRouter(cfg, env),
  ]);
  const manual = MANUAL.map((item) => ({
    group: "Check by hand",
    status: "manual",
    value: "",
    ...item,
  }));
  return {
    checkedAt: new Date().toISOString(),
    results: [...api, web, blog, docs, ...wallets, openRouter, ...manual],
  };
}
