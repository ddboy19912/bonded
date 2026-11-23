"""Bonded's accounts-payable attacks as an AgentDojo suite (pilot).

Importing the package registers the suite under the benchmark version "bonded_ap" and the
bonded_seed attack. See research/agentdojo/README.md.
"""

from agentdojo.task_suite import register_suite

from bonded_ap import attack, injection_tasks, user_tasks  # noqa: F401  (registers tasks and the attack)
from bonded_ap.task_suite import task_suite

BENCHMARK_VERSION = "bonded_ap"
register_suite(task_suite, BENCHMARK_VERSION)

__all__ = ["BENCHMARK_VERSION", "task_suite"]
