/**
 * @bondedhq/sdk: trade through a Bonded Mandate Vault from any TypeScript agent.
 *
 * Framework plugins live in subpaths, each with its framework as an optional peer dependency:
 * `@bondedhq/sdk/agentkit`, `@bondedhq/sdk/solana-agent-kit`, `@bondedhq/sdk/eliza`,
 * `@bondedhq/sdk/langchain`, `@bondedhq/sdk/ai-sdk`. The episode's tools over MCP are in
 * `@bondedhq/sdk/mcp`, and the Agent URL handler in `@bondedhq/sdk/agent-url`.
 *
 * Off chain, `paymentGuard` and `guardPayments` check an agent's payments against the payment
 * mandate inside your own process (no network, no receipts); the framework subpaths wrap a pay
 * tool with it.
 */
export {
  BondedVault,
  type ActionResult,
  type BondedVaultConfig,
  type VaultStatus,
} from "./vault.js";
export {
  demoRouter,
  describeAction,
  type ApproveParams,
  type CallParams,
  type SwapParams,
  type SwapRouter,
  type TransferParams,
  type VaultAction,
  type VaultCall,
} from "./actions.js";
export { breachReason, type DryRunResult, type VaultBreach } from "./breaches.js";
export {
  guarded,
  GuardedVault,
  type GuardCheck,
  type GuardContext,
  type GuardedResult,
  type GuardOptions,
  type SentinelGuardOptions,
  type TokenInfo,
} from "./guarded.js";
export {
  checkWithSentinel,
  type MessageSigner,
  type SentinelCheckRequest,
  type SentinelInput,
} from "./sentinel.js";
export {
  buildMandate,
  describeMandate,
  type BuiltMandate,
  type EvmMandate,
  type EvmMandateParams,
  type EvmMandateRules,
} from "./mandate.js";
export {
  BlockedByMandateError,
  BondedError,
  CallRevertedError,
  NotAgentError,
  PaymentBlockedError,
  PaymentFrozenError,
  PredictedBreachError,
  SentinelError,
  SentinelRefusedError,
  VaultFrozenError,
  type SentinelVerdict,
} from "./errors.js";
export type { BreachType } from "@bondedhq/shared";
export {
  guardPayments,
  guardVendorChanges,
  isPaymentRefusal,
  PaymentGuard,
  paymentGuard,
  type GuardPaymentsOptions,
  type GuardVendorChangesOptions,
  type PaymentBreach,
  type PaymentGuardOptions,
  type PaymentGuardState,
  type PaymentMandate,
  type PaymentSource,
  type PaymentVendor,
  type PaymentVerdict,
} from "./payments.js";
export {
  describePaymentMandate,
  PAYMENT_RULE_WORDS,
  PAYMENT_RULES,
  type PaidPayment,
  type PayableInvoice,
  type PayableRefund,
  type PaymentAttempt,
  type PaymentRule,
  type VerifiedChange,
} from "@bondedhq/shared";
export {
  BONDED_VAULT_TOOLS,
  bondedVaultFromEnv,
  bondedVaultTools,
  type BondedVaultTool,
  type BondedVaultToolName,
  type BondedVaultToolsOptions,
} from "./vault-tools.js";
export {
  bondedEpisodeEnv,
  episodeVault,
  fromBondedEnv,
  isBondedEpisode,
  type BondedEpisode,
} from "./episode.js";
export {
  checkUnprotectedAllowances,
  deploymentTokens,
  unprotectedAllowancesWarning,
  type AllowanceCheck,
  type AllowanceFinding,
  type TokenRef,
  installMandateModule,
  type InstallMandateModuleInput,
  type ModuleAccountType,
  type ModuleInstallPlan,
} from "./module.js";
