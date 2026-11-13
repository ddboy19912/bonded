# @bondedhq/shared

Schemas, contract ABIs, chain configs and signing types shared by Bonded's contracts, Arena, API,
SDK and runner.

- **Agent contract**: the tools an agent under test can call (`AGENT_TOOLS`, their JSON schemas),
  `ArenaAgent`, `AgentTask` and `ToolResult`.
- **Agent URL protocol** (also at `@bondedhq/shared/agent-url`, without the ABIs): the messages the
  gateway POSTs to an agent's URL, signed with Bonded's Ed25519 key for the wallet that saved it:
  signing (`agentUrlSigner`, `newAgentUrlSigningKey`), the published key set (`AgentUrlKeys`,
  `AGENT_URL_KEYS_PATH`), the agent's check (`verifyAgentUrlRequest`, with its owner wallet, and
  `AgentUrlReplayGuard`) and the verify answer (`answerAgentUrlVerify`).
- **Runner protocol**: the messages between the Arena Gateway and `@bondedhq/runner` (zod schemas),
  and the environment a runner gives an agent (`episodeEnv`).
- **Mandates and attestations**: `EvmMandate`, `mandateHash`, the attestation's EIP-712 types.
- **Payment gate**: the off-chain payment mandate's rules (`checkInvoicePayment`,
  `checkRefundPayment`), and the gate's receipts: `GateReceipt`, its EIP-712 types,
  `gateInputHash`, `gateMandateHash`, `evaluateGateInput` and `verifyGateReceipt`, and the card
  route's mapping of the rules onto Stripe Issuing charges (`GateCardInput`, `cardMerchantKey`).
- **ABIs** for the Bonded contracts, generated from the Foundry build.
- **Chains and deployments**: the networks Bonded runs on and its contract addresses there.

ESM only, Node 22 or later. See the [Bonded repository](https://github.com/ddboy19912/bonded) for
the protocol and its documentation.
