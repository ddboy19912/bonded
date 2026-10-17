# What the market evidence supports for Bonded

Research date: 2026-10-16. This note adds customer and competing-product evidence to [the earlier product assessment](PRODUCT-PROOF-RESEARCH.md). It does not establish product-market fit, claim a new exploit, or authorize outreach. No paid model calls, commits or pushes were made for this note.

## Assessment

There is documented demand for evaluating deployed AI applications and a documented market for giving agents constrained financial authority. Those are two relevant markets, but their intersection is not yet a demonstrated market for Bonded.

The strongest immediate hypothesis is an independent security assessment for teams deploying agents that can move money: inspect the complete authorization path, reproduce failures, implement or recommend controls, and verify those controls after changes. The current Arena contributes a useful financial execution test environment. It does not yet amount to an assessment of all the systems surrounding a production agent.

Passing strong models should narrow the behavioral risk estimate. It does not eliminate failures in identity, adapters, transaction semantics, permissions, dependencies or infrastructure. Conversely, discovering those failures does not automatically make them covered events under Bonded's current vault and insurance design.

## Evidence ledger

These are primary sources from the organization providing the service, the customer publishing the assessment, or the vendor of the affected software. Commercial sources have an incentive to present successes. None supplies Bonded customer interviews, purchase orders, renewal data or independently audited revenue.

