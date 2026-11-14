import { describe, expect, it } from "vitest";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  SwitchChainError,
  UserRejectedRequestError,
  parseAbi,
} from "viem";
import { ProviderNotFoundError } from "wagmi";
import { ApiError } from "./api";
import { describeError, isRpcUnavailable } from "./errors";

const rpcDown = new HttpRequestError({
  url: "https://rpc.example/secret-key",
  details: "fetch failed",
});
const reverted = new ContractFunctionExecutionError(
  new ContractFunctionRevertedError({
    abi: parseAbi(["function totalAssets() view returns (uint256)"]),
    functionName: "totalAssets",
  }),
  {
    abi: parseAbi(["function totalAssets() view returns (uint256)"]),
    functionName: "totalAssets",
    contractAddress: "0x0000000000000000000000000000000000000001",
  },
);

describe("isRpcUnavailable", () => {
  it("tells an unreachable RPC from a reverted call, however deep the cause", () => {
    expect(isRpcUnavailable(rpcDown)).toBe(true);
    expect(isRpcUnavailable(new Error("wrapped", { cause: rpcDown }))).toBe(true);
    expect(isRpcUnavailable(reverted)).toBe(false);
  });
});

describe("describeError", () => {
  it("explains wallet problems in words a user can act on", () => {
    const rejected = new UserRejectedRequestError(new Error("User denied"));
    expect(describeError(new Error("send failed", { cause: rejected }))).toMatch(/cancelled/);
    expect(describeError({ code: 4001, message: "rejected" })).toMatch(/cancelled/);
    expect(describeError(new ProviderNotFoundError())).toMatch(/No browser wallet/);
    expect(describeError(new SwitchChainError(new Error("unknown chain")))).toMatch(/46630/);
  });
  it("says which service is down, without echoing its URL", () => {
    expect(describeError(rpcDown)).toMatch(/Robinhood Chain testnet/);
    expect(describeError(rpcDown)).not.toContain("secret-key");
    expect(describeError(new TypeError("Failed to fetch"))).toMatch(/Bonded API/);
    expect(describeError(new ApiError(503, "request failed"))).toMatch(/restarting/);
  });
  it("keeps the API's own message for request errors", () => {
    expect(describeError(new ApiError(401, "unauthorized"))).toMatch(/operator token/);
    // Any other 401 says what went wrong itself, such as a passkey that didn't check out.
    expect(
      describeError(new ApiError(401, "That passkey sign-in didn't check out. Try again.")),
    ).toBe("That passkey sign-in didn't check out. Try again.");
    expect(describeError(new ApiError(409, "agent has no valid score"))).toBe(
      "agent has no valid score",
    );
    expect(describeError(new ApiError(429, "too many reveal requests"))).toBe(
      "too many reveal requests",
    );
  });
});
