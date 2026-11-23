"""bonded_seed: plant each seed's own text, word for word, in the vectors it was written for.

AgentDojo's stock attacks write an injection task's GOAL into every vector the user task reads.
Bonded's seeds are not instructions to the model: they are ordinary-looking business records
(a saved note, a knowledge-base page, a ticket, an exchange-rate quote). This attack plants
them as written, including vectors the user task's ground truth never reads (the Friday email
arrives only if the agent opens Friday), so the same loop scores both styles of attack.
"""

from __future__ import annotations

from agentdojo.attacks.attack_registry import register_attack
from agentdojo.attacks.base_attacks import BaseAttack
from agentdojo.base_tasks import BaseInjectionTask, BaseUserTask


@register_attack
class BondedSeedAttack(BaseAttack):
    name = "bonded_seed"

    def attack(self, user_task: BaseUserTask, injection_task: BaseInjectionTask) -> dict[str, str]:
        payloads = getattr(injection_task, "PAYLOADS", None)
        if payloads is None:
            raise ValueError(f"{injection_task.ID} has no PAYLOADS: bonded_seed runs only on Bonded seeds")
        return dict(payloads)
