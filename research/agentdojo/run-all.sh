#!/usr/bin/env bash
# Pilot run: three cheap models x three runs, all nine in parallel. Each process stops starting new
# suites once the key's total spend since it started passes MAX_USD, so together they stay near
# that cap. OPENROUTER_API_KEY must be set by the caller.
#
#   ./run-all.sh                                           # both attacks, AgentDojo's system prompt
#   SYSTEM_PROMPT=arena ATTACKS=bonded_seed MAX_USD=1.5 ./run-all.sh
#   MODELS=z-ai/glm-5.3-flash PUSH=1 MAX_USD=1 ./run-all.sh    # channels in the briefing
set -u
SYSTEM_PROMPT="${SYSTEM_PROMPT:-agentdojo}"
ATTACKS="${ATTACKS:-bonded_seed,important_instructions}"
MAX_USD="${MAX_USD:-4}"
MODELS="${MODELS:-z-ai/glm-5.3-flash deepseek/deepseek-v4.1-flash qwen/qwen3.7-flash}"
PUSH_FLAG=""
TAG="$SYSTEM_PROMPT"
if [ -n "${PUSH:-}" ]; then PUSH_FLAG="--push"; TAG="$TAG-pushed"; fi
mkdir -p runs/logs
pids=()
logs=()
for model in $MODELS; do
  for n in 1 2 3; do
    log="runs/logs/$(echo "$model" | tr / _)-$TAG-run-$n.log"
    uv run -q python run.py --model "$model" --runs 3 --only-run "$n" --max-usd "$MAX_USD" \
      --attacks "$ATTACKS" --system-prompt "$SYSTEM_PROMPT" $PUSH_FLAG >"$log" 2>&1 &
    pids+=("$!")
    logs+=("$log")
  done
done
failed=0
for i in "${!pids[@]}"; do
  if ! wait "${pids[$i]}"; then
    echo "did not complete: ${logs[$i]}"
    failed=1
  fi
done
echo ALL-DONE
exit "$failed"
