# S1 market model: implemented scope and limits

**Status:** the testnet router skew and matched-pair harness are implemented in PR #186.

## Implemented design

`contracts/evm/src/testnet/DemoRouter.sol` exposes a directed-pair `uint16` skew and open
`setSkew` setter for local/testnet experiments. Fee plus skew cannot exceed 10000 bps. Quotes
apply that combined discount to output valued by the unchanged reference oracle. Production
vault policy and oracle contracts are unchanged; the generated router ABI includes the new API.

`apps/arena/src/s1.ts` sets the seed's declared skew in both stock/base directions for **both**
clean and manipulated arms. It snapshots the dedicated sandbox before setup, restores a
matched baseline between arms, captures each valuation before rollback, and restores the
original chain afterward, including on partial setup failure. Resettable memory agents are
cleared between arms. Do not run unrelated concurrent episodes on the same sandbox.

`delivery.executionSkew` accepts listed stock tokens (aliases normalize), with integer bps
from 0 through 5000. Base-token and unknown-token skews are rejected. This is an S1 harness
input, not a bounty capability: bounty submissions reject it instead of silently ignoring it.
The separate seed library is `apps/arena/s1-seeds/`.

The CLI preserves each seed's conditional goal, checks spend before each episode and reports
actual aggregate pairs. Failed or incomplete pairs are not loss observations. Residual-loss
summaries exclude pairs where either arm breached. Per-pair JSON records the shared skew,
both oracle valuations and both-arm breach state.

## What the numbers mean

The matched difference estimates the observed cost of changed trading under a fixed execution
market. Identical trades at the same skew have zero induced difference. A manipulated-only
$2000 trade at a 250 bps skew plus the 20 bps fee loses approximately $54 relative to no trade;
a 500 bps skew plus fee loses approximately $104 and exceeds the demo's 300 bps guard.
The guard checks total execution loss including fees, with integer rounding. In Monitor mode,
a recorded breach does not reverse that first loss; freeze prevents subsequent actions.

An errored control or manipulated arm cannot establish resistance. A breached control cannot
establish an in-mandate residual. Model nondeterminism and agent state outside the reset
interface remain limitations; a few paired observations are not a population rate.

## Deliberately outside this model

- Order-book depth, real price discovery, time-dependent prices and post-trade reversion.
- Opportunity cost of choosing a different fairly valued asset.
- Insurance coverage or claims conclusions from sandbox loss alone.
- Changes to vault policy, production venues, or a paid model evaluation.

The prior scoping proposal and historical paid observations used a different pairing design.
See [Harbinger's historical-results caveat](HARBINGER.md#historical-llm-observations-2026-10-17-before-the-review-corrections)
before interpreting those numbers. The corrected design needs new controlled LLM runs.
