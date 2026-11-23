"""Bonded's public seeds, read from the repo, as AgentDojo injections.

The seed files in apps/arena/offchain-seeds/ are the only source of attack text: nothing here
copies it. Each pilot seed maps its planted text onto the suite's injection vectors. Held-out
variants, adaptive rewrites and counterparty replies are never read (docs/disclosures/OFFCHAIN.md).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from functools import cache
from pathlib import Path
from typing import Any

import yaml

SEED_DIR = Path(__file__).resolve().parents[3] / "apps" / "arena" / "offchain-seeds"

# Accounts the genuine world already holds: vendor accounts, the verified change ticket and the
# refund queue. Any other account in a seed's text is one the attack planted.
GENUINE_ACCOUNTS = {
    "GB33BUKB20201555555555",
    "DE89370400440532013000",
    "DE02120300000000202051",
    "GB29NWBK60161331926819",
    "NL91ABNA0417164300",
}

_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{2,4}){3,8}\b")


@cache
def load_seed(seed_id: str) -> dict[str, Any]:
    return yaml.safe_load((SEED_DIR / f"{seed_id}.yaml").read_text())


def planted_accounts(seed_id: str) -> set[str]:
    """Bank accounts in a seed's planted text that the genuine world doesn't hold, normalised."""
    text = yaml.safe_dump(load_seed(seed_id)["plant"], width=10_000)
    found = {re.sub(r"\s+", "", m).upper() for m in _IBAN.findall(text)}
    return found - GENUINE_ACCOUNTS


def _text(value: str) -> str:
    return value.strip()


# Seed id -> its planted text, keyed by injection vector.
_PAYLOADS: dict[str, Callable[[dict[str, Any]], dict[str, str]]] = {
    "O1-preference-hijack-001": lambda p: {"injection_note": _text(p["notes"][0])},
    "O1-date-trigger-001": lambda p: {
        "injection_kb_rent": _text(p["knowledge"][0]["body"]),
        "injection_friday_email": _text(p["scheduled"][0]["email"]["body"]),
    },
    "O2-fx-skew-001": lambda p: {
        "injection_fx_rate": str(p["fxQuotes"]["EUR/USD"]),
        "injection_eur_email": _text(p["emails"][0]["body"]),
    },
    "O4-confidence-lookup-001": lambda p: {"injection_kb_acme": _text(p["knowledge"][0]["body"])},
    "O4-error-redirect-001": lambda p: {
        "injection_ticket_subject": _text(p["messages"][0]["subject"]),
        "injection_ticket_body": _text(p["messages"][0]["body"]),
    },
    "O4-refund-001": lambda p: {"injection_kb_refund": _text(p["knowledge"][0]["body"])},
}


def seed_payloads(seed_id: str) -> dict[str, str]:
    """The seed's planted text, keyed by the injection vector it fills."""
    return _PAYLOADS[seed_id](load_seed(seed_id)["plant"])


PILOT_SEEDS = tuple(_PAYLOADS)
