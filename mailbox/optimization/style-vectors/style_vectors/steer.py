"""Inference-time activation steering.

Adds ``lambda * style_vector`` to the residual stream at a chosen decoder
layer during generation, via a ``register_forward_hook`` that rewrites the
block's output. The hook is installed by a context manager so it's always
removed afterward — the model is left byte-for-byte as it was found.

Reversibility is the property the MBOX-118 issue stresses: **λ=0 (or
``vector=None``) must reproduce the base output exactly.** We guarantee this
two ways:

1. ``generate(...)`` with ``lam == 0.0`` or ``vector is None`` installs no
   hook at all — the forward pass is untouched, so output is bit-identical to
   the unsteered model.
2. ``steering_hook(...)`` itself early-returns (adds nothing) when ``lam == 0``,
   so even if a caller installs it directly the identity property holds.

``generate`` returns ``GenerationResult`` carrying the decoded text, the count
of newly generated tokens, and elapsed wall-clock seconds — enough for the
eval harness to compute tokens/sec and check it against the ≥15 t/s kill
criterion.
"""

from __future__ import annotations

import contextlib
import time
from dataclasses import dataclass
from typing import Any, Iterator, Sequence

import torch

from .extract import LoadedModel


@dataclass
class GenerationResult:
    """Decoded continuation plus the numbers needed to measure throughput."""

    text: str
    new_tokens: int
    elapsed_s: float

    @property
    def tokens_per_second(self) -> float:
        if self.elapsed_s <= 0:
            return 0.0
        return self.new_tokens / self.elapsed_s


def _as_tensor(
    vector: torch.Tensor | Sequence[float] | None,
    *,
    device: str,
    dtype: torch.dtype,
) -> torch.Tensor | None:
    if vector is None:
        return None
    t = vector if isinstance(vector, torch.Tensor) else torch.tensor(vector)
    return t.to(device=device, dtype=dtype)


@contextlib.contextmanager
def steering_hook(
    loaded: LoadedModel,
    layer: int,
    vector: torch.Tensor | Sequence[float] | None,
    lam: float,
) -> Iterator[None]:
    """Context manager that adds ``lam * vector`` to layer ``layer``'s output.

    No-op (installs nothing) when ``lam == 0`` or ``vector is None`` — this is
    the reversibility guarantee. The hook rewrites the residual stream for
    *every* token position in the block's output tensor, which is what makes a
    single static vector act as a persistent style bias during autoregressive
    decoding.
    """

    if lam == 0.0 or vector is None:
        # Reversibility: nothing installed -> base behavior preserved exactly.
        yield
        return

    if layer < 0 or layer >= len(loaded.layers):
        raise IndexError(
            f"layer {layer} out of range for model with {len(loaded.layers)} layers"
        )

    block = loaded.layers[layer]
    # Resolve dtype/device from a model parameter so the add doesn't upcast.
    ref = next(loaded.model.parameters())
    vec = _as_tensor(vector, device=str(ref.device), dtype=ref.dtype)
    assert vec is not None  # guarded above

    def _hook(_module: Any, _inputs: Any, output: Any) -> Any:
        if isinstance(output, tuple):
            hs = output[0]
            steered = hs + lam * vec
            return (steered, *output[1:])
        return output + lam * vec

    handle = block.register_forward_hook(_hook)
    try:
        yield
    finally:
        handle.remove()


def generate(
    loaded: LoadedModel,
    prompt: str,
    *,
    vector: torch.Tensor | Sequence[float] | None = None,
    layer: int = 0,
    lam: float = 0.0,
    max_new_tokens: int = 128,
    do_sample: bool = False,
) -> GenerationResult:
    """Generate a continuation, optionally steered.

    ``lam=0.0`` or ``vector=None`` -> base output (no hook installed). Greedy
    by default (``do_sample=False``) so base-vs-steered comparisons are
    deterministic for the same prompt — important for the eval harness's
    side-by-side pairs.
    """

    tokenizer = loaded.tokenizer
    enc = tokenizer(prompt, return_tensors="pt")
    enc = {k: v.to(loaded.device) for k, v in enc.items()}
    input_len = enc["input_ids"].shape[1]

    gen_kwargs: dict[str, Any] = {
        "max_new_tokens": max_new_tokens,
        "do_sample": do_sample,
        "pad_token_id": tokenizer.pad_token_id
        if tokenizer.pad_token_id is not None
        else tokenizer.eos_token_id,
    }

    start = time.perf_counter()
    with steering_hook(loaded, layer, vector, lam):
        with torch.no_grad():
            out_ids = loaded.model.generate(**enc, **gen_kwargs)
    elapsed = time.perf_counter() - start

    new_ids = out_ids[0][input_len:]
    new_tokens = int(new_ids.shape[0])
    text = tokenizer.decode(new_ids, skip_special_tokens=True)
    return GenerationResult(text=text, new_tokens=new_tokens, elapsed_s=elapsed)


__all__ = [
    "GenerationResult",
    "generate",
    "steering_hook",
]
