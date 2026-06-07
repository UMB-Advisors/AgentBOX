"""Tests for contrastive style-vector extraction.

Two tiers, in priority order:

1. **Synthetic / pure-math** (``style_vector_from_states``) — operate on
   hand-built tensors, no model load, no network. These are the contract:
   * naive vector == mean(approved means) - mean(generic means)
   * vector shape == hidden size
   * steerx returns a finite vector of the right shape and reduces to the
     naive result when every token is identical within a text (uniform
     weights), which is the documented degenerate case.

2. **Tiny-model** (``sshleifer/tiny-gpt2``) — guarded by a skip if torch /
   transformers / the model download are unavailable, so CI without GPU or
   network still runs the synthetic tier.

``torch`` itself is required even for the synthetic tier (the core uses torch
tensors), so the whole module importorskips it — under ``uv run pytest`` torch
is present; in a bare interpreter the module is skipped cleanly.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from style_vectors.extract import (  # noqa: E402
    ContrastPair,
    style_vector_from_states,
)


# ---------------------------------------------------------------------------
# Tier 1 — synthetic / pure-math
# ---------------------------------------------------------------------------


def test_naive_vector_equals_difference_of_class_means() -> None:
    hidden = 5
    # Two approved texts, two generic texts; arbitrary per-token rows.
    approved = [
        torch.tensor([[1.0] * hidden, [3.0] * hidden]),  # mean = 2.0
        torch.tensor([[4.0] * hidden]),                  # mean = 4.0
    ]
    generic = [
        torch.tensor([[0.0] * hidden, [2.0] * hidden]),  # mean = 1.0
        torch.tensor([[1.0] * hidden]),                  # mean = 1.0
    ]
    # approved class mean over texts = (2 + 4)/2 = 3.0
    # generic  class mean over texts = (1 + 1)/2 = 1.0
    # style vector = 3.0 - 1.0 = 2.0 in every dim
    vec = style_vector_from_states(approved, generic, variant="naive")
    assert vec.shape == (hidden,)
    assert torch.allclose(vec, torch.full((hidden,), 2.0))


def test_vector_shape_matches_hidden_size() -> None:
    hidden = 17
    approved = [torch.randn(3, hidden), torch.randn(5, hidden)]
    generic = [torch.randn(4, hidden)]
    vec = style_vector_from_states(approved, generic, variant="naive")
    assert vec.shape == (hidden,)


def test_identical_classes_give_zero_vector() -> None:
    hidden = 8
    block = torch.randn(6, hidden)
    vec = style_vector_from_states([block], [block.clone()], variant="naive")
    assert torch.allclose(vec, torch.zeros(hidden), atol=1e-6)


def test_steerx_returns_finite_vector_of_right_shape() -> None:
    hidden = 6
    approved = [torch.randn(4, hidden), torch.randn(2, hidden)]
    generic = [torch.randn(3, hidden), torch.randn(5, hidden)]
    vec = style_vector_from_states(approved, generic, variant="steerx")
    assert vec.shape == (hidden,)
    assert torch.isfinite(vec).all()


def test_steerx_matches_naive_when_tokens_uniform_within_text() -> None:
    # When every token in a text is identical, the per-token weights (which
    # sum to 1) collapse to a plain mean regardless of how they're distributed,
    # so steerx == naive for that text. Build constant-per-text blocks.
    hidden = 4
    approved = [torch.full((3, hidden), 5.0), torch.full((2, hidden), 7.0)]
    generic = [torch.full((4, hidden), 1.0), torch.full((1, hidden), 3.0)]
    naive = style_vector_from_states(approved, generic, variant="naive")
    steerx = style_vector_from_states(approved, generic, variant="steerx")
    assert torch.allclose(naive, steerx, atol=1e-5)


def test_empty_states_raise() -> None:
    with pytest.raises(ValueError):
        style_vector_from_states([], [torch.randn(2, 3)], variant="naive")
    with pytest.raises(ValueError):
        style_vector_from_states([torch.randn(2, 3)], [], variant="naive")


def test_contrast_pair_rejects_empty_text() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        ContrastPair(generic_draft_text="", approved_reply_text="ok")


# ---------------------------------------------------------------------------
# Tier 2 — tiny model (skips without transformers / network)
# ---------------------------------------------------------------------------

TINY_MODEL = "sshleifer/tiny-gpt2"


@pytest.fixture(scope="module")
def tiny_loaded():
    pytest.importorskip("transformers")
    from style_vectors.extract import load_model

    try:
        return load_model(TINY_MODEL, device="cpu")
    except Exception as exc:  # noqa: BLE001 - offline / download failure -> skip
        pytest.skip(f"tiny model {TINY_MODEL} unavailable (offline?): {exc}")


def test_extract_naive_with_tiny_model(tiny_loaded) -> None:
    from style_vectors.extract import extract_naive

    pairs = [
        ContrastPair(
            generic_draft_text="Thank you for your email. We will respond shortly.",
            approved_reply_text="Hey! Got it — shipping today, tracking to follow.",
        ),
        ContrastPair(
            generic_draft_text="Please find our standard response attached.",
            approved_reply_text="Sure thing, sending that over now.",
        ),
    ]
    layer = max(0, len(tiny_loaded.layers) // 2)
    result = extract_naive(tiny_loaded, pairs, layer=layer, model_id=TINY_MODEL)
    assert result.meta.hidden_size == tiny_loaded.hidden_size
    assert result.meta.n_pairs == 2
    assert result.meta.layer == layer
    assert result.meta.variant == "naive"
    assert result.as_numpy().shape == (tiny_loaded.hidden_size,)


def test_extract_steerx_with_tiny_model(tiny_loaded) -> None:
    from style_vectors.extract import extract_steerx

    pairs = [
        ContrastPair(
            generic_draft_text="We acknowledge receipt of your inquiry.",
            approved_reply_text="Yep, on it — give me an hour.",
        ),
    ]
    layer = max(0, len(tiny_loaded.layers) // 2)
    result = extract_steerx(tiny_loaded, pairs, layer=layer, model_id=TINY_MODEL)
    assert result.meta.variant == "steerx"
    assert result.as_numpy().shape == (tiny_loaded.hidden_size,)


def test_capture_layer_out_of_range_raises(tiny_loaded) -> None:
    from style_vectors.extract import _capture_hidden_states

    with pytest.raises(IndexError):
        _capture_hidden_states(tiny_loaded, "hello", len(tiny_loaded.layers))
