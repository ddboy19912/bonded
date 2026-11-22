import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "@bonded/db";
import type { EvmDeployment } from "@bondedhq/shared";

/** What a service logs while the database still holds an older deployment's state. */
export const redeployedMessage = (chainId: number, recorded: string, registry: string) =>
  `Chain ${chainId} was redeployed: the database holds state for the registry ${recorded}, and ` +
  `the deployment file names ${registry}. Waiting. To clear the old deployment's state and ` +
  `move to the new one, set ADOPT_DEPLOYMENT=${registry} on the api service ` +
  `(docs/DEVELOPING-REFERENCE.md, "After a redeployment").`;

/**
 * Don't run on an older deployment's state. A redeployment numbers agents, policies, claims and
 * bounties from 1 again, so old rows would be taken for new ones. Every service waits here until
 * the database records this deployment. The api moves the database onto it, clearing the chain's
 * old on-chain state, only when ADOPT_DEPLOYMENT names this deployment's registry exactly: an
 * operator's deliberate step, which a wrong deployment file can't trigger. The other services
 * wait (they'd use up Railway's restarts if they crashed) and go on once the api has done it.
 */
export async function adoptDeployment(
  db: Pick<Database, "checkDeployment" | "adoptDeployment">,
  deployment: Pick<EvmDeployment, "chainId" | "registry">,
  role: string,
  confirm: string | undefined,
  options: {
    log?: (line: string) => void;
    retryMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const { chainId, registry } = deployment;
  const log = options.log ?? console.log;
  const adopts = role === "api" || role === "all";
  for (let warned = false; ;) {
    const recorded = await db.checkDeployment(chainId, registry);
    if (recorded === undefined) return;
    if (adopts && confirm?.trim().toLowerCase() === registry.toLowerCase()) {
      const cleared = await db.adoptDeployment(chainId, registry);
      const rows = Object.entries(cleared ?? {})
        .filter(([, n]) => n > 0)
        .map(([table, n]) => `${table} ${n}`);
      log(
        `Moved chain ${chainId} from the registry ${recorded} to ${registry}. Cleared: ` +
          `${rows.length ? rows.join(", ") : "nothing"}. ADOPT_DEPLOYMENT can be removed now.`,
      );
      return;
    }
    if (!warned) log(redeployedMessage(chainId, recorded, registry));
    warned = true;
    await delay(options.retryMs ?? 30_000, undefined, { signal: options.signal });
  }
}
