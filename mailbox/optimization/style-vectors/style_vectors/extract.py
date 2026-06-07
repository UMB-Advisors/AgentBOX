"""Contrastive style-vector extraction via forward hooks.

Given pairs of ``(generic_draft_text, approved_reply_text)`` written in
response to the *same* inbound, we run a forward pass over each text, capture
the hidden states emitted at a configurable decoder layer through a
``register_forward_hook``, and define the **style vector** as

    style_vector = mean(approved hidden states) - mean(generic hidden states)

intuitively: the direction in residual space that points from "generic draft"
toward "operator-approved reply". Adding a scaled copy of this vector back into
the residual stream at inference time (see ``steer.py``) nudges generation
toward the approved style without touching weights — the LoRA-free path the
MBOX-118 spike is testing.

Two extraction variants are implemented:

* ``extract_naive`` — mean over ALL token positions. This is the original
  **StyleVector** recipe (arXiv:2503.05213): the per-text representation is the
  unweighted token-mean of the layer's hidden states, and the style vector is
  the difference of the two class means.

* ``extract_steerx`` — an approximation of **SteerX** (arXiv:2510.22256). SteerX
  restricts the contrast to the tokens that actually *diverge* between the two
  distributions rather than averaging indiscriminately. We can't compute a true
  paired token-alignment here (the generic and approved texts differ in length
  and wording), so we approximate "divergent / preference tokens" with a
  per-token weight derived from how far each token's hidden state sits from the
  *opposite* class mean — tokens that are most distinctive of their own class
  (largest distance from the other class's centroid) get the most weight. The
  weighted class means are then differenced exactly as in the naive case. This
  is an approximation, not a reimplementation; see ``_steerx_weights``.

Model loading is isolated behind ``load_model`` so tests can inject a tiny or
mock model. Nothing here calls the network at import time or talks to the
appliance.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Literal, Sequence

import numpy as np
import torch
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

ExtractVariant = Literal["naive", "steerx"]


# ---------------------------------------------------------------------------
# Inputs / outputs
# ---------------------------------------------------------------------------


class ContrastPair(BaseModel):
    """One ``(generic, approved)`` contrast pair on the same inbound.

    ``inbox_message_id`` is carried for provenance only — extraction never
    reads it, but the eval harness uses it to tie a pair back to its trace.
    """

    model_config = ConfigDict(extra="forbid")

    inbox_message_id: str | None = None
    generic_draft_text: str = Field(min_length=1)
    approved_reply_text: str = Field(min_length=1)


class StyleVectorMeta(BaseModel):
    """Provenance for an extracted style vector. Serialized alongside the
    ``.npy`` so a downstream steer/eval run can assert layer + model + dim
    match before injecting."""

    model_config = ConfigDict(extra="forbid")

    model: str
    layer: int
    variant: ExtractVariant
    n_pairs: int = Field(ge=1)
    hidden_size: int = Field(ge=1)
    # L2 norm of the raw (un-normalized) style vector — a quick sanity signal:
    # a near-zero norm means generic and approved hidden states barely differ
    # at this layer, i.e. the layer choice is probably wrong.
    norm: float = Field(ge=0.0)


@dataclass
class LoadedModel:
    """A model + tokenizer pair plus the resolved decoder-layer list.

    ``layers`` is the ``nn.ModuleList`` of decoder blocks we hook into. We
    resolve it once at load time because the attribute path differs by
    architecture (GPT-2 vs Llama vs Qwen); see ``_resolve_layers``.
    """

    model: Any
    tokenizer: Any
    layers: Sequence[Any]
    hidden_size: int
    device: str = "cpu"


# ---------------------------------------------------------------------------
# Model loading (isolated so tests can inject a tiny/mock model)
# ---------------------------------------------------------------------------


def _resolve_layers(model: Any) -> Sequence[Any]:
    """Best-effort resolution of the decoder-block ModuleList.

    Covers the common HF layouts:
      * GPT-2 family: ``model.transformer.h``
      * Llama / Qwen / Mistral causal-LM: ``model.model.layers``
    Falls back to a duck-typed search for the first ``ModuleList`` whose
    children look like transformer blocks. Raising here is correct — a wrong
    layer list silently produces a meaningless style vector.
    """

    candidates = [
        ("transformer", "h"),
        ("model", "layers"),
        ("gpt_neox", "layers"),
    ]
    for outer, inner in candidates:
        obj = getattr(model, outer, None)
        if obj is not None:
            layers = getattr(obj, inner, None)
            if layers is not None and len(layers) > 0:
                return layers
    raise ValueError(
        "could not resolve decoder layer list for this model architecture; "
        "extend _resolve_layers() with its attribute path"
    )


def load_model(
    model_id: str,
    *,
    device: str = "cpu",
    torch_dtype: Any | None = None,
) -> LoadedModel:
    """Load a causal-LM + tokenizer from HuggingFace.

    Kept deliberately thin and import-late so the rest of the module (and the
    synthetic unit tests) never pull in ``transformers`` unless a real model
    is actually requested.
    """

    from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: PLC0415

    tokenizer = AutoTokenizer.from_pretrained(model_id)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        torch_dtype=torch_dtype,
        output_hidden_states=False,
    )
    model.to(device)
    model.eval()
    layers = _resolve_layers(model)
    hidden_size = int(model.config.hidden_size)
    return LoadedModel(
        model=model,
        tokenizer=tokenizer,
        layers=layers,
        hidden_size=hidden_size,
        device=device,
    )


# ---------------------------------------------------------------------------
# Hidden-state capture
# ---------------------------------------------------------------------------


def _capture_hidden_states(
    loaded: LoadedModel,
    text: str,
    layer: int,
) -> torch.Tensor:
    """Run one forward pass and return the layer's hidden states.

    Returns a ``(seq_len, hidden_size)`` float tensor on CPU — the residual
    stream output of decoder block ``layer`` for every token position of
    ``text`` (batch dim squeezed; we always pass a single example).

    Capture is via ``register_forward_hook`` on the chosen block. A decoder
    block typically returns a tuple ``(hidden_states, ...)``; we take element 0
    when it's a tuple, else the tensor directly.
    """

    if layer < 0 or layer >= len(loaded.layers):
        raise IndexError(
            f"layer {layer} out of range for model with {len(loaded.layers)} layers"
        )

    captured: dict[str, torch.Tensor] = {}

    def _hook(_module: Any, _inputs: Any, output: Any) -> None:
        hs = output[0] if isinstance(output, tuple) else output
        # (batch, seq, hidden) -> (seq, hidden); detach + cpu so the handle
        # removal below frees graph references.
        captured["hs"] = hs.detach()[0].to("cpu", dtype=torch.float32)

    handle = loaded.layers[layer].register_forward_hook(_hook)
    try:
        enc = loaded.tokenizer(text, return_tensors="pt")
        enc = {k: v.to(loaded.device) for k, v in enc.items()}
        with torch.no_grad():
            loaded.model(**enc)
    finally:
        handle.remove()

    if "hs" not in captured:
        raise RuntimeError("forward hook did not fire; layer produced no output")
    return captured["hs"]


# ---------------------------------------------------------------------------
# Pure-math core (synthetic-testable; no model required)
# ---------------------------------------------------------------------------


def _mean_pool(hidden_states: torch.Tensor) -> torch.Tensor:
    """Unweighted token-mean -> ``(hidden_size,)``. The StyleVector recipe."""

    return hidden_states.mean(dim=0)


def _steerx_weights(
    approved_states: list[torch.Tensor],
    generic_states: list[torch.Tensor],
) -> tuple[list[torch.Tensor], list[torch.Tensor]]:
    """Per-token weights approximating SteerX's preference-token restriction.

    True SteerX restricts the contrast to tokens where the two next-token
    distributions diverge. We don't have aligned per-token distributions here,
    so we approximate "this token is distinctive of its class" by the distance
    of each token's hidden state from the *opposite* class centroid: tokens far
    from the other class carry the divergent signal; tokens near the other
    class's centroid are shared/boilerplate and get down-weighted.

    Returns ``(approved_weights, generic_weights)`` as lists of
    ``(seq_len,)`` tensors that each sum to 1 per text (so a weighted mean
    stays a convex combination, comparable in scale to the naive mean).
    """

    approved_centroid = torch.stack([_mean_pool(h) for h in approved_states]).mean(dim=0)
    generic_centroid = torch.stack([_mean_pool(h) for h in generic_states]).mean(dim=0)

    def _weights(states: list[torch.Tensor], opposite: torch.Tensor) -> list[torch.Tensor]:
        out: list[torch.Tensor] = []
        for hs in states:
            # distance of each token from the opposite-class centroid
            dist = torch.linalg.vector_norm(hs - opposite.unsqueeze(0), dim=1)
            total = dist.sum()
            if total <= 0:
                # degenerate (all tokens identical to opposite centroid) ->
                # fall back to uniform so we never divide by zero.
                w = torch.full((hs.shape[0],), 1.0 / hs.shape[0])
            else:
                w = dist / total
            out.append(w)
        return out

    return (
        _weights(approved_states, generic_centroid),
        _weights(generic_states, approved_centroid),
    )


def _weighted_mean(hidden_states: torch.Tensor, weights: torch.Tensor) -> torch.Tensor:
    """Weighted token-mean -> ``(hidden_size,)``. ``weights`` sums to 1."""

    return (hidden_states * weights.unsqueeze(1)).sum(dim=0)


def style_vector_from_states(
    approved_states: list[torch.Tensor],
    generic_states: list[torch.Tensor],
    *,
    variant: ExtractVariant = "naive",
) -> torch.Tensor:
    """Compute the style vector from already-captured per-text hidden states.

    This is the pure-math core, model-free and synthetic-testable. Each element
    of ``approved_states`` / ``generic_states`` is a ``(seq_len, hidden)``
    tensor for one text. Returns ``(hidden,)``:

        mean_over_texts(pooled_approved) - mean_over_texts(pooled_generic)

    where ``pooled`` is the unweighted token-mean (naive) or the SteerX-weighted
    token-mean (steerx).
    """

    if not approved_states or not generic_states:
        raise ValueError("need at least one approved and one generic state tensor")

    if variant == "naive":
        approved_pooled = [_mean_pool(h) for h in approved_states]
        generic_pooled = [_mean_pool(h) for h in generic_states]
    elif variant == "steerx":
        a_w, g_w = _steerx_weights(approved_states, generic_states)
        approved_pooled = [_weighted_mean(h, w) for h, w in zip(approved_states, a_w)]
        generic_pooled = [_weighted_mean(h, w) for h, w in zip(generic_states, g_w)]
    else:  # pragma: no cover - guarded by Literal at the type level
        raise ValueError(f"unknown variant {variant!r}")

    approved_mean = torch.stack(approved_pooled).mean(dim=0)
    generic_mean = torch.stack(generic_pooled).mean(dim=0)
    return approved_mean - generic_mean


# ---------------------------------------------------------------------------
# Public extraction entry points
# ---------------------------------------------------------------------------


@dataclass
class ExtractResult:
    """A style vector plus its provenance. ``vector`` is a CPU float tensor;
    ``as_numpy()`` mirrors it for ``.npy`` serialization."""

    vector: torch.Tensor
    meta: StyleVectorMeta

    def as_numpy(self) -> np.ndarray:
        return self.vector.detach().to("cpu", dtype=torch.float32).numpy()


def _extract(
    loaded: LoadedModel,
    pairs: Sequence[ContrastPair],
    *,
    layer: int,
    variant: ExtractVariant,
    model_id: str,
) -> ExtractResult:
    if not pairs:
        raise ValueError("no contrast pairs supplied")

    approved_states: list[torch.Tensor] = []
    generic_states: list[torch.Tensor] = []
    for pair in pairs:
        approved_states.append(
            _capture_hidden_states(loaded, pair.approved_reply_text, layer)
        )
        generic_states.append(
            _capture_hidden_states(loaded, pair.generic_draft_text, layer)
        )

    vector = style_vector_from_states(
        approved_states, generic_states, variant=variant
    )
    meta = StyleVectorMeta(
        model=model_id,
        layer=layer,
        variant=variant,
        n_pairs=len(pairs),
        hidden_size=int(vector.shape[0]),
        norm=float(torch.linalg.vector_norm(vector).item()),
    )
    return ExtractResult(vector=vector, meta=meta)


def extract_naive(
    loaded: LoadedModel,
    pairs: Sequence[ContrastPair],
    *,
    layer: int,
    model_id: str,
) -> ExtractResult:
    """StyleVector (arXiv:2503.05213): mean over ALL token positions."""

    return _extract(loaded, pairs, layer=layer, variant="naive", model_id=model_id)


def extract_steerx(
    loaded: LoadedModel,
    pairs: Sequence[ContrastPair],
    *,
    layer: int,
    model_id: str,
) -> ExtractResult:
    """SteerX approximation (arXiv:2510.22256): restrict the contrast to
    preference/divergent tokens via opposite-centroid-distance weighting.
    See ``_steerx_weights`` for the documented approximation."""

    return _extract(loaded, pairs, layer=layer, variant="steerx", model_id=model_id)


__all__ = [
    "ContrastPair",
    "ExtractResult",
    "ExtractVariant",
    "LoadedModel",
    "StyleVectorMeta",
    "extract_naive",
    "extract_steerx",
    "load_model",
    "style_vector_from_states",
]
