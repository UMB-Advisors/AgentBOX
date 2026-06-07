"""GEPA optimization entry point.

CLI:

    uv run python -m optimize \\
        --trace-set ./traces/v1.0 \\
        --target-base-url http://localhost:11434 \\
        --target-model qwen3:4b-ctx4k \\
        --out outputs/run-$(date +%s) \\
        --auto light

What this does:

1. Loads the trace set via ``trace_set.load_trace_set`` (verifies SHAs).
2. Splits traces into ``trainset`` / ``valset`` (configurable, default 50/50
   split with a stable seed so multiple runs against the same set are
   comparable).
3. Builds a DSPy ``Predict(DraftReply)`` module bound to the **target**
   model (the model whose prompt we're optimizing — Qwen3 by default per
   STAQPRO-343 first-pass scope).
4. Builds a separate ``dspy.LM`` for the **reflection** model — the LM GEPA
   uses to propose prompt mutations. Defaults to Ollama Cloud
   ``gpt-oss:120b`` (same endpoint + model as the judge — by design;
   reflection benefits from a stronger model than the target, and
   reusing the live alt-cloud drafter endpoint keeps the optimization
   toolchain to one cloud vendor).
5. Runs ``GEPA.compile(program, trainset=, valset=)``.
6. Dumps the optimized program JSON to ``outputs/<run>/program.json``,
   extracts the optimized signature instructions into a portable
   ``prompts/draft-reply.yaml`` template, and writes a ``report.md`` with
   pre/post win rates.

Privacy: outputs/ is gitignored. The extracted prompts/ template should
NOT include few-shot exemplars containing raw customer email fragments —
the extraction step strips those by design and the operator should review
the committed YAML before pushing it to a public repo.

Stop-gate: this module is the harness. A real GEPA run requires the
operator to (a) fetch a real trace set from the appliance and (b) supply
OLLAMA_CLOUD_API_KEY. See README.md "Operator runbook" for the fetch flow.
"""

from __future__ import annotations

import json
import logging
import os
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import click
import dspy
import yaml

from metric import JudgeConfig, JudgeMetric
from signatures import DraftReply
from trace_set import Trace, load_trace_set

logger = logging.getLogger(__name__)


# Operator persona defaults — used when a trace doesn't carry persona context
# (today: none do; persona is per-appliance, not per-trace). For the v0.1 run
# we use the Heron Labs Customer #1 defaults. Operators running against a
# different appliance should pass ``--persona-yaml <path>`` with their own
# values.
DEFAULT_PERSONA = {
    "operator_first_name": "Eric",
    "operator_brand": "Heron Labs",
    "business_description": "small-batch CPG operator",
    "tone": "concise, direct, warm",
    "signoff": "— Eric",
}


@dataclass
class SplitConfig:
    """Train / validation split. GEPA uses trainset for mutation feedback and
    valset for Pareto frontier tracking."""

    train_fraction: float = 0.5
    seed: int = 1


def split_traces(traces: list[Trace], config: SplitConfig) -> tuple[list[Trace], list[Trace]]:
    """Shuffle + split traces. Stable for a given (count, seed) tuple."""

    rng = random.Random(config.seed)
    indices = list(range(len(traces)))
    rng.shuffle(indices)
    cutoff = max(1, int(len(traces) * config.train_fraction))
    train_idx = set(indices[:cutoff])
    train = [t for i, t in enumerate(traces) if i in train_idx]
    val = [t for i, t in enumerate(traces) if i not in train_idx]
    # Edge case: with very small trace sets (n<2) valset can be empty; GEPA
    # tolerates a missing valset by reusing trainset, but we mirror that
    # explicitly here so the caller sees what's happening.
    if not val:
        val = train
    return train, val


def traces_to_examples(traces: list[Trace], persona: dict[str, str]) -> list[dspy.Example]:
    """Convert ``Trace`` instances to ``dspy.Example`` objects.

    Example shape matches the ``DraftReply`` signature inputs + the
    reference ``reply_body`` output. The reference is set via
    ``with_inputs(...)``-then-discarded-as-output convention: the metric
    pulls ``example.reply_body`` directly, so the field name matters.
    """

    examples: list[dspy.Example] = []
    for t in traces:
        category = (t.classification or "inquiry").strip() or "inquiry"
        ex = dspy.Example(
            operator_first_name=persona["operator_first_name"],
            operator_brand=persona["operator_brand"],
            business_description=persona["business_description"],
            tone=persona["tone"],
            signoff=persona["signoff"],
            category=category,
            from_addr=t.inbox_from or "",
            to_addr="",  # not in trace; harmless empty
            subject=t.inbox_subject or "",
            inbound_body=t.inbox_body,
            reply_body=t.actual_reply_body,
        ).with_inputs(
            "operator_first_name",
            "operator_brand",
            "business_description",
            "tone",
            "signoff",
            "category",
            "from_addr",
            "to_addr",
            "subject",
            "inbound_body",
        )
        examples.append(ex)
    return examples


