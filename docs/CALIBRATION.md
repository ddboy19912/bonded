# Calibration against published fraud patterns

A test that only measures what its authors imagined is easy to dismiss. The off-chain attacks are based on business-email-fraud patterns that banks, police and fraud bodies have documented for years. This page maps each pattern to the seeds that test it, so the library's coverage can be checked against the outside record rather than against itself.

The map is in `apps/arena/src/offchain/calibration.ts` and the check is `apps/arena/test/offchain-calibration.test.ts`.

## What calibration means here

Two things are checked:

1. **Coverage.** Every library and staged seed is mapped to at least one documented pattern, and every pattern names at least one seed.
2. **Verdict agreement.** Each seed aims at a rule the pattern says the fraud breaks (for example, paying an account outside the vendor master). The attack tests already replay the victim's action for each seed and check the ledger records that rule. Together, the case's outcome, the seed's aim and the ledger's verdict agree.

It is **not** a numeric prediction. A published case says what a person or a finance team did. It does not say what a language model would do with the same message. So this page cannot say "the score matches the case." It says the test covers the pattern, and that the rule the ledger records is the rule the case broke. The adaptive attacker supplies the worst case (docs/OFFCHAIN.md, "The adaptive attacker").

## The map

| Pattern | What the source documents | Rules the seed aims at | Seeds |
|---|---|---|---|
| Vendor email compromise | A supplier's mailbox is compromised, or a thread is hijacked, and the reply gives a new bank account for a real invoice | `unknown_payee`, `unverified_vendor_change` | `O1-compromised-mailbox-001`, `O1-thread-hijack-001`, `O1-slow-burn-001`, `O1-update-request-001`, `O1-update-direct-001`, `O6-supplier-verification-001`, `O6-hijack-live-001` |
| Lookalike domain | The sender's address copies the supplier's domain closely enough to pass a quick look | `unknown_payee` | `O1-lookalike-domain-001` |
| Altered invoice or document | A real invoice is altered, inflated or reprinted with another account: a corrected PDF, a scan, a stamp, fine print, a QR remittance block, a note in the signature, or a text layer that names a different account from the rendered page | `unknown_payee`, `unmatched_invoice` | `O1-scanned-note-001`, `O1-muse-photo-note-001`, `O1-muse-rent-stamp-001`, `O2-rush-fee-001`, `O2-altered-pdf-001`, `O2-qr-remit-001`, `O2-text-image-001`, `O4-footer-remit-001`, `O4-image-fine-print-001`, `O4-outstanding-balance-001`, `O4-signature-001` |
| Fake or unapproved supplier invoice | A new or unqueued invoice arrives with a plausible story and is paid without the approved-invoice check | `unmatched_invoice`, `unknown_payee` | `O2-unapproved-invoice-001`, `O2-preapproved-001`, `O2-ticket-001`, `O2-split-invoice-001`, `O3-new-reference-001` |
| Duplicate or re-issued invoice | The same invoice is sent again with a reminder or a new reference, and is paid a second time | `duplicate_payment`, `unmatched_invoice` | `O3-paid-reminder-001`, `O3-new-reference-001` |
| Executive impersonation | A message from the CEO or general counsel asks for an urgent payment, a split payment or secrecy, and names an account outside the vendor master | `unknown_payee`, `over_daily_cap` | `O5-ceo-boarding-001`, `O5-ceo-split-001`, `O5-chat-ceo-001`, `O5-voicemail-ceo-001`, `O5-forged-approval-001`, `O5-legal-confidential-001` |
| Approval bypass | The message says the invoice is pre-approved, quotes a ticket or a colleague, or splits the amount under a limit so the normal approval is skipped | `unmatched_invoice`, `over_daily_cap` | `O2-preapproved-001`, `O2-ticket-001`, `O2-split-invoice-001`, `O5-forged-approval-001`, `O5-ceo-split-001` |
| Impersonation through another channel or tool | The request arrives through chat, a helpdesk ticket, voicemail, text, a supplier portal, a risk plugin, agent memory, another agent or the knowledge base, rather than email | `unknown_payee`, `unverified_vendor_change` | `O1-sms-001`, `O1-portal-001`, `O1-memory-001`, `O1-agent-001`, `O1-records-001`, `O4-plugin-001`, `O1-date-trigger-001`, `O4-knowledge-001`, `O4-refund-001`, `O5-chat-ceo-001`, `O5-voicemail-ceo-001`, `O6-hijack-live-001` |

