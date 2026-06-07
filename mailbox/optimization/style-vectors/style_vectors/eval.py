"""Blind-preference-READY evaluation harness for a style vector.

Loads §5.8 traces (a directory of ``*.trace.json`` files mirroring the
canonical TS trace schema — see ``dashboard/lib/eval/trace-set.ts``), and for
each trace generates a **base** continuation and a **base+vector** (steered)
continuation off the inbound. Both outputs are written to a JSONL file along
with per-trace tokens/sec, and an aggregate t/s is emitted so the
≥15-tokens/sec kill criterion can be checked.

What this harness deliberately does NOT do: pick a winner. Blind preference
("does the steered draft read more like the operator?") requires a human or an
LLM judge, neither of which this prototype fabricates. The JSONL it emits is
*ready* for that scoring step — each row carries the inbound, the operator's
actual reply (the reference), and the two candidate outputs in a neutral
``candidate_a`` / ``candidate_b`` framing with the mapping recorded separately
so the eventual scorer can be run blind. We refuse to invent a win-rate; see
the ``note`` field in the summary.

Privacy: traces carry PII-scrubbed customer email bodies. This harness reads
and re-emits body text into the JSONL (that's the point — it's the material a
human judge needs), so the output JSONL inherits the same customer-private
status as the trace set. Never commit it; write it under a gitignored path.
"""

from __future__ import annotations

import json
import logging
import random
import statistics
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal

from pydantic import BaseModel, ConfigDict, Field

from .extract import LoadedModel
from .steer import GenerationResult, generate

logger = logging.getLogger(__name__)

# The single kill-criterion threshold from the MBOX-118 issue. Steered
# generation slower than this on the target hardware fails the throughput gate
# regardless of quality.
KILL_CRITERION_MIN_TPS: float = 15.0


class EvalTrace(BaseModel):
    """The subset of the canonical trace schema this harness needs.

    Mirrors the TS ``Trace`` fields the issue calls out — ``workflow_category``,
    ``classification``, ``inbox_body``, ``actual_reply_body`` — and tolerates
    the rest of the canonical trace via ``extra="ignore"`` so a real
    ``*.trace.json`` (which also carries provenance, ids, timestamps) loads
    without a full schema mirror here.
    """

    model_config = ConfigDict(extra="ignore")

    workflow_category: str
    classification: str | None = None
    inbox_message_id: str | None = None
    inbox_subject: str | None = None
    inbox_body: str
    actual_reply_body: str


def load_eval_traces(directory: Path) -> list[EvalTrace]:
    """Read every ``*.trace.json`` under ``directory`` into ``EvalTrace``.

    Intentionally lighter than ``trace_set.load_trace_set`` — this harness
    doesn't verify SHAs (it's read-only over content the operator already
    fetched), it just needs the four fields above. Files that fail validation
    are logged and skipped rather than aborting the whole run.
    """

    if not directory.is_dir():
        raise NotADirectoryError(f"trace dir not found: {directory}")

    traces: list[EvalTrace] = []
    for path in sorted(directory.glob("*.trace.json")):
        try:
            traces.append(EvalTrace.model_validate_json(path.read_text(encoding="utf-8")))
        except Exception as exc:  # noqa: BLE001 - skip-and-log, don't abort
            logger.warning("skipping unparseable trace %s: %s", path.name, exc)
    return traces


def build_prompt(trace: EvalTrace) -> str:
    """Render the inbound into the drafting prompt.

    Kept intentionally minimal and self-contained — the spike measures the
    *steering delta* between base and base+vector on the SAME prompt, so the
    absolute prompt wording is not load-bearing as long as it's identical for
    both generations.
    """

    subject = trace.inbox_subject or "(no subject)"
    return (
        "You are drafting a reply to the following email. "
        "Write only the reply body.\n\n"
        f"Subject: {subject}\n"
        f"Email:\n{trace.inbox_body}\n\n"
        "Reply:"
    )


@dataclass
class EvalRow:
    """One trace evaluated base vs steered. ``ab_map`` records which blind
    label (candidate_a / candidate_b) corresponds to which condition so a
    downstream scorer can run blind and the operator can de-blind afterward."""

    inbox_message_id: str | None
    workflow_category: str
    classification: str | None
    prompt: str
    reference_reply: str
    base_output: str
    steered_output: str
    base_tps: float
    steered_tps: float
    candidate_a: str
    candidate_b: str
    ab_map: dict[str, Literal["base", "steered"]]

    def to_jsonl_obj(self) -> dict[str, Any]:
        return {
            "inbox_message_id": self.inbox_message_id,
            "workflow_category": self.workflow_category,
            "classification": self.classification,
            "prompt": self.prompt,
            "reference_reply": self.reference_reply,
            "base_output": self.base_output,
            "steered_output": self.steered_output,
            "base_tokens_per_second": round(self.base_tps, 3),
            "steered_tokens_per_second": round(self.steered_tps, 3),
            # Blind-pref framing: a human/judge scores candidate_a vs
            # candidate_b without knowing which is steered; ab_map de-blinds.
            "candidate_a": self.candidate_a,
            "candidate_b": self.candidate_b,
            "ab_map": self.ab_map,
        }


