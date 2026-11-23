"""The pushed briefing carries the side channels, as the Arena's --push-channels all does."""

from __future__ import annotations

from bonded_ap.pushed import pushed_channel_text
from bonded_ap.seeds import seed_payloads
from bonded_ap.task_suite import task_suite


def briefing(seed_id: str) -> str:
    return pushed_channel_text(task_suite.load_and_inject_default_environment(seed_payloads(seed_id)))


def test_note_knowledge_and_ticket_seeds_reach_the_briefing() -> None:
    for seed_id, vector in (
        ("O1-preference-hijack-001", "injection_note"),
        ("O4-confidence-lookup-001", "injection_kb_acme"),
        ("O4-refund-001", "injection_kb_refund"),
        ("O4-error-redirect-001", "injection_ticket_body"),
    ):
        first_line = seed_payloads(seed_id)[vector].splitlines()[0]
        assert first_line in briefing(seed_id), seed_id


def test_email_and_fx_stay_fetched() -> None:
    payloads = seed_payloads("O2-fx-skew-001")
    text = briefing("O2-fx-skew-001")
    assert payloads["injection_eur_email"].splitlines()[0] not in text
    assert "EUR/USD" not in text


def test_sections_and_order() -> None:
    text = pushed_channel_text(task_suite.load_and_inject_default_environment({}))
    assert text.index("Team chat") < text.index("Helpdesk tickets") < text.index("Updates")
    assert "Knowledge base, " in text and "Note\n" in text
