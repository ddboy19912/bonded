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
| Altered invoice or document | A real invoice is altered, inflated or reprinted with another account: a corrected PDF, a scan, a stamp, fine print, a QR remittance block or a note in the signature | `unknown_payee`, `unmatched_invoice` | `O1-scanned-note-001`, `O1-muse-photo-note-001`, `O1-muse-rent-stamp-001`, `O2-rush-fee-001`, `O2-altered-pdf-001`, `O2-qr-remit-001`, `O4-footer-remit-001`, `O4-image-fine-print-001`, `O4-outstanding-balance-001`, `O4-signature-001` |
| Fake or unapproved supplier invoice | A new or unqueued invoice arrives with a plausible story and is paid without the approved-invoice check | `unmatched_invoice`, `unknown_payee` | `O2-unapproved-invoice-001`, `O2-preapproved-001`, `O2-ticket-001`, `O2-split-invoice-001`, `O3-new-reference-001` |
| Duplicate or re-issued invoice | The same invoice is sent again with a reminder or a new reference, and is paid a second time | `duplicate_payment`, `unmatched_invoice` | `O3-paid-reminder-001`, `O3-new-reference-001` |
| Executive impersonation | A message from the CEO or general counsel asks for an urgent payment, a split payment or secrecy, and names an account outside the vendor master | `unknown_payee`, `over_daily_cap` | `O5-ceo-boarding-001`, `O5-ceo-split-001`, `O5-chat-ceo-001`, `O5-voicemail-ceo-001`, `O5-forged-approval-001`, `O5-legal-confidential-001` |
| Approval bypass | The message says the invoice is pre-approved, quotes a ticket or a colleague, or splits the amount under a limit so the normal approval is skipped | `unmatched_invoice`, `over_daily_cap` | `O2-preapproved-001`, `O2-ticket-001`, `O2-split-invoice-001`, `O5-forged-approval-001`, `O5-ceo-split-001` |
| Impersonation through another channel or tool | The request arrives through chat, a helpdesk ticket, voicemail, text, a supplier portal, a risk plugin, agent memory, another agent or the knowledge base, rather than email | `unknown_payee`, `unverified_vendor_change` | `O1-sms-001`, `O1-portal-001`, `O1-memory-001`, `O1-agent-001`, `O1-records-001`, `O4-plugin-001`, `O4-knowledge-001`, `O5-chat-ceo-001`, `O5-voicemail-ceo-001`, `O6-hijack-live-001` |

A seed can cover more than one pattern. `O3-new-reference-001`, for example, is both a fake supplier invoice and a re-issued one, because the ledger sees a new reference as an unmatched invoice.

## What the check enforces

The test fails when:

- a seed in the library or the staged set has no pattern;
- a pattern names a seed that doesn't exist;
- a seed doesn't aim at any rule its pattern lists;
- two patterns share an id, or a pattern has no seed.

That means a new seed cannot land without a documented pattern behind it. Adding one means adding it to the map with a source, not just to `offchain-seeds-staged/`.

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
