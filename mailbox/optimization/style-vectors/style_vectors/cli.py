"""click CLI for the style-vector spike.

    uv run python -m style_vectors.cli extract \\
        --pairs ./pairs.json --model sshleifer/tiny-gpt2 \\
        --layer 4 --variant naive --out vec.npy

    uv run python -m style_vectors.cli steer-demo \\
        --prompt "Hi, when will my reorder ship?" \\
        --vector vec.npy --layer 4 --lam 6.0

    uv run python -m style_vectors.cli eval \\
        --trace-dir ./traces/v1.0 --vector vec.npy \\
        --layer 4 --lam 6.0 --out outputs/eval.jsonl

All three subcommands load a real HuggingFace model. For a no-GPU / no-network
smoke, pass ``--model sshleifer/tiny-gpt2`` (the same tiny model the unit tests
use). Nothing here ever runs on the appliance.

A style vector ``.npy`` is paired with a ``<name>.meta.json`` sidecar carrying
the layer / model / variant / hidden_size it was extracted at; steer-demo and
eval read it to assert the vector is being injected into a compatible model
and layer before doing anything.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import click
import numpy as np
import torch

from .eval import evaluate, load_eval_traces, write_jsonl
from .extract import (
    ContrastPair,
    StyleVectorMeta,
    extract_naive,
    extract_steerx,
    load_model,
)
from .steer import generate

logger = logging.getLogger(__name__)


def _meta_path(vector_path: Path) -> Path:
    return vector_path.with_suffix(".meta.json")


def _save_vector(vector: np.ndarray, meta: StyleVectorMeta, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    np.save(out, vector)
    _meta_path(out).write_text(meta.model_dump_json(indent=2) + "\n", encoding="utf-8")


def _load_vector(vector_path: Path) -> tuple[np.ndarray, StyleVectorMeta]:
    vector = np.load(vector_path)
    meta_path = _meta_path(vector_path)
    if not meta_path.is_file():
        raise click.ClickException(
            f"missing meta sidecar {meta_path.name}; re-run `extract` to regenerate it"
        )
    meta = StyleVectorMeta.model_validate_json(meta_path.read_text(encoding="utf-8"))
    return vector, meta


@click.group()
def cli() -> None:
    """Contrastive activation-steering (style-vector) spike — MBOX-118."""

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


@cli.command()
@click.option(
    "--pairs",
    "pairs_path",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="JSON file: list of {generic_draft_text, approved_reply_text, inbox_message_id?}.",
)
@click.option("--model", "model_id", required=True, help="HuggingFace model id.")
@click.option("--layer", required=True, type=int, help="Decoder layer index to hook.")
@click.option(
    "--variant",
    type=click.Choice(["naive", "steerx"]),
    default="naive",
    show_default=True,
    help="naive=StyleVector (all-token mean); steerx=preference-token weighted.",
)
@click.option(
    "--out",
    required=True,
    type=click.Path(dir_okay=False, path_type=Path),
    help="Output .npy path (a .meta.json sidecar is written alongside).",
)
@click.option("--device", default="cpu", show_default=True)
def extract(
    pairs_path: Path,
    model_id: str,
    layer: int,
    variant: str,
    out: Path,
    device: str,
) -> None:
    """Extract a style vector from contrast pairs -> .npy + .meta.json."""

    raw = json.loads(pairs_path.read_text(encoding="utf-8"))
    pairs = [ContrastPair.model_validate(p) for p in raw]
    loaded = load_model(model_id, device=device)
    extractor = extract_naive if variant == "naive" else extract_steerx
    result = extractor(loaded, pairs, layer=layer, model_id=model_id)
    _save_vector(result.as_numpy(), result.meta, out)
    click.echo(
        f"wrote {out} (dim={result.meta.hidden_size}, layer={layer}, "
        f"variant={variant}, n_pairs={result.meta.n_pairs}, "
        f"norm={result.meta.norm:.4f})"
    )


@cli.command(name="steer-demo")
@click.option("--prompt", required=True, help="Prompt to continue.")
@click.option(
    "--vector",
    "vector_path",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="Style vector .npy (with .meta.json sidecar).",
)
@click.option(
    "--layer",
    type=int,
    default=None,
    help="Layer to inject at (default: the layer recorded in .meta.json).",
)
@click.option("--lam", type=float, default=6.0, show_default=True, help="Steering strength.")
@click.option("--max-new-tokens", type=int, default=128, show_default=True)
@click.option("--device", default="cpu", show_default=True)
def steer_demo(
    prompt: str,
    vector_path: Path,
    layer: int | None,
    lam: float,
    max_new_tokens: int,
    device: str,
) -> None:
    """Show base vs steered generation side by side."""

    vector, meta = _load_vector(vector_path)
    use_layer = layer if layer is not None else meta.layer
    loaded = load_model(meta.model, device=device)
    if vector.shape[0] != loaded.hidden_size:
        raise click.ClickException(
            f"vector dim {vector.shape[0]} != model hidden_size {loaded.hidden_size}"
        )
    vec = torch.from_numpy(vector)

    base = generate(loaded, prompt, vector=None, layer=use_layer, lam=0.0,
                    max_new_tokens=max_new_tokens)
    steered = generate(loaded, prompt, vector=vec, layer=use_layer, lam=lam,
                       max_new_tokens=max_new_tokens)

    click.echo(f"--- base (lam=0, {base.tokens_per_second:.1f} t/s) ---")
    click.echo(base.text)
    click.echo(f"\n--- steered (lam={lam}, layer={use_layer}, "
               f"{steered.tokens_per_second:.1f} t/s) ---")
    click.echo(steered.text)


@cli.command(name="eval")
@click.option(
    "--trace-dir",
    required=True,
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    help="Directory of *.trace.json files (§5.8 trace schema).",
)
@click.option(
    "--vector",
    "vector_path",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="Style vector .npy (with .meta.json sidecar).",
)
@click.option(
    "--layer",
    type=int,
    default=None,
    help="Layer to inject at (default: the layer recorded in .meta.json).",
)
@click.option("--lam", type=float, default=6.0, show_default=True)
@click.option("--max-new-tokens", type=int, default=128, show_default=True)
@click.option(
    "--out",
    required=True,
    type=click.Path(dir_okay=False, path_type=Path),
    help="Output JSONL path (gitignored — inherits trace privacy).",
)
@click.option("--device", default="cpu", show_default=True)
def eval_cmd(
    trace_dir: Path,
    vector_path: Path,
    layer: int | None,
    lam: float,
    max_new_tokens: int,
    out: Path,
    device: str,
) -> None:
    """Generate base vs base+vector over a trace dir -> blind-pref-ready JSONL."""

    vector, meta = _load_vector(vector_path)
    use_layer = layer if layer is not None else meta.layer
    loaded = load_model(meta.model, device=device)
    if vector.shape[0] != loaded.hidden_size:
        raise click.ClickException(
            f"vector dim {vector.shape[0]} != model hidden_size {loaded.hidden_size}"
        )
    vec = torch.from_numpy(vector)

    traces = load_eval_traces(trace_dir)
    if not traces:
        raise click.ClickException(f"no parseable traces under {trace_dir}")

    rows, summary = evaluate(
        loaded, traces, vector=vec, layer=use_layer, lam=lam,
        max_new_tokens=max_new_tokens,
    )
    write_jsonl(rows, summary, out)
    click.echo(
        f"wrote {out} ({summary.n_traces} traces); "
        f"mean steered {summary.mean_steered_tps:.1f} t/s "
        f"(gate {summary.kill_criterion_min_tps:.0f} t/s -> "
        f"{'PASS' if summary.meets_throughput_gate else 'FAIL'}). "
        "Win-rate NOT computed — JSONL is blind-pref-ready."
    )


if __name__ == "__main__":
    cli()
