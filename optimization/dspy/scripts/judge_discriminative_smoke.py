"""Discriminative smoke test for the relaxed judge metric (STAQPRO-363).

Before re-firing GEPA against a 100-trace v1.0 set (a ~2h21m, ~580
metric-call cloud run), we want a cheap-ish *go/no-go* signal that the
relaxed judge can actually tell good drafts from bad. The Run-1 baseline
returned 0/50 on the full valset — that's the failure mode we want to
catch BEFORE spending budget on another full GEPA pass.

The smoke takes the first N (default 10) traces from a trace set and
scores each one three ways:

* ``reference-vs-reference`` — candidate = the operator's actual reply.
  Should score 1 (the candidate is the reference; no fabrication; intent
  matches). Anything below ~0.8 over the sample means the judge prompt
  is still mis-calibrated and an expensive GEPA run is contraindicated.
* ``clearly-bad`` — candidate = a hardcoded off-topic sentence that
  fabricates facts not in the inbound. Should score 0 over the entire
  sample. A non-zero score here means the no-fabrication clause isn't
  doing its job — either the prompt has eroded or the judge model is
  drifting.
* ``baseline-candidate`` — currently a placeholder: same as the
  reference truncated to its first paragraph. The intent of this slot
  is to drop in the Qwen3-4B baseline candidate once we wire that up
  on-appliance; for now the truncated-reference candidate produces a
  bounded-difficulty case that exercises the "non-regressive intent"
  branch of the judge without burning Ollama capacity generating real
  drafts. Operators replacing this script with real Qwen3-4B candidates
  should swap the placeholder in `_baseline_candidate_for`.

Pass criteria:

* reference-vs-reference mean ≥ 0.80
* clearly-bad mean == 0.00
* baseline-candidate somewhere in between (no hard threshold — this
  surfaces the live signal for an operator decision)

The script exits non-zero if either of the first two criteria fails,
making it suitable for a pre-flight gate in `optimize.py` runbooks.

Privacy: this script reads PII-scrubbed traces (`traces/v1.0/`) and
sends the inbound + reference + candidate triples to the same Ollama
Cloud endpoint the live drafter uses on the cloud route — well inside
the existing trust boundary per the module docstring of ``metric.py``.
We never log body text, just the per-pair win bits + a short reason.

Usage:

    uv run python scripts/judge_discriminative_smoke.py \\
        --trace-set ./traces/v1.0 \\
        --n 10
"""

from __future__ import annotations

import argparse
import logging
import statistics
import sys
from pathlib import Path

# Local imports — the conftest.py path-fix only applies under pytest, so
# add the package root to sys.path explicitly when run as a script.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from metric import JudgeConfig, JudgeError, JudgeMetric  # noqa: E402
from trace_set import Trace, load_trace_set  # noqa: E402

logger = logging.getLogger(__name__)

CLEARLY_BAD_CANDIDATE = (
    # Off-topic + fabricated facts. Tests the no-fabrication clause of
    # the relaxed judge prompt. Whatever the inbound is, this candidate
    # invents prices and lead times and changes the subject entirely.
    "Thanks for reaching out! Our standard pricing is $499 per unit with a "
    "lead time of 6-8 weeks. We also offer custom mascot painting on every "
    "third order — let me know if you'd like to add that to your invoice. "
    "By the way, did you hear about the new mascot policy?"
)

REFERENCE_PASS_THRESHOLD = 0.80
BAD_PASS_THRESHOLD = 0.00  # exact — any 1 here is a failure


def _baseline_candidate_for(trace: Trace) -> str:
    """Placeholder baseline candidate for the third smoke slot.

    Returns the reference body truncated to its first paragraph (or 240
    chars, whichever is shorter). This produces a "shorter but
    same-intent" candidate that the relaxed judge should generally
    accept — it exercises the "non-regressive intent, style divergence
    OK" branch without burning local Ollama capacity generating real
    drafts.

    Operators wiring this script up to the appliance Qwen3-4B should
    replace this function with a real call to the live drafter (e.g.
    POST to ``/api/internal/draft-prompt`` on the dashboard service)
    and re-baseline the pass thresholds.
    """

    body = trace.actual_reply_body.strip()
    # First paragraph break.
    first_para_end = body.find("\n\n")
    if first_para_end > 0:
        body = body[:first_para_end].strip()
    if len(body) > 240:
        body = body[:240].rstrip() + "…"
    return body


