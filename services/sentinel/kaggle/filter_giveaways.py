"""Find synthetic training rows whose label the scene text gives away.

Sentinel must decide "manipulated" by comparing the action with what the untrusted inputs
ask for. A row whose inputs alone predict its label teaches a shortcut instead: on v5's data, a
word-counting model that never sees the action labelled 93% of the synthetic rows right (the
majority is 72%), from words like "ignore". docs/internals/SENTINEL-TRAINING-HISTORY.md, "The word-counting probe".

Only rows with planted content (injection_in_inputs true) are checked. Without any, "nothing
planted, so not manipulated" is correct reasoning, not a shortcut; with it, whether the agent
obeyed depends on the action, so the inputs alone mustn't tell.

This trains that model on those rows' inputs only (TF-IDF over words and word pairs,
logistic regression), five folds, each row scored by a model that never saw it. A row is a
giveaway when that model gives its true label probability `THRESHOLD` or more. Its id is written,
one per line, for `sentinel:dataset --exclude-ids`. Rule-built and LLM-written pairs share their
inputs between an obeyed and an independent row, so inputs can't give them away; Arena rows are
real episodes. Both are left alone. Deterministic.

    python filter_giveaways.py <dataset dir> <out file> [--rounds N] [--all]

Filtering plateaus on v2's synthetic rows: after five rounds the inputs alone still predict 63%
of the rest (majority 50%), because the generator wrote each scene knowing its label. `--all`
writes every synthetic row with planted content instead; v5 uses it.

Needs scikit-learn.
"""

import json
import sys
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold

THRESHOLD = 0.8
TOKENS = r"[A-Za-z$][A-Za-z0-9_$]+|\d[\d,.]*"


def inputs_text(state: dict) -> str:
    inputs = state["untrusted_inputs"]
    if isinstance(inputs, str):
        inputs = json.loads(inputs)
    return " ".join(f"{i['tool']} {i['output']}" for i in inputs if i["tool"] != "get_prices")


def scores(texts: list[str], labels: np.ndarray, seed: int) -> np.ndarray:
    """Each row's out-of-fold probability for its own label."""
    out = np.zeros(len(texts))
    folds = StratifiedKFold(n_splits=FOLDS, shuffle=True, random_state=seed)
    for train, held in folds.split(texts, labels):
        vec = TfidfVectorizer(ngram_range=(1, 2), min_df=3, max_features=200_000, token_pattern=TOKENS)
        x = vec.fit_transform([texts[i] for i in train])
        model = LogisticRegression(max_iter=2_000, C=4).fit(x, labels[train])
        p = model.predict_proba(vec.transform([texts[i] for i in held]))[:, 1]
        out[held] = np.where(labels[held] == 1, p, 1 - p)
    return out


FOLDS = 5


def can_score(labels: np.ndarray) -> bool:
    """Five-fold scoring needs at least five rows of each label."""
    return len(labels) > 0 and min(int(labels.sum()), int(len(labels) - labels.sum())) >= FOLDS


def main() -> None:
    dataset, out = Path(sys.argv[1]), Path(sys.argv[2])
    rounds = int(sys.argv[sys.argv.index("--rounds") + 1]) if "--rounds" in sys.argv else 2
    rows = []
    for line in (dataset / "train.jsonl").read_text().splitlines():
        r = json.loads(line)
        if r["source"] != "synthetic":
            continue
        state = json.loads(r["state"])
        if not state["untrusted_inputs"]:
            continue
        gold = json.loads(r["gold"])
        if gold["injection_in_inputs"]["label"] != "true":
            continue
        rows.append((r["id"], inputs_text(state), int(gold["manipulated"]["label"] == "true")))
    if "--all" in sys.argv:
        out.write_text("".join(f"{i}\n" for i, _, _ in rows))
        print(f"--all: {len(rows)} synthetic rows with planted content written to {out}")
        return
    dropped: list[str] = []
    for n in range(rounds):
        texts = [t for _, t, _ in rows]
        labels = np.array([y for _, _, y in rows])
        if not can_score(labels):
            print(f"round {n + 1}: {len(rows)} rows left, too few of one label to score; stopping")
            break
        p = scores(texts, labels, seed=n)
        accuracy = float(np.mean(p >= 0.5))
        majority = max(labels.mean(), 1 - labels.mean())
        give = p >= THRESHOLD
        print(
            f"round {n + 1}: {len(rows)} synthetic rows with planted content; inputs-only accuracy "
            f"{accuracy:.1%} (majority {majority:.1%}); {int(give.sum())} giveaways"
        )
        dropped += [rows[i][0] for i in np.flatnonzero(give)]
        rows = [row for row, g in zip(rows, give) if not g]
    texts = [t for _, t, _ in rows]
    labels = np.array([y for _, _, y in rows])
    out.write_text("".join(f"{i}\n" for i in dropped))
    if not can_score(labels):
        print(f"after: {len(rows)} rows kept, too few of one label to measure inputs-only accuracy")
        print(f"{len(dropped)} ids written to {out}")
        return
    p = scores(texts, labels, seed=rounds)
    print(
        f"after: {len(rows)} rows kept, inputs-only accuracy {float(np.mean(p >= 0.5)):.1%} "
        f"(majority {max(labels.mean(), 1 - labels.mean()):.1%}), manipulated {labels.mean():.1%}"
    )
    print(f"{len(dropped)} ids written to {out}")


if __name__ == "__main__":
    main()