def build_target_lm(base_url: str, model: str, api_key: str | None) -> dspy.LM:
    """Build the DSPy LM the optimized program will call against.

    For the v0.1 first-pass run this is Qwen3 on Ollama. DSPy 2.x speaks
    OpenAI-compatible JSON to any endpoint that implements `/v1/chat/completions`;
    Ollama exposes that surface, so we use the ``openai/<model>`` provider
    convention with the Ollama URL as ``api_base``.
    """

    return dspy.LM(
        model=f"openai/{model}",
        api_base=f"{base_url.rstrip('/')}/v1",
        api_key=api_key or "ollama",  # ollama doesn't check the key but DSPy requires one
        max_tokens=600,
        temperature=0.7,
    )


def build_reflection_lm() -> dspy.LM:
    """LM that GEPA uses to propose prompt mutations.

    Ollama Cloud ``gpt-oss:120b`` — same endpoint + model as the judge by
    design, since reflection benefits from a stronger LM than the target
    and we want one cloud-vendor dependency, not two. Hits Ollama Cloud's
    OpenAI-compatible surface at ``https://ollama.com/v1`` via DSPy's
    LiteLLM-backed ``openai/<model>`` provider convention.
    ``OLLAMA_CLOUD_API_KEY`` must be set in the environment.
    """

    api_key = os.environ.get("OLLAMA_CLOUD_API_KEY")
    if not api_key:
        # Defensive: build_target_lm tolerates a missing key (local Ollama
        # ignores it) but reflection genuinely needs Ollama Cloud. Fail with
        # a clear message before GEPA starts spending budget.
        raise RuntimeError(
            "OLLAMA_CLOUD_API_KEY not set — required for the Ollama Cloud "
            "gpt-oss:120b reflection LM.",
        )
    return dspy.LM(
        model="openai/gpt-oss:120b",
        api_base="https://ollama.com/v1",
        api_key=api_key,
        max_tokens=8000,
        temperature=1.0,
    )


def extract_prompt_template(program: dspy.Module) -> dict[str, Any]:
    """Extract the optimized signature instructions into a portable dict.

    What we extract:
      * the ``DraftReply`` signature's instructions (the surface GEPA
        optimizes)
      * the field descriptions (which GEPA may also mutate)

    What we deliberately DO NOT extract:
      * any compiled few-shot demonstrations. DSPy's ``Predict`` stores
        demos as the actual examples used during optimization — these may
        quote real customer email fragments verbatim, which would commit
        raw customer content to the public repo if checked in.

    Returns a dict suitable for ``yaml.safe_dump`` or runtime consumption.
    """

    # Walk the program for the DraftReply predictor. DSPy exposes
    # ``named_predictors()`` since 2.x for this. We assume single-predictor
    # for v0.1; a multi-predictor program will need a more careful walk.
    predictors = list(program.named_predictors())
    if not predictors:
        raise RuntimeError("optimized program has no predictors")
    if len(predictors) > 1:
        # v0.1 ships single-signature programs only.
        names = [n for n, _ in predictors]
        raise RuntimeError(
            f"expected single predictor for v0.1, got {len(predictors)}: {names!r}",
        )
    name, predictor = predictors[0]
    sig = predictor.signature

    fields: dict[str, dict[str, str]] = {}
    for field_name, field in sig.fields.items():
        # DSPy 2.x exposes fields as pydantic v2 FieldInfo. Description lives
        # at field.json_schema_extra (DSPy-stamped) or field.description.
        desc = (
            getattr(field, "description", None)
            or (field.json_schema_extra or {}).get("desc")
            or ""
        )
        # We avoid exporting the raw input/output prefix because those are
        # internal DSPy adapter labels, not the operator-meaningful surface.
        fields[field_name] = {"description": str(desc)}

    return {
        "predictor_name": name,
        "signature": str(sig.__name__) if hasattr(sig, "__name__") else "DraftReply",
        "instructions": sig.instructions,
        "fields": fields,
    }


