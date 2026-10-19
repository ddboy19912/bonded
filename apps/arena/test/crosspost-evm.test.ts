import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { bondedRegistryAbi, attestationMessage, type Attestation } from "@bondedhq/shared";

import { encodeAbiParameters, encodeEventTopics } from "viem";

const rpc = vi.hoisted(() => ({
  readContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getLogs: vi.fn(),
  writeContract: vi.fn(),
}));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => rpc,
  createWalletClient: () => rpc,
}));
import { crosspostEvm } from "../src/crosspost.js";
import { ANVIL_KEYS } from "../src/sandbox.js";

const hash = `0x${"ab".repeat(32)}`;
const home: Attestation = {
  agentId: "2",
  score: 50,
  securityScore: 50,
  expectedLossBps: 485,
  reportHash: `0x${"11".repeat(32)}`,
  mandateHash: `0x${"22".repeat(32)}`,
  codeHash: `0x${"33".repeat(32)}`,
  teeMeasurement: `0x${"00".repeat(32)}`,
  modelFamily: "deepseek",
  issuedAt: 1790603796,
  expiresAt: 1793195796,
};
const options = {
  chain: "robinhoodTestnet" as const,
  home,
  agentId: "7",
  uri: "bonded://test",
  attesterKey: ANVIL_KEYS.deployer,
  ownerKey: ANVIL_KEYS.deployer,
};
const score = (overrides: Partial<Attestation> = {}) =>
  attestationMessage({ ...home, agentId: "7", ...overrides });
beforeEach(() => {
  vi.resetAllMocks();
  rpc.writeContract.mockResolvedValue(hash);
});

it("recovers the post transaction after a mined score was not saved locally", async () => {
  rpc.readContract.mockResolvedValue(score());
  rpc.getLogs.mockResolvedValue([{ transactionHash: hash }]);
  expect(await crosspostEvm(options)).toMatchObject({ status: "already-current", tx: hash });
  expect(rpc.writeContract).not.toHaveBeenCalled();
  expect(rpc.getLogs).toHaveBeenCalledWith(
    expect.objectContaining({
      args: { requestHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
    }),
  );
});

it("does not call a newer different rating already-current", async () => {
  rpc.readContract.mockResolvedValue(
    score({ issuedAt: home.issuedAt + 1, reportHash: `0x${"44".repeat(32)}` }),
  );
  await expect(crosspostEvm(options)).rejects.toThrow(/different|supersed/i);
  expect(rpc.writeContract).not.toHaveBeenCalled();
});

it("does not reuse a rating with a different signed security grade", async () => {
  rpc.readContract.mockResolvedValue(score({ securityScore: home.securityScore - 1 }));
  await expect(crosspostEvm(options)).rejects.toThrow(/different/);
  expect(rpc.getLogs).not.toHaveBeenCalled();
  expect(rpc.writeContract).not.toHaveBeenCalled();
});

it("checks the security grade after a successful post", async () => {
  let reads = 0;
  rpc.readContract.mockImplementation(async ({ functionName }) =>
    functionName === "scoreOf"
      ? score(
          ++reads === 1
            ? { issuedAt: home.issuedAt - 1 }
            : { securityScore: home.securityScore - 1 },
        )
      : true,
  );
  rpc.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
  await expect(crosspostEvm(options)).rejects.toThrow(/match/);
});

it("refuses a reverted post even when an older score remains valid", async () => {
  rpc.readContract.mockImplementation(async ({ functionName }) =>
    functionName === "scoreOf" ? score({ issuedAt: home.issuedAt - 1 }) : true,
  );
  rpc.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
  await expect(crosspostEvm(options)).rejects.toThrow(/reverted/);
});

it("verifies the intended stored score after a successful receipt", async () => {
  let reads = 0;
  rpc.readContract.mockImplementation(async ({ functionName }) =>
    functionName === "scoreOf"
      ? score({
          issuedAt: home.issuedAt - 1,
          reportHash: `0x${(++reads === 1 ? "55" : "66").repeat(32)}`,
        })
      : true,
  );
  rpc.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
  await expect(crosspostEvm(options)).rejects.toThrow(/match|different/);
});

it("returns the transaction when the intended score is confirmed", async () => {
  let reads = 0;
  rpc.readContract.mockImplementation(async ({ functionName }) =>
    functionName === "scoreOf"
      ? score({ issuedAt: home.issuedAt - (++reads === 1 ? 1 : 0) })
      : true,
  );
  rpc.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
  expect(await crosspostEvm(options)).toMatchObject({ status: "posted", tx: hash });
});

it("reports a confirmed registration before a subsequent score post fails", async () => {
  const registered = vi.fn();
  // The live registry the chain's deployment file names: crosspostEvm checks the log against it.
  const { registry } = JSON.parse(
    readFileSync(new URL("../../../contracts/evm/deployments/46630.json", import.meta.url), "utf8"),
  ) as { registry: string };
  rpc.writeContract
    .mockResolvedValueOnce(hash)
    .mockRejectedValueOnce(new Error("post unavailable"));
  rpc.waitForTransactionReceipt.mockResolvedValue({
    status: "success",
    logs: [
      {
        address: registry,
        topics: encodeEventTopics({
          abi: bondedRegistryAbi,
          eventName: "Registered",
          args: { agentId: 7n, owner: "0x0000000000000000000000000000000000000001" },
        }),
        data: encodeAbiParameters([{ type: "string" }], [options.uri]),
        blockHash: null,
        blockNumber: null,
        logIndex: null,
        transactionHash: null,
        transactionIndex: null,
        removed: false,
      },
    ],
  });
  rpc.readContract.mockResolvedValue({ issuedAt: 0n });
  await expect(
    crosspostEvm({
      chain: options.chain,
      home,
      uri: options.uri,
      ownerKey: options.ownerKey,
      attesterKey: options.attesterKey,
      onRegistered: registered,
    }),
  ).rejects.toThrow("post unavailable");
  expect(registered).toHaveBeenCalledWith("7");
});
