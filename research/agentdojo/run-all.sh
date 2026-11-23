#!/usr/bin/env bash
# Stage F pilot run: three cheap models x three runs, all nine in parallel. Each process stops
# starting new suites once the key's total spend since it started passes $4, so together they stay
# near that cap. OPENROUTER_API_KEY must be set by the caller.
set -u
mkdir -p runs/logs
for model in z-ai/glm-5.3-flash deepseek/deepseek-v4.1-flash qwen/qwen3.7-flash; do
  for n in 1 2 3; do
    log="runs/logs/$(echo "$model" | tr / _)-run-$n.log"
    uv run -q python run.py --model "$model" --runs 3 --only-run "$n" --max-usd 4 >"$log" 2>&1 &
  done
done
wait
echo ALL-DONE