| Source and date | What is actually evidenced | What is not established |
| --- | --- | --- |
| [BPCE customer case study, Giskard](https://www.giskard.ai/knowledge/how-bpce-secured-its-customer-facing-banking-chatbot), 2026-07-13 | Named BPCE product and AI staff describe several weeks of expert testing before launch, functional evaluation, and continuous testing across three assistants. The work includes security and release confidence. | This is a vendor-published banking chatbot case, not proof of autonomous trading, financial loss, a disclosed contract price, or demand for an agent insurance policy. |
| [Giskard professional offering](https://www.giskard.ai/pricing), undated; checked 2026-10-16 | A commercial package combines scenario-based tests, audit reports, version history, CI integration and remediation advice. | An offering is not proof of sales volume. No public price is shown on the inspected page. |
| [Rasa-hosted Lakera assessment](https://info.rasa.com/hubfs/2025%20Case%20Studies/%5BRasa%5D%20Lakera%20Red%20Security%20Assessment.pdf), assessment September 2025 | A third-party security company assessed two Rasa-built mock applications, including useful task performance. Structured flow control contained substantially more of the tested behavior than the prompt-driven design. Implementations are linked in the report. | The applications were explicitly simplified mock systems without added production guardrails. This is not a customer incident, proof every current strong model fails, or a population-level risk estimate. |
| [ATXP customer case study, Privy](https://privy.io/blog/turning-ai-agents-into-economic-actors-with-atxp), 2026-06-10 | A named platform uses wallet infrastructure for agent accounts, permissions and budgets. Privy reports more than one million accounts created and includes a named customer executive statement. | Accounts created are not active paying agents, transactions, funds at risk or independent demand for security testing. The source describes useful work under real budgets as a continuing focus. |
| [Nevermined customer case study, Privy](https://privy.io/blog/building-the-future-of-agentic-payments-with-nevermined), 2025-12-23 | A named platform integrates identity-linked wallets and delegated spending with metering, quotas and settlement enforced outside the model. | There are no disclosed transaction volumes, security losses or purchases of independent assessments. This supports an actual integration pattern, not its economic scale. |
| [Privy policy engine](https://privy.io/blog/turning-wallets-programmable-with-privy-policy-engine), 2026-01-08 | Wallet infrastructure already provides transaction/time-window limits, contract restrictions, typed-data restrictions and permission expiry for agents and treasury systems. | These advertised controls are not an independent audit of their correctness or of every customer's configuration. |
| [Microsoft Entra Agent ID authorization](https://learn.microsoft.com/en-us/entra/agent-id/authorization-agent-id), living documentation; checked 2026-10-16 | Agent identity and authorization are a product category: scoped permissions and restrictions on high-privilege roles are implemented outside the model. | General identity management is not financial transaction validation or proof of Bonded's differentiation. |
| [Promptfoo agent testing documentation](https://www.promptfoo.dev/docs/red-team/agents/), living documentation; checked 2026-10-16 | An available open-source competitor documents permission, memory, tool and trace-based testing, plus deterministic authorization recommendations and regression assertions. | A list of supported probes is not measured detection coverage. Adaptive attacks, traces and regression testing alone are not a unique Bonded feature. |
| [Palo Alto Networks acquisition of Protect AI](https://www.paloaltonetworks.com/company/press/2025/palo-alto-networks-completes-acquisition-of-protect-ai), 2025-07-22 | A large security vendor completed an acquisition spanning model scanning, red teaming, runtime protection and agent security. | An acquisition proves strategic investment, not Bonded's fit, market size, customer conversion or the value of its insurance. |

The BPCE evidence is stronger than an anonymous testimonial or a logo list because named customer staff describe an actual testing workflow. It still leaves commercial terms and efficacy independently unverified. The financial-agent cases show that delegated spending is more than a speculative use case; they do not show unmet demand for another spending-control vendor.

## What a security company must be able to prove

A useful report distinguishes five questions:

1. **Exposure:** can this attacker reach the input or component under the customer's real deployment conditions?
2. **Boundary failure:** does untrusted data acquire authority, or does an ordinary software defect bypass a restriction?
3. **Impact:** what action actually happened, whose data or funds were affected, and which explicit requirement failed?
4. **Containment:** at which independent boundary does the action stop, and does ordinary work still succeed?
5. **Recurrence:** does the result reproduce after a reset, and is the fix covered by a regression test tied to the deployed version?

Model behavior is only one link. An attacker-controlled page can target the browser or local control plane without persuading the model to ignore its instructions. A tool can mishandle a correct payment instruction. An API can authorize the wrong user's object. A valid signature can authorize too much. A price feed can be misleading without containing an imperative sentence. Each needs evidence from its own boundary.

For one concrete non-model example, Microsoft's [AutoJack report](https://www.microsoft.com/en-us/security/blog/2026/06/18/autojack-single-page-rce-host-running-ai-agent/) (2026-06-18) describes a controlled local demonstration chaining browser-loaded content into an AutoGen Studio MCP control plane and host process execution. Microsoft says the affected surface existed on a development branch and was fixed before any PyPI release. This is evidence of a discovered software-boundary failure in an agent environment, **not** evidence that released PyPI users were exploited. Its causal details have not been independently reproduced here.

Security expertise also means resisting inflated labels. The Rasa/Lakera report uses broad compromise language for some prompt and tool disclosure findings. Bonded should require demonstrated unauthorized execution, access or loss before using an equivalent impact label. A leaked system prompt, a forbidden sentence, an attempted transfer, a blocked transfer and a completed drain are different observations.

## Current product coverage and missing boundaries

This is a scope assessment of the inspected Arena path, not a security audit of Bonded itself.

| Boundary | What the current Arena contributes | What a complete customer assessment must add |
| --- | --- | --- |
| External content → model/tool choice | Planted simulated content, agent trace and adaptive experiments | Real retrieval exposure, authenticated origin, realistic tasks, multi-session state and strong-model replication |
| Proposed financial action → vault | Tools or the supported self-signing path reach the vault; its log records violations and blocked status | Match the customer's real signing/adapter path and transaction semantics; verify every production path is mediated |
| Vault event → verdict | The judge reads on-chain breach records and financial loss | Separate other outcomes: unauthorized disclosure, duplicate service purchase, denial of service, harmful but permitted trade |
| Identity → API object/action | Not established by a vault-breach verdict | Tenant isolation, object ownership, approval identity, delegation scope, revocation and authenticated callbacks |
| Tools/dependencies → host/network | Simulated tools are not evidence about real MCP packages, browser runtimes or hosts | Versioned dependency review, tool-server authorization, sandbox isolation, secret access and controlled network egress |
| Intent → signature/payment/settlement | Explicit encoded mandate controls provide a relevant test oracle | Verify quotes, calldata, approvals, stale authorization, retries, concurrent spending and outcome verification against the actual integration |
| Test configuration → deployment | A saved experiment describes a tested configuration | Attest or otherwise verify deployed code, prompts, model, tool definitions and policies; changes require proportionate re-evaluation |

Source: [episode orchestration](../apps/arena/src/episode.ts), [toolbox](../apps/arena/src/toolbox.ts), [judge](../apps/arena/src/judge.ts). In particular, toolbox writes route through `execute`, and the judge's verdict is derived only from the vault log. A zero vault-breach count cannot establish zero exfiltration or zero operational harm. The broader research remit needs additional deterministic or independently observable verdicts without weakening the vault verdict for financial mandate claims.

## Segment hypotheses and disconfirmation

The following are proposed research decisions, not market findings. Start with one segment and a fixed discovery cohort; do not infer a market from whichever example happens to break.

| Candidate customer | Proposed purchase and trigger | What would support it | What would disconfirm it |
| --- | --- | --- | --- |
| Custom treasury, trading or rebalancing operator | Assessment before granting unattended execution or changing a model/tool/mandate | Customer supplies actual implementation; a reproduced material failure changes deployment or control decisions; customer pays for the assessment or repeat verification | Wallet provider controls already satisfy requirements; no additional findings affect deployment; operator will not allocate budget or engineering access |
| Platform provisioning financial agents | Test delegation and transaction paths before onboarding third-party agents or increasing spending limits | Platform has an explicit admission decision, repeatable evidence requirements and a budget owner; results become part of that decision | Platform only needs existing wallet controls; every integration needs bespoke work that its own engineers perform more cheaply; scores do not affect admission |
| Enterprise agent operator with payment/refund actions | Assess end-to-end identity, business rules and payment execution before release | Material unauthorized actions can be reproduced and fixed, and assessment is integrated into change control | Existing AppSec/evaluation vendors cover the need; Bonded's on-chain specialization adds no value; required off-chain testing is outside feasible scope |
| Depositor or underwriter | Purchase defined residual coverage | Specific covered loss survives preventive controls, is attributable and measurable, and the buyer accepts exclusions and pricing | Main risks are excluded, enforcement eliminates the covered event, or premium is paid only for marketing rather than meaningful transfer of risk |

A practical exploratory gate would be five independently selected design partners in one segment, with at least two paid assessments and at least one paid repeat or contractual repeat requirement. These numbers are proposed management thresholds, not statistical evidence of product-market fit. Record refusals and reasons. A free successful attack demonstration does not satisfy this gate; a clean assessment can satisfy it if the customer pays because its evidence enables a deployment decision.

The research company thesis can survive stronger models if customers still need independent assurance across these boundaries. The current benchmark/rating/insurance thesis requires its own evidence. Expanding the company's expertise is sensible; expanding product claims before testing the new boundaries is not.

## What this research has and has not verified

Verified: primary sources document actual assessment engagements, agent financial infrastructure integrations, competing controls, and at least one precisely scoped non-model exploit demonstration. Inspected local source establishes why the vault verdict is authoritative for its encoded mandate but insufficient for all agent-security outcomes.

Unverified: customer willingness to pay Bonded, comparative performance against incumbents, exploitable flaws in any of the named customer deployments, population-level financial loss rates, and the requested Flash static-pass/adaptive-fail demonstration. No named external system was attacked. This work is research evidence and a validation plan, not a sales claim or a new vulnerability disclosure.
