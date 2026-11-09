import { paymentGate } from "@bondedhq/sdk";
import { type Address, type Hex, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { awsKms, digestSignerAccount, googleKms, keyFileAccount } from "./keys.js";
import type { TypedDataAccount, X402SignerOptions } from "./signer.js";

/** Where the key is. Exactly one of these environment variables must be set. */
export const KEY_SOURCES = [
  "BONDED_SIGNER_AWS_KMS_KEY_ID",
  "BONDED_SIGNER_GCP_KMS_KEY",
  "BONDED_SIGNER_KEY_FILE",
  "BONDED_SIGNER_PRIVATE_KEY",
] as const;

export interface SignerConfig {
  key:
    | { source: "aws-kms"; keyId: string; region?: string }
    | { source: "gcp-kms"; keyName: string }
    | { source: "key-file"; path: string }
    | { source: "private-key"; privateKey: Hex };
  gate: { apiKey: string; apiUrl?: string; receiptKey?: Address };
  tokens: string[];
  networks?: string[];
  maxValiditySeconds?: number;
  budget: NonNullable<X402SignerOptions["budget"]>;
  port: number;
  host: string;
}

/** Reads the signer's settings from environment variables. Throws with every problem at once. */
export function signerConfigFromEnv(env: Record<string, string | undefined>): SignerConfig {
  const problems: string[] = [];
  const get = (name: string) => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const number = (name: string, check: (n: number) => boolean, words: string) => {
    const raw = get(name);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || !check(n)) {
      problems.push(`${name} must be ${words}`);
      return undefined;
    }
    return n;
  };

  const sources = KEY_SOURCES.filter((name) => get(name));
  let key: SignerConfig["key"] | undefined;
  if (sources.length !== 1) {
    problems.push(`set exactly one of ${KEY_SOURCES.join(", ")} (found ${sources.length})`);
  } else if (sources[0] === "BONDED_SIGNER_AWS_KMS_KEY_ID") {
    const region = get("AWS_REGION");
    key = { source: "aws-kms", keyId: get(sources[0])!, ...(region ? { region } : {}) };
  } else if (sources[0] === "BONDED_SIGNER_GCP_KMS_KEY") {
    key = { source: "gcp-kms", keyName: get(sources[0])! };
  } else if (sources[0] === "BONDED_SIGNER_KEY_FILE") {
    key = { source: "key-file", path: get(sources[0])! };
  } else {
    const privateKey = get("BONDED_SIGNER_PRIVATE_KEY")!;
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey))
      problems.push("BONDED_SIGNER_PRIVATE_KEY must be 0x and 64 hex digits");
    else key = { source: "private-key", privateKey: privateKey as Hex };
  }

  const apiKey = get("BONDED_GATE_KEY");
  if (!apiKey) problems.push("BONDED_GATE_KEY is required: the gate account's API key");
  const receiptKey = get("BONDED_RECEIPT_KEY");
  if (receiptKey && !isAddress(receiptKey, { strict: false }))
    problems.push("BONDED_RECEIPT_KEY must be an address");
  const apiUrl = get("BONDED_API_URL");

  const tokens = (get("BONDED_SIGNER_TOKENS") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0)
    problems.push("BONDED_SIGNER_TOKENS is required: one or more tokens, comma separated");
  if (tokens.some((t) => t.length < 32))
    problems.push("each token in BONDED_SIGNER_TOKENS must be at least 32 characters");

  const networks = get("BONDED_SIGNER_NETWORKS")
    ?.split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const maxValiditySeconds = number(
    "BONDED_SIGNER_MAX_VALIDITY_SECONDS",
    (n) => Number.isInteger(n) && n >= 10 && n <= 86_400,
    "a whole number of seconds from 10 to 86,400",
  );
  const amountUsd = number("BONDED_BUDGET_USD", (n) => n > 0, "a positive number of dollars");
  const ttlSeconds = number(
    "BONDED_BUDGET_TTL_SECONDS",
    (n) => Number.isInteger(n) && n >= 60 && n <= 3600,
    "a whole number of seconds from 60 to 3,600",
  );
  const maxPaymentUsd = number(
    "BONDED_BUDGET_MAX_PAYMENT_USD",
    (n) => n > 0,
    "a positive number of dollars",
  );
  const port = number("PORT", (n) => Number.isInteger(n) && n > 0 && n < 65_536, "a port number");

  if (problems.length > 0 || !key || !apiKey)
    throw new Error(`the x402 signer's settings are wrong:\n- ${problems.join("\n- ")}`);
  return {
    key,
    gate: {
      apiKey,
      ...(apiUrl ? { apiUrl } : {}),
      ...(receiptKey ? { receiptKey: receiptKey as Address } : {}),
    },
    tokens,
    ...(networks?.length ? { networks } : {}),
    ...(maxValiditySeconds !== undefined ? { maxValiditySeconds } : {}),
    budget: {
      ...(amountUsd !== undefined ? { amountUsd } : {}),
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      ...(maxPaymentUsd !== undefined ? { maxPaymentUsd } : {}),
    },
    port: port ?? 8402,
    host: get("HOST") ?? "127.0.0.1",
  };
}

/** The signing account the settings point at. KMS keys stay in the KMS. */
export async function accountFromConfig(key: SignerConfig["key"]): Promise<TypedDataAccount> {
  switch (key.source) {
    case "aws-kms":
      return digestSignerAccount(
        await awsKms({ keyId: key.keyId, ...(key.region ? { region: key.region } : {}) }),
      );
    case "gcp-kms":
      return digestSignerAccount(await googleKms({ keyName: key.keyName }));
    case "key-file":
      return keyFileAccount(key.path);
    case "private-key":
      return privateKeyToAccount(key.privateKey);
  }
}

/** The hosted gate the settings point at. */
export function gateFromConfig(gate: SignerConfig["gate"]) {
  return paymentGate(gate);
}
