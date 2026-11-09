import { describe, expect, it } from "vitest";
import { signerConfigFromEnv } from "../src/config.js";

const TOKEN = "a".repeat(32);
const base = { BONDED_GATE_KEY: "bonded_gk_test", BONDED_SIGNER_TOKENS: TOKEN };

describe("signerConfigFromEnv", () => {
  it("reads a KMS key, the gate, tokens and budget settings", () => {
    const config = signerConfigFromEnv({
      ...base,
      BONDED_SIGNER_AWS_KMS_KEY_ID: "alias/agent",
      AWS_REGION: "eu-west-1",
      BONDED_SIGNER_TOKENS: `${TOKEN}, ${"b".repeat(32)}`,
      BONDED_SIGNER_NETWORKS: "eip155:8453",
      BONDED_SIGNER_MAX_VALIDITY_SECONDS: "300",
      BONDED_BUDGET_USD: "2",
      BONDED_BUDGET_TTL_SECONDS: "600",
      PORT: "9000",
      HOST: "0.0.0.0",
    });
    expect(config).toMatchObject({
      key: { source: "aws-kms", keyId: "alias/agent", region: "eu-west-1" },
      gate: { apiKey: "bonded_gk_test" },
      tokens: [TOKEN, "b".repeat(32)],
      networks: ["eip155:8453"],
      maxValiditySeconds: 300,
      budget: { amountUsd: 2, ttlSeconds: 600 },
      port: 9000,
      host: "0.0.0.0",
    });
  });

  it("defaults to this machine only, on port 8402", () => {
    const config = signerConfigFromEnv({ ...base, BONDED_SIGNER_KEY_FILE: "/run/secrets/key" });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8402);
    expect(config.budget).toEqual({});
  });

  it("needs exactly one key source", () => {
    expect(() => signerConfigFromEnv(base)).toThrow(/exactly one/);
    expect(() =>
      signerConfigFromEnv({
        ...base,
        BONDED_SIGNER_KEY_FILE: "/k",
        BONDED_SIGNER_GCP_KMS_KEY: "projects/p",
      }),
    ).toThrow(/exactly one/);
  });

  it("lists every problem at once", () => {
    let message = "";
    try {
      signerConfigFromEnv({
        BONDED_SIGNER_PRIVATE_KEY: "0x12",
        BONDED_SIGNER_TOKENS: "short",
        BONDED_BUDGET_TTL_SECONDS: "5",
        BONDED_RECEIPT_KEY: "nope",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const part of [
      "BONDED_SIGNER_PRIVATE_KEY",
      "BONDED_GATE_KEY",
      "at least 32",
      "BONDED_BUDGET_TTL_SECONDS",
      "BONDED_RECEIPT_KEY",
    ])
      expect(message).toContain(part);
  });
});