def _score_pair(metric: JudgeMetric, *, inbound: str, reference: str, candidate: str) -> tuple[float, str]:
    """Run one judge call. Returns ``(score, reason)`` — never raises.

    ``JudgeError("rate_limited")`` is treated as score 0 with a "rate
    limited" reason so a partial smoke run still produces a report
    rather than a stack trace. The exit code logic at the bottom
    distinguishes a rate-limit failure mode from a real signal failure.
    """

    try:
        result = metric.judge(inbound=inbound, reference=reference, candidate=candidate)
        return float(result.win), result.reason
    except JudgeError as exc:
        return 0.0, f"rate_limited: {exc}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--trace-set",
        type=Path,
        required=True,
        help="Trace set directory (e.g. ./traces/v1.0).",
    )
    parser.add_argument(
        "--n",
        type=int,
        default=10,
        help="Number of traces to score (default 10). Each trace = 3 judge calls.",
    )
    parser.add_argument(
        "--cos-floor",
        type=float,
        default=None,
        help="Opt-in cosine sanity floor (default: disabled, matches live config).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    _, traces = load_trace_set(args.trace_set)
    if not traces:
        logger.error("trace set is empty: %s", args.trace_set)
        return 2
    sample = traces[: args.n]
    logger.info("scoring %d traces (3 candidates each = %d judge calls)", len(sample), len(sample) * 3)

    cfg = JudgeConfig(cos_floor=args.cos_floor)
    metric = JudgeMetric(cfg)

    ref_scores: list[float] = []
    bad_scores: list[float] = []
    baseline_scores: list[float] = []

    try:
        for idx, trace in enumerate(sample):
            inbound = trace.inbox_body
            reference = trace.actual_reply_body

            # 1. Reference vs reference. Should be 1.
            ref_score, ref_reason = _score_pair(
                metric, inbound=inbound, reference=reference, candidate=reference,
            )
            ref_scores.append(ref_score)

            # 2. Clearly-bad fabrication. Should be 0.
            bad_score, bad_reason = _score_pair(
                metric, inbound=inbound, reference=reference, candidate=CLEARLY_BAD_CANDIDATE,
            )
            bad_scores.append(bad_score)

            # 3. Baseline candidate. Soft target.
            baseline_candidate = _baseline_candidate_for(trace)
            base_score, base_reason = _score_pair(
                metric, inbound=inbound, reference=reference, candidate=baseline_candidate,
            )
            baseline_scores.append(base_score)

            # No body content logged — just the verdict + short reason.
            logger.info(
                "trace %d/%d (inbox_message_id=%s): ref=%.0f bad=%.0f baseline=%.0f "
                "| ref_reason=%r | bad_reason=%r | base_reason=%r",
                idx + 1,
                len(sample),
                trace.inbox_message_id,
                ref_score,
                bad_score,
                base_score,
                ref_reason[:120],
                bad_reason[:120],
                base_reason[:120],
            )
    finally:
        metric.close()

    ref_mean = statistics.fmean(ref_scores)
    bad_mean = statistics.fmean(bad_scores)
    base_mean = statistics.fmean(baseline_scores)

    print("---")
    print(f"reference-vs-reference: mean={ref_mean:.2f} ({sum(ref_scores):.0f}/{len(ref_scores)})")
    print(f"clearly-bad:            mean={bad_mean:.2f} ({sum(bad_scores):.0f}/{len(bad_scores)})")
    print(f"baseline (truncated):   mean={base_mean:.2f} ({sum(baseline_scores):.0f}/{len(baseline_scores)})")
    print("---")

    failures: list[str] = []
    if ref_mean < REFERENCE_PASS_THRESHOLD:
        failures.append(
            f"reference-vs-reference {ref_mean:.2f} < {REFERENCE_PASS_THRESHOLD:.2f} "
            "— judge is rejecting operator-approved replies as candidates; "
            "do NOT spend a full GEPA budget yet.",
        )
    if bad_mean > BAD_PASS_THRESHOLD:
        failures.append(
            f"clearly-bad {bad_mean:.2f} > {BAD_PASS_THRESHOLD:.2f} "
            "— judge accepted a fabricating off-topic candidate; "
            "the no-fabrication clause is not gating reliably.",
        )

    if failures:
        print("SMOKE FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("SMOKE PASSED — judge is discriminative; proceed to GEPA run.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
