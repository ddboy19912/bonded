import { createHash } from "node:crypto";
import { DstackClient } from "@phala/dstack-sdk";

/**
 * What the proxy needs from the TEE runtime: two keys derived inside it and a quote. The real
 * one talks to dstack's guest agent; `MockBackend` stands in on a laptop and can never produce a
 * quote the gate API accepts as a TEE.
 */
export interface TeeBackend {
  readonly name: "dstack" | "mock";
  /** 32 bytes for the proxy's secp256k1 key: it signs answers and vouches for the seal key. */
  evmKey(): Promise<Uint8Array>;
  /** 32 bytes the P-256 seal key is made from. Credentials are sealed to it. */
  sealSeed(): Promise<Uint8Array>;
  /** An Intel TDX quote whose report data is `reportData` (up to 64 bytes). */
  quote(reportData: Uint8Array): Promise<{ quote: string; eventLog: string }>;
  /** Hash of the app-compose file this app was deployed from. */
  composeHash(): Promise<string>;
}

/** Key derivation paths. Changing one changes the proxy's keys, so they are fixed here. */
export const EVM_KEY_PATH = ["bonded/payout-proxy/v1", "evm"] as const;
export const SEAL_KEY_PATH = ["bonded/payout-proxy/v1", "seal"] as const;

/**
 * dstack's guest agent over its socket inside the CVM. Keys are derived from the app's identity,
 * so the same deployment gets the same keys after a restart (and a sealed credential still opens),
 * and no other app can derive them.
 */
export class DstackBackend implements TeeBackend {
  readonly name = "dstack" as const;
  constructor(private readonly client: DstackClient = new DstackClient()) {}

  async evmKey(): Promise<Uint8Array> {
    return (await this.client.getKey(...EVM_KEY_PATH, "secp256k1")).key;
  }

  async sealSeed(): Promise<Uint8Array> {
    return (await this.client.getKey(...SEAL_KEY_PATH, "secp256k1")).key;
  }

  async quote(reportData: Uint8Array): Promise<{ quote: string; eventLog: string }> {
    const result = await this.client.getQuote(reportData);
    return { quote: result.quote, eventLog: result.event_log };
  }

  async composeHash(): Promise<string> {
    return (await this.client.info()).compose_hash;
  }
}

/**
 * For local development and tests. Its keys come from a public label and its "quote" is only the
 * report data, so the gate API's verifier refuses it: a mock proxy is never treated as a TEE.
 */
export class MockBackend implements TeeBackend {
  readonly name = "mock" as const;
  constructor(private readonly label = "bonded-mock-payout-proxy") {}
  private seed = (what: string) =>
    new Uint8Array(createHash("sha256").update(`${this.label}:${what}`).digest());

  async evmKey(): Promise<Uint8Array> {
    return this.seed("evm");
  }

  async sealSeed(): Promise<Uint8Array> {
    return this.seed("seal");
  }

  async quote(reportData: Uint8Array): Promise<{ quote: string; eventLog: string }> {
    return { quote: Buffer.from(reportData).toString("hex"), eventLog: "[]" };
  }

  async composeHash(): Promise<string> {
    return "00".repeat(32);
  }
}