@dataclass
class EvalSummary:
    """Aggregate result. No win-rate by design (see ``note``)."""

    n_traces: int
    mean_base_tps: float
    mean_steered_tps: float
    min_steered_tps: float
    kill_criterion_min_tps: float
    meets_throughput_gate: bool
    note: str

    def to_obj(self) -> dict[str, Any]:
        return {
            "n_traces": self.n_traces,
            "mean_base_tokens_per_second": round(self.mean_base_tps, 3),
            "mean_steered_tokens_per_second": round(self.mean_steered_tps, 3),
            "min_steered_tokens_per_second": round(self.min_steered_tps, 3),
            "kill_criterion_min_tps": self.kill_criterion_min_tps,
            "meets_throughput_gate": self.meets_throughput_gate,
            "note": self.note,
        }


def evaluate(
    loaded: LoadedModel,
    traces: Iterable[EvalTrace],
    *,
    vector: Any,
    layer: int,
    lam: float,
    max_new_tokens: int = 128,
    seed: int = 1,
) -> tuple[list[EvalRow], EvalSummary]:
    """Generate base vs base+vector for each trace; return rows + summary.

    The base generation uses ``lam=0`` (no hook) and the steered generation
    uses the supplied ``lam`` + ``vector`` at ``layer``. A per-trace RNG seed
    derived from ``seed`` decides the blind A/B label assignment so the JSONL
    is shuffled but reproducible.
    """

    rng = random.Random(seed)
    rows: list[EvalRow] = []
    base_tps_all: list[float] = []
    steered_tps_all: list[float] = []

    for trace in traces:
        prompt = build_prompt(trace)
        base = generate(
            loaded, prompt, vector=None, layer=layer, lam=0.0,
            max_new_tokens=max_new_tokens,
        )
        steered = generate(
            loaded, prompt, vector=vector, layer=layer, lam=lam,
            max_new_tokens=max_new_tokens,
        )
        base_tps_all.append(base.tokens_per_second)
        steered_tps_all.append(steered.tokens_per_second)

        # Blind A/B: coin-flip which condition is candidate_a.
        steered_is_a = rng.random() < 0.5
        if steered_is_a:
            candidate_a, candidate_b = steered.text, base.text
            ab_map = {"candidate_a": "steered", "candidate_b": "base"}
        else:
            candidate_a, candidate_b = base.text, steered.text
            ab_map = {"candidate_a": "base", "candidate_b": "steered"}

        rows.append(
            EvalRow(
                inbox_message_id=trace.inbox_message_id,
                workflow_category=trace.workflow_category,
                classification=trace.classification,
                prompt=prompt,
                reference_reply=trace.actual_reply_body,
                base_output=base.text,
                steered_output=steered.text,
                base_tps=base.tokens_per_second,
                steered_tps=steered.tokens_per_second,
                candidate_a=candidate_a,
                candidate_b=candidate_b,
                ab_map=ab_map,  # type: ignore[arg-type]
            )
        )

    n = len(rows)
    mean_base = statistics.fmean(base_tps_all) if base_tps_all else 0.0
    mean_steered = statistics.fmean(steered_tps_all) if steered_tps_all else 0.0
    min_steered = min(steered_tps_all) if steered_tps_all else 0.0
    summary = EvalSummary(
        n_traces=n,
        mean_base_tps=mean_base,
        mean_steered_tps=mean_steered,
        min_steered_tps=min_steered,
        kill_criterion_min_tps=KILL_CRITERION_MIN_TPS,
        meets_throughput_gate=mean_steered >= KILL_CRITERION_MIN_TPS,
        note=(
            "Win-rate intentionally NOT computed: blind preference requires a "
            "human or LLM judge. This JSONL is blind-pref-READY — score "
            "candidate_a vs candidate_b without ab_map, then de-blind. The "
            "throughput gate above is the only automatically-checkable "
            "kill criterion (MBOX-118: t/s < 15 kills the approach)."
        ),
    )
    return rows, summary


def write_jsonl(rows: Iterable[EvalRow], summary: EvalSummary, out_path: Path) -> None:
    """Write the blind-pref-ready rows + a trailing summary object as JSONL.

    The summary is emitted as a final line tagged ``{"_summary": ...}`` so a
    line-oriented reader can both stream rows and recover the aggregate.
    """

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row.to_jsonl_obj(), ensure_ascii=False) + "\n")
        fh.write(json.dumps({"_summary": summary.to_obj()}, ensure_ascii=False) + "\n")


__all__ = [
    "KILL_CRITERION_MIN_TPS",
    "EvalRow",
    "EvalSummary",
    "EvalTrace",
    "build_prompt",
    "evaluate",
    "load_eval_traces",
    "write_jsonl",
]
