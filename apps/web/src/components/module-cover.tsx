import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import {
  checkUnprotectedAllowances,
  coverManagerAbi,
  deploymentTokens,
  mandateModuleAbi,
  unprotectedAllowancesWarning,
} from "@bondedhq/shared";
import type { Address } from "viem";
import { deployment } from "../config";
import { MODULE_COVER_NOTE } from "../lib/module";
import { moduleCoverNote } from "../lib/chain";
import { Card, Note } from "./ui";
import { BuyCover } from "../pages/Vault";

/**
 * Cover for an agent protected by a module on its owner's smart account (ERC-7579) rather than a
 * vault: the module has no vault page, so its cover form is on the agent's page. Says plainly what
 * cover on a module doesn't pay.
 */
export function ModuleCover({ agentId, module }: { agentId: bigint; module: Address }) {
  const { address } = useAccount();
  const reads = useReadContracts({
    contracts: [
      { address: module, abi: mandateModuleAbi, functionName: "guardian" },
      {
        address: deployment.coverManager,
        abi: coverManagerAbi,
        functionName: "activePolicyOf",
        args: [module],
      },
      { address: module, abi: mandateModuleAbi, functionName: "mode" },
      { address: module, abi: mandateModuleAbi, functionName: "account" },
      { address: module, abi: mandateModuleAbi, functionName: "getAssets" },
      {
        address: module,
        abi: mandateModuleAbi,
        functionName: "isTarget",
        args: [deployment.router],
      },
    ],
  });
  const [guardian, active, mode, account, assets, routerIsTarget] = reads.data ?? [];
  // The deployment's exchange is the target worth checking; the module doesn't list its targets.
  const allowanceWarning = (
    <AllowanceWarning
      account={account?.result as Address | undefined}
      targets={routerIsTarget?.result ? [deployment.router] : []}
      assets={(assets?.result as readonly Address[] | undefined) ?? []}
    />
  );
  const note = mode?.result !== undefined ? moduleCoverNote(mode.result) : undefined;
  if (note && !note.insurable)
    return (
      <Card title="Cover">
        <div className="flex flex-col gap-4">
          {allowanceWarning}
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted">
            This module runs in Monitor mode, so it can't hold cover: a breach would go through and
            be paid to the account's own owner. A new module in Enforce mode can.
          </p>
        </div>
      </Card>
    );
  return (
    <div className="flex flex-col gap-4">
      {allowanceWarning}
      <BuyCover
        vault={module}
        agentId={agentId}
        isGuardian={Boolean(
          address && guardian?.result && address.toLowerCase() === guardian.result.toLowerCase(),
        )}
        hasActive={Boolean(active?.result)}
        module
      />
      <p className="max-w-2xl text-[13px] leading-relaxed text-muted">{MODULE_COVER_NOTE}</p>
    </div>
  );
}

/**
 * Approvals the module can't see (`checkUnprotectedAllowances`): the account's allowances to the
 * mandate's targets for tokens the mandate doesn't cover. Renders the plain warning, or nothing.
 */
export function AllowanceWarning(props: {
  account: Address | undefined;
  targets: readonly Address[];
  assets: readonly Address[];
}) {
  const client = usePublicClient();
  const check = useQuery({
    queryKey: ["allowances", props.account, props.targets, props.assets],
    enabled: Boolean(client && props.account && props.targets.length),
    queryFn: () =>
      checkUnprotectedAllowances(client!, {
        account: props.account!,
        targets: props.targets,
        assets: props.assets,
        tokens: deploymentTokens(deployment),
      }),
    refetchInterval: 60_000,
  });
  const warning = check.data ? unprotectedAllowancesWarning(check.data.unprotected) : undefined;
  if (!warning) return null;
  return (
    <Note tone="warn" role="alert">
      {warning}
    </Note>
  );
}
