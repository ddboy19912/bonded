import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestationMessage as solanaMessage } from "@bondedhq/solana";
import { bondedRegistryAbi, MODEL_FAMILY_CODE } from "@bondedhq/shared";
import { encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import { expect, it } from "vitest";
import { readLinks, registeredAgentId, toSolanaAttestation, writeLinks } from "../src/crosspost.js";

const home = {
  agentId: "2",
  score: 56,
  securityScore: 56,
  expectedLossBps: 415,
  reportHash: `0x${"2b".repeat(32)}`,
  mandateHash: `0x${"5a".repeat(32)}`,
  codeHash: `0x${"d4".repeat(32)}`,
  teeMeasurement: `0x${"00".repeat(32)}`,
  modelFamily: "deepseek",
  issuedAt: 1_790_603_796,
  expiresAt: 1_793_195_796,
} as const;

it("carries every field of the home score to Solana, under that chain's agent id", () => {
  const s = toSolanaAttestation(home, 7n);
  expect(s).toMatchObject({
    agentId: 7n,
    score: 56,
    expectedLossBps: 415,
    modelFamily: MODEL_FAMILY_CODE.deepseek,
    issuedAt: home.issuedAt,
    expiresAt: home.expiresAt,
  });
  expect(Buffer.from(s.reportHash).toString("hex")).toBe("2b".repeat(32));
  expect(Buffer.from(s.codeHash).toString("hex")).toBe("d4".repeat(32));
  // The message the Solana attester signs embeds the same hashes.
  expect(solanaMessage(s).includes(Buffer.from("5a".repeat(32), "hex"))).toBe(true);
});

it("reads and writes the agent-links file", () => {
  const dir = mkdtempSync(join(tmpdir(), "links-"));
  try {
    const path = join(dir, "links.json");
    writeLinks(
      [{ home: { chain: "robinhoodTestnet", agentId: "2" }, links: { solanaDevnet: "2" } }],
      path,
    );
    expect(readLinks(path)).toEqual([
      { home: { chain: "robinhoodTestnet", agentId: "2" }, links: { solanaDevnet: "2" } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const REGISTRY = "0x35F6d30BE731a639235CCAd7abEdda4d4BE8D4F9";
const registeredLog = (agentId: bigint, address: `0x${string}` = REGISTRY): Log =>
  ({
    address,
    topics: encodeEventTopics({
      abi: bondedRegistryAbi,
      eventName: "Registered",
      args: { agentId, owner: "0xd42FA5ae8949710479954ae78D1b12Ff2e50A841" },
    }),
    data: encodeAbiParameters([{ type: "string" }], ["bonded://robinhoodTestnet/agent/2"]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  }) as unknown as Log;

it("takes a new EVM agent's id from its own Registered event", () => {
  expect(registeredAgentId([registeredLog(5n)], REGISTRY)).toBe("5");
  // Another contract's event with the same shape doesn't count.
  const other = "0x0000000000000000000000000000000000000001";
  expect(registeredAgentId([registeredLog(9n, other), registeredLog(5n)], REGISTRY)).toBe("5");
  expect(() => registeredAgentId([], REGISTRY)).toThrow(/found 0/);
});
