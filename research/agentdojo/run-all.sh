#!/usr/bin/env bash
# Pilot run: three cheap models x three runs, all nine in parallel. Each process stops starting new
# suites once the key's total spend since it started passes MAX_USD, so together they stay near
# that cap. OPENROUTER_API_KEY must be set by the caller.
#
#   ./run-all.sh                                           # both attacks, AgentDojo's system prompt
#   SYSTEM_PROMPT=arena ATTACKS=bonded_seed MAX_USD=1.5 ./run-all.sh
set -u
SYSTEM_PROMPT="${SYSTEM_PROMPT:-agentdojo}"
ATTACKS="${ATTACKS:-bonded_seed,important_instructions}"
MAX_USD="${MAX_USD:-4}"
mkdir -p runs/logs
for model in z-ai/glm-5.3-flash deepseek/deepseek-v4.1-flash qwen/qwen3.7-flash; do
  for n in 1 2 3; do
    log="runs/logs/$(echo "$model" | tr / _)-$SYSTEM_PROMPT-run-$n.log"
    uv run -q python run.py --model "$model" --runs 3 --only-run "$n" --max-usd "$MAX_USD" \
      --attacks "$ATTACKS" --system-prompt "$SYSTEM_PROMPT" >"$log" 2>&1 &
  done
done
wait
echo ALL-DONE
