#!/usr/bin/env python3
"""STAQPRO-207 — paired-stats for two RAG-eval JSON outputs.

Re-implementation of the original /tmp/eval-pull/paired-stats.py that was
referenced in the rag-eval.v0.1.0.md runbook. Pure stdlib — paired t-test +
Wilcoxon signed-rank (normal approximation with continuity correction) +
sign test.

Indexes per-pair scores by sent_history_id (the unique key per row of the
eval; inbox_message_id can repeat when an inbound paired to multiple sends).
"""
from __future__ import annotations

import json
import math
import sys
from collections.abc import Sequence


def load_pairs(path: str) -> dict[str, float]:
    with open(path) as f:
        data = json.load(f)
    out: dict[str, float] = {}
    for p in data["per_pair"]:
        if p.get("status") != "ok":
            continue
        c = p.get("cosine")
        if c is None:
            continue
        # sent_history_id is the unique row key; eval rows are 1:1 with
        # sent_history backfill rows. Falling back to inbox_message_id
        # when sent_history_id is missing for very-old runs.
        key = str(p.get("sent_history_id") or p["inbox_message_id"])
        out[key] = float(c)
    return out


def paired_t(diffs: Sequence[float]) -> tuple[float, float]:
    n = len(diffs)
    if n < 2:
        return 0.0, 1.0
    mean = sum(diffs) / n
    sd = math.sqrt(sum((d - mean) ** 2 for d in diffs) / (n - 1))
    if sd == 0:
        return 0.0, 1.0
    se = sd / math.sqrt(n)
    t = mean / se
    # Two-sided p via normal approximation for large n; t-distribution would
    # need a tail integration. n>30 here so normal is within 1%.
    p = 2.0 * (1.0 - _norm_cdf(abs(t)))
    return t, p


def wilcoxon_signed_rank(diffs: Sequence[float]) -> tuple[float, float]:
    """Two-sided Wilcoxon signed-rank with continuity correction."""
    pairs = [d for d in diffs if d != 0]
    n = len(pairs)
    if n < 2:
        return 0.0, 1.0
    abs_sorted = sorted(((abs(d), d) for d in pairs), key=lambda x: x[0])
    # Ranks with ties: average rank for tied groups
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and abs_sorted[j + 1][0] == abs_sorted[i][0]:
            j += 1
        avg_rank = (i + 1 + j + 1) / 2.0
        for k in range(i, j + 1):
            ranks[k] = avg_rank
        i = j + 1
    w_plus = sum(r for r, (_, d) in zip(ranks, abs_sorted) if d > 0)
    w_minus = sum(r for r, (_, d) in zip(ranks, abs_sorted) if d < 0)
    w = min(w_plus, w_minus)
    mean_w = n * (n + 1) / 4.0
    sd_w = math.sqrt(n * (n + 1) * (2 * n + 1) / 24.0)
    # Continuity correction
    z = (w - mean_w + 0.5) / sd_w if w < mean_w else (w - mean_w - 0.5) / sd_w
    p = 2.0 * (1.0 - _norm_cdf(abs(z)))
    return z, p


def sign_test(diffs: Sequence[float]) -> tuple[int, int, int]:
    plus = sum(1 for d in diffs if d > 0)
    minus = sum(1 for d in diffs if d < 0)
    tied = sum(1 for d in diffs if d == 0)
    return plus, minus, tied


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: paired-stats.py <with-rag.json> <no-rag.json>", file=sys.stderr)
        return 2
    with_path, no_path = sys.argv[1], sys.argv[2]
    with_pairs = load_pairs(with_path)
    no_pairs = load_pairs(no_path)
    common = set(with_pairs) & set(no_pairs)
    diffs = sorted(with_pairs[k] - no_pairs[k] for k in common)
    n = len(diffs)
    if n == 0:
        print("no overlapping ok pairs", file=sys.stderr)
        return 1
    mean = sum(diffs) / n
    sd = math.sqrt(sum((d - mean) ** 2 for d in diffs) / (n - 1)) if n > 1 else 0.0
    mean_w = sum(with_pairs[k] for k in common) / n
    mean_n = sum(no_pairs[k] for k in common) / n
    t, p_t = paired_t(diffs)
    z, p_w = wilcoxon_signed_rank(diffs)
    plus, minus, tied = sign_test(diffs)
    print(f"with-rag  : {with_path}")
    print(f"no-rag    : {no_path}")
    print(f"with-rag ok: {len(with_pairs)}, no-rag ok: {len(no_pairs)}, paired: {n}")
    print()
    print(f"mean(with-RAG) : {mean_w:.4f}")
    print(f"mean(no-RAG)   : {mean_n:.4f}")
    print(f"mean(Δ)        : {mean:+.4f}")
    print(f"sd(Δ)          : {sd:.4f}")
    print(f"range(Δ)       : [{diffs[0]:+.4f}, {diffs[-1]:+.4f}]")
    print()
    print(f"Paired t-test (two-sided): t={t:+.3f}, p≈{p_t:.4f}")
    print(f"Wilcoxon signed-rank      : z={z:+.3f}, p≈{p_w:.4f}")
    print(f"Sign test                 : {plus} RAG-better / {minus} RAG-worse / {tied} tied ({plus / n * 100:.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
