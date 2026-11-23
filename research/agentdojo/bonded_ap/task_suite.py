"""The accounts_payable suite: Bonded's off-chain payment world inside AgentDojo's harness."""

from __future__ import annotations

import json
from pathlib import Path

import yaml
from agentdojo.functions_runtime import make_function
from agentdojo.task_suite import TaskSuite

from bonded_ap.environment import APEnvironment
from bonded_ap.tools import TOOLS

DATA_PATH = Path(__file__).resolve().parent / "data" / "suites" / "accounts_payable"


def _yaml_escape(text: str) -> str:
    """Escape text for a double-quoted YAML string. JSON's escapes are valid YAML ones."""
    return json.dumps(text)[1:-1]


class APTaskSuite(TaskSuite[APEnvironment]):
    """AgentDojo's suite, with injected text escaped before it goes into the YAML.

    Stock suites paste injections into the YAML as they are, which folds line breaks and breaks
    on a double quote. Bonded's seeds are multi-line emails and tickets, so every injection
    vector here is a double-quoted string and its text is escaped to arrive exactly as written.
    """

    def load_and_inject_default_environment(self, injections: dict[str, str]) -> APEnvironment:
        defaults = self.get_injection_vector_defaults()
        unknown = set(injections) - set(defaults)
        if unknown:
            raise ValueError(f"Injections must be a subset of the injection vector defaults: {sorted(unknown)}")
        values = {key: _yaml_escape(value) for key, value in {**defaults, **injections}.items()}
        text = (DATA_PATH / "environment.yaml").read_text()
        return APEnvironment.model_validate(yaml.safe_load(text.format(**values)))


task_suite = APTaskSuite("accounts_payable", APEnvironment, [make_function(tool) for tool in TOOLS], DATA_PATH)
