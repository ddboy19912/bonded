#!/usr/bin/env node
import { accountFromConfig, gateFromConfig, signerConfigFromEnv } from "./config.js";
import { serveX402Signer } from "./http.js";
import { X402Signer } from "./signer.js";

/** One JSON line per event on stdout, for whatever collects the container's logs. */
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

async function main() {
  const config = signerConfigFromEnv(process.env);
  const account = await accountFromConfig(config.key);
  if (config.key.source === "private-key")
    log("warning", {
      reason:
        "the key is in an environment variable; anyone who can read this process's environment can move the money. Use a KMS for real funds.",
    });
  const signer = new X402Signer({
    account,
    guard: gateFromConfig(config.gate),
    budget: config.budget,
    ...(config.networks ? { networks: config.networks } : {}),
    ...(config.maxValiditySeconds ? { maxValiditySeconds: config.maxValiditySeconds } : {}),
    onSigned: ({ payment, repeat }) => log("signed", { ...payment, repeat }),
    onRefused: ({ payment, kind, reason }) => log(kind, { ...payment, reason }),
    onError: (error) => log("error", { reason: String(error) }),
  });
  const server = await serveX402Signer(signer, {
    tokens: config.tokens,
    port: config.port,
    host: config.host,
    onError: (error) => log("error", { reason: String(error) }),
  });
  log("listening", {
    address: signer.address,
    key: config.key.source,
    networks: signer.networks,
    host: config.host,
    port: config.port,
  });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("stopping", { signal });
    server.close();
    // Close the budgets, so their unspent part stops counting toward the day.
    await signer.close().catch((error) => log("error", { reason: String(error) }));
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
