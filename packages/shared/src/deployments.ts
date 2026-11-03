import { z } from "zod";
import { evmAddress } from "./schemas/common.js";

/**
 * Shape of `contracts/evm/deployments/<chainId>.json`, written by `script/Deploy.s.sol`.
 * The API, keeper and web app read contract addresses through this schema.
 * See docs/SPECIFICATION.md Section 15 and ADR-004.
 */
export const evmDeploymentSchema = z.strictObject({
  chainId: z.number().int().positive(),
  deployedAtBlock: z.number().int().nonnegative(),
  // demo market (testnets only)
  usdg: evmAddress,
  tsla: evmAddress,
  amzn: evmAddress,
  nvda: evmAddress,
  oracle: evmAddress,
  router: evmAddress,
  // protocol
  registry: evmAddress,
  factory: evmAddress,
  pool: evmAddress,
  bond: evmAddress,
  coverManager: evmAddress,
  claimsEngine: evmAddress,
  disputeModule: evmAddress,
  bountyBoard: evmAddress,
  /** MandateModuleFactory (ERC-7579 smart accounts). Absent in deployments made before it existed. */
  moduleFactory: evmAddress.optional(),
  /**
   * GateAnchor, the payment gate's hash record. Optional: deployed only with GATE_ANCHOR (or on
   * its own by DeployGateAnchor.s.sol, then given to the keeper as GATE_ANCHOR_ADDRESS).
   */
  gateAnchor: evmAddress.optional(),
});

export type EvmDeployment = z.infer<typeof evmDeploymentSchema>;

/**
 * Parses a deployment file's text. Throws if it is malformed, or if `expectedChainId` is
 * given and the file is for a different chain (a copied file pointing at the wrong network).
 */
export function parseEvmDeployment(json: string, expectedChainId?: number): EvmDeployment {
  const deployment = evmDeploymentSchema.parse(JSON.parse(json));
  if (expectedChainId !== undefined && deployment.chainId !== expectedChainId) {
    throw new Error(`deployment is for chain ${deployment.chainId}, expected ${expectedChainId}`);
  }
  return deployment;
}
