#!/usr/bin/env bash
# Run the Sentinel production gates for a candidate checkpoint against the baseline it would
# replace (docs/SENTINEL-STRESS.md, "v3 training data"; the rules are in apps/arena/src/gates.ts).
# Five gates since v5: held-out cases, locked stress, fresh benign, Arena rerun, consistency.
#
# Usage, from the repository root:
#   scripts/sentinel-gates.sh <candidate revision> <held-out ratings dir>...
#
# Environment (defaults in brackets):
#   CANDIDATE_QUESTIONS [v3]   BASELINE_REVISION [v1: 22d2ad7…]   BASELINE_QUESTIONS [v1]
#   SENTINEL_PYTHON [services/sentinel/.venv/bin/python]   OUT [datasets/gates-<timestamp>]
#
# It serves both checkpoints locally, then runs the four gates on identical inputs. Gate 3 runs
# 48 fresh benign LLM episodes (about $0.04 of OpenRouter credit, OPENROUTER_API_KEY in .env).
# Exits 0 only if every gate passes.
set -euo pipefail

CANDIDATE_REVISION=${1:?candidate revision required}
shift
[ $# -ge 1 ] || { echo "at least one held-out ratings dir (with sentinel-dataset.jsonl) is required" >&2; exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CANDIDATE_QUESTIONS=${CANDIDATE_QUESTIONS:-v3}
BASELINE_REVISION=${BASELINE_REVISION:-22d2ad765058158a1a3c7472ac551690a05fe1e6}
BASELINE_QUESTIONS=${BASELINE_QUESTIONS:-v1}
PYTHON=${SENTINEL_PYTHON:-$ROOT/services/sentinel/.venv/bin/python}
ARENA="$ROOT/apps/arena"
OUT=${OUT:-$ARENA/datasets/gates-$(date +%Y%m%d-%H%M%S)}
KEY=$(openssl rand -hex 16)
mkdir -p "$OUT"

HELDOUT_ARGS=()
for dir in "$@"; do HELDOUT_ARGS+=(--arena "$(cd "$dir" && pwd)/sentinel-dataset.jsonl"); done

PIDS=()
# `exec` below makes each server the background process itself, so this stops the servers,
# not just the subshells that started them.
cleanup() { for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

serve() { # role port revision
  (cd "$ROOT/services/sentinel" && SENTINEL_MODEL_REPO=ddboy19912/bonded-sentinel-laya \
    SENTINEL_MODEL_REVISION="$3" PORT="$2" LAYA_DEVICE="${LAYA_DEVICE:-mps}" LAYA_API_KEY="$KEY" \
    exec "$PYTHON" server.py >"$OUT/server-$1.log" 2>&1) &
  PIDS+=($!)
}
wait_healthy() { # port revision
  for _ in $(seq 1 200); do
    if curl -sf -m 2 "http://127.0.0.1:$1/health" | grep -q "\"$2\""; then return 0; fi
    sleep 3
  done
  echo "server on port $1 didn't come up with revision $2; see $OUT/server-*.log" >&2
  exit 2
}

echo "Serving baseline $BASELINE_REVISION ($BASELINE_QUESTIONS) and candidate $CANDIDATE_REVISION ($CANDIDATE_QUESTIONS)"
serve baseline 8768 "$BASELINE_REVISION"
serve candidate 8769 "$CANDIDATE_REVISION"
wait_healthy 8768 "$BASELINE_REVISION"
wait_healthy 8769 "$CANDIDATE_REVISION"

(cd "$ROOT" && pnpm --silent turbo run build --filter @bonded/arena... >/dev/null)
cd "$ARENA"
run() { # role port questions
  local role=$1 url="http://127.0.0.1:$2" q=$3
  echo "== $role: held-out Arena cases"
  LAYA_API_KEY=$KEY node dist/sentinel-eval-cli.js "${HELDOUT_ARGS[@]}" --laya "$url" --questions "$q" --out "$OUT/$role-heldout.json" | tail -3
  echo "== $role: stress suite, locked split"
  LAYA_API_KEY=$KEY node dist/stress-cli.js --laya "$url" --questions "$q" --split locked --out "$OUT/$role-stress-locked.json" | { grep -E "^total" || true; }
  echo "== $role: fresh benign episodes"
  LAYA_API_KEY=$KEY node dist/sentinel-eval-cli.js --arena "$OUT/benign-episodes/sentinel-dataset.jsonl" --laya "$url" --questions "$q" --out "$OUT/$role-benign.json" | tail -2
  echo "== $role: consistency"
  LAYA_API_KEY=$KEY node dist/consistency-cli.js --laya "$url" --questions "$q" "${HELDOUT_ARGS[@]}" \
    --out "$OUT/$role-consistency.json" 2>/dev/null | { grep -E "^consistency" || true; }
  echo "== $role: Arena rerun behind Sentinel"
  LAYA_API_KEY=$KEY node dist/cli.js rate --agent vulnerable --brain scripted --repeats 2 --controls 8 \
    --sentinel-model "laya:$url" --sentinel-questions "$q" --out "$OUT/arena-$role" | { grep -E "Security score|premium" || true; }
}

echo "== fresh benign episodes (LLM agent, about \$0.04)"
node dist/cli.js controls --brain llm --controls 48 --max-usd 1 --out "$OUT/benign-episodes" | tail -2
run baseline 8768 "$BASELINE_QUESTIONS"
run candidate 8769 "$CANDIDATE_QUESTIONS"

echo
node dist/gates-cli.js --dir "$OUT"