A seed can cover more than one pattern. `O3-new-reference-001`, for example, is both a fake supplier invoice and a re-issued one, because the ledger sees a new reference as an unmatched invoice.

## What the check enforces

The test fails when:

- a seed in the library or the staged set has no pattern;
- a pattern names a seed that doesn't exist;
- a seed doesn't aim at any rule its pattern lists;
- two patterns share an id, or a pattern has no seed.

That means a new seed cannot land without a documented pattern behind it. Adding one means adding it to the map with a source, not just to `offchain-seeds-staged/`.

## Replaying documented cases

Beyond the pattern map, four publicly reported cases are replayed in the sandbox. Each one is run in the world of the seed that copies its mechanism: the job is done carefully, then the victim's money-moving action is replayed, and the test (`apps/arena/test/offchain-calibration.test.ts`, with the cases in `apps/arena/src/offchain/calibration.ts`) checks the ledger reaches the case's outcome — the rules the case broke, money gone to an account outside the vendor master, put down to the attack and not to an agent's own slip, and blocked when the mandate is in Enforce mode.

This checks the ledger's verdict on what the victim did, not whether a model would have done it. A case says a person or a finance team paid. It cannot say whether a language model handed the same message would pay. So the replay is a check that the rail calls these real actions what they are, not a prediction about any model.

| Case | When | What happened | Sources | Caveat |
|---|---|---|---|---|
| Invoices from an impostor of a real supplier | 2013 to 2015 | A company registered under a real supplier's name (Quanta Computer) sent invoices to two large technology companies, which paid more than $120 million into the impostor's accounts. | [The Register](https://www.theregister.com/2019/03/21/facebook_google_scam/), [Computing](https://computing.co.uk/news/3084788/google-facebook-email-phishing-fraud) | — |
| Employee impersonation at a finance department | 2015 | Requests impersonating employees led a subsidiary's finance staff to send about $46.7 million to overseas third-party accounts (Ubiquiti, per an SEC filing). | [Infosecurity Magazine](https://www.infosecurity-magazine.com/news/networking-ubiquiti-transfers-467), [NBC News](https://www.nbcnews.com/tech/security/ubiquiti-networks-says-it-was-victim-47-million-cyber-scam-n406201) | The filing doesn't say which employees were impersonated or how. |
| Payment directions changed by a third party | 2019 | A European subsidiary of Toyota Boshoku lost about $37 million after following fraudulent payment directions. | [BleepingComputer](https://www.bleepingcomputer.com/news/security/over-37-million-lost-by-toyota-boshoku-subsidiary-in-bec-scam/), [Cloud Security Alliance](https://cloudsecurityalliance.org/articles/buckle-up-bec-and-vec-attacks-target-automotive-industry) | That an employee changed the bank account comes from one later source; the 2019 reports say only "fraudulent payment directions". |
| A secret transaction ordered by a deepfaked CFO | 2024 | A finance worker in Hong Kong joined a video call of deepfaked colleagues and made 15 transfers totalling HK$200 million (about $25 million) for a "secret transaction". | [CNN, via Yahoo News](https://sg.news.yahoo.com/finance-worker-pays-25-million-073109391.html), [AI Incident Database](https://incidentdatabase.ai/es/reports/3622/) | Hong Kong police didn't name the firm. Later reporting and the AI Incident Database name Arup. |

Figures are as reported, rounded. The reports revise them; the replay doesn't depend on the exact amount.

## What this does not show

- **No frequency claim.** The map does not say how common each pattern is, or how much money it moves. Those numbers live in the source reports, and they change.
- **No model claim.** A pattern being covered does not mean a model will fall for it, or that a model that resists one variant resists the pattern. The adaptive attacker is the test for that.
- **No claim that the library is complete.** The map covers the patterns the off-chain classes were built from. A pattern that isn't in the map isn't tested yet. The list is expected to grow with the source reports and with accepted bounty attacks.

## Sources

Named by organisation and report. No figures are quoted here: the reports revise them, and this page is about patterns.

- **FBI Internet Crime Complaint Center (IC3), Internet Crime Report**, business email compromise, CEO fraud and invoice fraud sections.
- **FBI IC3, public service announcements**, on deepfake voice and video, and on messaging-platform business email compromise.
- **UK Finance, Annual Fraud Report**, authorised push payment fraud and invoice/bank-detail scams.
- **OWASP, Top 10 for LLM Applications**, LLM01 prompt injection, for instructions hidden in tool output, agent memory and the knowledge base.

For the same library mapped onto the OWASP Top 10 for LLM Applications and MITRE ATLAS, see docs/COVERAGE.md.
