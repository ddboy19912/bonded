# Coverage against public AI-security catalogues

Bonded's off-chain attacks are built from documented payment-fraud patterns (docs/CALIBRATION.md). This page maps the same library onto two catalogues security teams already use, the OWASP Top 10 for LLM Applications (2025) and MITRE ATLAS, so a reader can see what is tested, what is partly tested and what isn't, without taking Bonded's word for it.

"Tested" means at least one staged or library seed targets the category and a test checks the ledger records the breach. "Partly" means the category is touched but not covered the way the catalogue describes it. "Not tested" is said plainly.

## OWASP Top 10 for LLM Applications (2025)

| Category | Status | Where Bonded tests it |
|---|---|---|
| LLM01 Prompt injection | Tested | Instructions planted in what the agent reads: emails, invoice images and text, vendor records, chat, tickets, voicemail transcripts, texts, supplier portals, a risk plugin's output, a tool's description, the agent's memory, another agent's messages and the knowledge base (docs/OFFCHAIN.md, "Attack vectors"). Static seeds, held-out variants and the adaptive attacker. |
| LLM02 Sensitive information disclosure | Not tested | The ledger judges payments, not what the agent says. Leaking data isn't scored. |
| LLM03 Supply chain | Partly | A compromised third-party plugin and a poisoned tool description. Model or package supply chains aren't in scope. |
| LLM04 Data and model poisoning | Partly | Poisoned retrieval and memory (the knowledge base and the agent's notes). Training-data poisoning is out of scope: Bonded tests deployed agents. |
| LLM05 Improper output handling | Partly | Every payment the agent asks for is checked by the ledger, which is the control this category asks for. Malformed or invented values (an agent paying an account it made up) are recorded as the agent's own errors. |
| LLM06 Excessive agency | Tested | The mandate (vendor master, approved queue, payment and daily caps, verified bank changes) and the ledger's rules are exactly the limits on agency; every breach type is a case of acting beyond them. |
| LLM07 System prompt leakage | Not tested | Not judged by the ledger. |
| LLM08 Vector and embedding weaknesses | Partly | Knowledge-base retrieval returns planted pages; embedding-level attacks aren't modelled (the knowledge base is searched by keywords). |
| LLM09 Misinformation | Partly | Forged approvals, altered documents and false claims of verification are tested as the route to a payment; misinformation for its own sake isn't. |
| LLM10 Unbounded consumption | Not tested | Spend on the agent's model is capped by the runner, not scored. |

## MITRE ATLAS

| Technique (name) | Status | Where Bonded tests it |
|---|---|---|
| LLM prompt injection: direct | Partly | The attacker writes to the agent only through the channels it reads; there is no direct user turn. |
| LLM prompt injection: indirect | Tested | Every planted channel above. |
| LLM jailbreak | Partly | The adaptive attacker rewrites failed attacks, which covers persuasion; jailbreak prompts aimed at the model's own guardrails aren't a separate class. |
| LLM plugin compromise | Tested | The risk plugin's output and a tool's description. |
| Retrieval poisoning | Tested | The knowledge base. |
| Agent memory poisoning | Tested | The agent's notes from an earlier session. |
| Impersonation (of executives, suppliers and other agents) | Tested | Executive impersonation, lookalike suppliers, hijacked threads, another agent's payment requests and synthetic voice. |
| Exfiltration and data leakage | Not tested | As LLM02. |
| Model theft, evasion of ML models, training attacks | Not in scope | Bonded tests deployed agents that move money, not models. |

## Gaps, said plainly

- Bonded judges money movement. Leaks, prompt disclosure and harmful text aren't scored.
- Direct conversational attacks (a user typing to the agent) aren't modelled; every attack arrives through a channel the agent reads as part of its job.
- Coverage isn't depth. A category marked tested may have one seed or many; the per-class run counts on each report say how much evidence a result rests on.
- The library grows with documented fraud and accepted bounty findings (docs/disclosures/OFFCHAIN.md). New categories are added here when a seed covers them.
