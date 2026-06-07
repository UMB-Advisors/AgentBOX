#!/usr/bin/env python3
"""STAQPRO-329 — paired-stats for two RAG-eval JSON outputs across axes.

Generalizes staqpro-207-paired-stats.py (cosine-only) to handle the LLM-judge
axes that STAQPRO-220 added to the eval harness JSON shape. Same paired t-test
+ Wilcoxon signed-rank (normal approximation with continuity correction) +
sign test machinery, pure stdlib.

Axes supported (selected via --axis):

  cosine        — per_pair.cosine (filters on status == 'ok')
  judge_score   — per_pair.judge_score (sum voice+facts+length, 0-9)
                  filters on judge_status == 'ok'
  judge_voice   — per_pair.judge_voice (0-3)
  judge_facts   — per_pair.judge_facts (0-3)
  judge_length  — per_pair.judge_length (0-3)

Pair indexing is by sent_history_id (1:1 with sent_history backfill rows),
matching staqpro-207-paired-stats.py.

Usage:

    python3 dashboard/scripts/staqpro-329-paired-stats.py \\
      --axis cosine \\
      eval-results/rag-eval-<ts>-with-rag-judge-haiku.json \\
      eval-results/rag-eval-<ts>-no-rag-judge-haiku.json

    # Run all axes back-to-back:
    for ax in cosine judge_score judge_voice judge_facts judge_length; do
      python3 dashboard/scripts/staqpro-329-paired-stats.py --axis $ax \\
        <with-rag>.json <no-rag>.json
    done
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Sequence

AXES = ("cosine", "judge_score", "judge_voice", "judge_facts", "judge_length")


def load_pairs(path: str, axis: str) -> dict[str, float]:
    with open(path) as f:
        data = json.load(f)
    out: dict[str, float] = {}
    for p in data["per_pair"]:
        if axis == "cosine":
            if p.get("status") != "ok":
                continue
            v = p.get("cosine")
        else:
            if p.get("judge_status") != "ok":
                continue
            v = p.get(axis)
        if v is None:
            continue
        key = str(p.get("sent_history_id") or p["inbox_message_id"])
        out[key] = float(v)
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
    p = 2.0 * (1.0 - _norm_cdf(abs(t)))
    return t, p


def wilcoxon_signed_rank(diffs: Sequence[float]) -> tuple[float, float]:
    pairs = [d for d in diffs if d != 0]
    n = len(pairs)
    if n < 2:
        return 0.0, 1.0
    abs_sorted = sorted(((abs(d), d) for d in pairs), key=lambda x: x[0])
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--axis", choices=AXES, default="cosine")
    ap.add_argument("with_rag", help="Path to with-RAG eval JSON")
    ap.add_argument("no_rag", help="Path to no-RAG eval JSON")
    args = ap.parse_args()

    with_pairs = load_pairs(args.with_rag, args.axis)
    no_pairs = load_pairs(args.no_rag, args.axis)
    common = sorted(set(with_pairs) & set(no_pairs))
    diffs = [with_pairs[k] - no_pairs[k] for k in common]
    n = len(diffs)
    if n == 0:
        print(f"axis={args.axis}: no overlapping ok pairs", file=sys.stderr)
        return 1
    diffs_sorted = sorted(diffs)
    mean_d = sum(diffs) / n
    sd = math.sqrt(sum((d - mean_d) ** 2 for d in diffs) / (n - 1)) if n > 1 else 0.0
    mean_w = sum(with_pairs[k] for k in common) / n
    mean_n = sum(no_pairs[k] for k in common) / n
    t, p_t = paired_t(diffs)
    z, p_w = wilcoxon_signed_rank(diffs)
    plus, minus, tied = sign_test(diffs)

    print(f"=== axis={args.axis} ===")
    print(f"with-rag  : {args.with_rag}")
    print(f"no-rag    : {args.no_rag}")
    print(f"with-rag ok: {len(with_pairs)}, no-rag ok: {len(no_pairs)}, paired: {n}")
    print()
    print(f"mean(with-RAG) : {mean_w:.4f}")
    print(f"mean(no-RAG)   : {mean_n:.4f}")
    print(f"mean(Δ)        : {mean_d:+.4f}")
    print(f"sd(Δ)          : {sd:.4f}")
    print(f"range(Δ)       : [{diffs_sorted[0]:+.4f}, {diffs_sorted[-1]:+.4f}]")
    print()
    print(f"Paired t-test (two-sided): t={t:+.3f}, p≈{p_t:.4f}")
    print(f"Wilcoxon signed-rank      : z={z:+.3f}, p≈{p_w:.4f}")
    print(f"Sign test                 : {plus} RAG-better / {minus} RAG-worse / {tied} tied ({plus / n * 100:.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