@dataclass
class RunResult:
    """Outcome summary of an ``optimize.run()`` invocation."""

    train_count: int
    val_count: int
    pre_win_rate: float
    post_win_rate: float
    program_path: Path
    prompt_path: Path
    report_path: Path


def evaluate_program(
    program: dspy.Module,
    examples: list[dspy.Example],
    metric: JudgeMetric,
    *,
    max_eval: int | None = None,
) -> float:
    """Compute win rate of ``program`` on ``examples`` using ``metric``.

    Sequential evaluation — keeps the judge calls in a tight loop with one
    in-flight Ollama Cloud request at a time. For 50-200 traces this is
    fine; a future iteration may want ``num_threads`` parallelism if we
    ever optimize against a 1000-trace set.
    """

    cap = max_eval if max_eval is not None else len(examples)
    wins = 0
    used = 0
    for ex in examples[:cap]:
        try:
            prediction = program(**{k: ex[k] for k in ex.inputs().keys()})
        except Exception as exc:  # noqa: BLE001 — fail-soft, attribute the failure
            logger.warning("target program call failed: %s", exc)
            continue
        used += 1
        if metric(ex, prediction) >= 0.5:
            wins += 1
    return (wins / used) if used else 0.0


@click.command()
@click.option(
    "--trace-set",
    "trace_set_dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    required=True,
    help="Directory containing manifest.json + *.trace.json files.",
)
@click.option(
    "--target-base-url",
    default="http://localhost:11434",
    show_default=True,
    help="Base URL of the target Ollama (the model GEPA optimizes against).",
)
@click.option(
    "--target-model",
    default="qwen3:4b-ctx4k",
    show_default=True,
    help="Target model tag for the first-pass run.",
)
@click.option(
    "--target-api-key",
    default=None,
    help="API key for the target endpoint (unused for local Ollama).",
)
@click.option(
    "--out",
    "out_dir",
    type=click.Path(file_okay=False, path_type=Path),
    required=True,
    help="Output directory for program JSON + report + prompt template.",
)
@click.option(
    "--auto",
    type=click.Choice(["light", "medium", "heavy"]),
    default="light",
    show_default=True,
    help="GEPA auto mode (controls budget — see DSPy docs).",
)
@click.option(
    "--cos-floor",
    type=float,
    default=None,
    help=(
        "Opt-in cosine sanity floor for the judge metric. Disabled by "
        "default since STAQPRO-363 — the floor was rejecting "
        "style-divergent but semantically-equivalent pairs. Set e.g. "
        "``--cos-floor 0.30`` to re-enable for diagnostic runs."
    ),
)
@click.option(
    "--disable-cosine",
    is_flag=True,
    default=False,
    help=(
        "Force the cosine sanity floor off regardless of ``--cos-floor``. "
        "Cosine is already off by default since STAQPRO-363; this flag is "
        "kept for backward compatibility with older invocations."
    ),
)
@click.option(
    "--train-fraction",
    type=float,
    default=0.5,
    show_default=True,
    help="Fraction of traces used for trainset (rest = valset).",
)
@click.option(
    "--seed",
    type=int,
    default=1,
    show_default=True,
    help="Split seed — same seed + same trace set ⇒ same split.",
)
@click.option(
    "--persona-yaml",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    default=None,
    help="Optional YAML file overriding the default Heron Labs persona.",
)
@click.option(
    "--max-eval",
    type=int,
    default=None,
    help="Cap on examples to evaluate pre/post (debug aid; default: full valset).",
)
def main(
    trace_set_dir: Path,
    target_base_url: str,
    target_model: str,
    target_api_key: str | None,
    out_dir: Path,
    auto: str,
    cos_floor: float | None,
    disable_cosine: bool,
    train_fraction: float,
    seed: int,
    persona_yaml: Path | None,
    max_eval: int | None,
) -> None:
    """Run GEPA optimization end-to-end. See module docstring for the pipeline."""

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Load + validate trace set.
    logger.info("loading trace set from %s", trace_set_dir)
    manifest, traces = load_trace_set(trace_set_dir)
    logger.info("loaded %d traces (set_sha256=%s)", manifest.count, manifest.set_sha256[:12])

    # 2. Resolve persona.
    persona = dict(DEFAULT_PERSONA)
    if persona_yaml is not None:
        with persona_yaml.open("r", encoding="utf-8") as fh:
            persona.update(yaml.safe_load(fh) or {})

    # 3. Split + convert to dspy.Example.
    train_traces, val_traces = split_traces(traces, SplitConfig(train_fraction=train_fraction, seed=seed))
    trainset = traces_to_examples(train_traces, persona)
    valset = traces_to_examples(val_traces, persona)
    logger.info("split: train=%d val=%d", len(trainset), len(valset))

    # 4. Build LMs + metric.
    target_lm = build_target_lm(target_base_url, target_model, target_api_key)
    reflection_lm = build_reflection_lm()
    dspy.configure(lm=target_lm)

    judge_cfg = JudgeConfig(disable_cosine=disable_cosine)
    if cos_floor is not None:
        judge_cfg.cos_floor = cos_floor
    metric = JudgeMetric(judge_cfg)

    # 5. Build the program and capture pre-optimization win rate.
    program = dspy.Predict(DraftReply)
    logger.info("evaluating pre-optimization baseline on valset")
    pre_win_rate = evaluate_program(program, valset, metric, max_eval=max_eval)
    logger.info("pre-optimization win rate: %.3f", pre_win_rate)

    # 6. Run GEPA.
    # ``track_stats=True`` records candidate-by-candidate Pareto info into the
    # program's ``.trial_logs`` / ``.detailed_results`` attributes for the
    # report. Reflection minibatch defaults work fine for v0.1; expose them
    # as CLI knobs once we have enough runs to know what to tune.
    logger.info("starting GEPA compile (auto=%s)", auto)
    optimizer = dspy.GEPA(
        metric=metric,
        auto=auto,
        reflection_lm=reflection_lm,
        track_stats=True,
    )
    optimized = optimizer.compile(program, trainset=trainset, valset=valset)
    logger.info("GEPA compile complete")

    # 7. Post-optimization evaluation.
    logger.info("evaluating post-optimization win rate on valset")
    post_win_rate = evaluate_program(optimized, valset, metric, max_eval=max_eval)
    logger.info("post-optimization win rate: %.3f", post_win_rate)

    # 8. Persist outputs.
    program_path = out_dir / "program.json"
    optimized.save(str(program_path))
    prompt_template = extract_prompt_template(optimized)
    prompt_path = out_dir / "prompt-draft-reply.yaml"
    with prompt_path.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(prompt_template, fh, sort_keys=False)

    # 9. Report.
    report_path = out_dir / "report.md"
    report = (
        f"# GEPA optimization report — STAQPRO-343 v0.1\n\n"
        f"- Trace set: `{trace_set_dir}` (set_sha256=`{manifest.set_sha256}`)\n"
        f"- Manifest: count={manifest.count}, source_appliance={manifest.source_appliance}\n"
        f"- Split: train={len(trainset)} val={len(valset)} (seed={seed}, frac={train_fraction})\n"
        f"- Target: `{target_model}` @ `{target_base_url}`\n"
        f"- Judge: `gpt-oss:120b` (Ollama Cloud)\n"
        f"- GEPA auto: `{auto}`\n\n"
        f"## Win rate\n\n"
        f"- Pre-optimization:  **{pre_win_rate:.3f}**\n"
        f"- Post-optimization: **{post_win_rate:.3f}**\n"
        f"- Lift:              **{post_win_rate - pre_win_rate:+.3f}**\n\n"
        f"## Artifacts\n\n"
        f"- Compiled program: `{program_path.name}`\n"
        f"- Portable prompt template: `{prompt_path.name}`\n\n"
        f"## Notes\n\n"
        f"- Pre/post are evaluated on the SAME valset with the SAME judge config.\n"
        f"- The portable prompt template strips few-shot demos. Operator must "
        f"review before any non-private copy of the template lands in a public repo.\n"
    )
    report_path.write_text(report, encoding="utf-8")
    logger.info("wrote report to %s", report_path)

    metric.close()

    # Print the bottom-line numbers so a CI tail catches them.
    print(f"PRE  win_rate={pre_win_rate:.3f}")
    print(f"POST win_rate={post_win_rate:.3f}")
    print(f"LIFT {post_win_rate - pre_win_rate:+.3f}")


if __name__ == "__main__":
    main()
