"""Tests for inference-time steering.

The load-bearing property (MBOX-118 stresses it): **λ=0 or vector=None must
reproduce base output exactly.** We test it three ways:

1. Synthetic — the ``steering_hook`` context manager installs nothing when
   ``lam==0`` / ``vector is None`` (a mock model with a fake layer list
   records whether a hook fired).
2. Synthetic — when a hook IS installed it adds exactly ``lam * vector`` to the
   block output tensor.
3. Tiny-model — base generation (lam=0) and an explicit ``vector=None``
   generation produce byte-identical greedy text, and a nonzero lam diverges.

Tiers are split so the synthetic ones run without transformers / network.
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from style_vectors.extract import LoadedModel  # noqa: E402
from style_vectors.steer import GenerationResult, steering_hook  # noqa: E402


# ---------------------------------------------------------------------------
# A minimal fake "decoder block" + model so the hook machinery is testable
# without transformers.
# ---------------------------------------------------------------------------


class _FakeBlock(torch.nn.Module):
    """Identity block that returns a fixed tensor; hooks can rewrite its
    output exactly as a real decoder block's output tuple would be rewritten."""

    def __init__(self, hidden: int) -> None:
        super().__init__()
        self.hidden = hidden
        # one real parameter so `next(model.parameters())` resolves dtype/device
        self.w = torch.nn.Parameter(torch.zeros(hidden))

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor]:
        return (x,)


class _FakeModel(torch.nn.Module):
    def __init__(self, hidden: int, n_layers: int) -> None:
        super().__init__()
        self.blocks = torch.nn.ModuleList([_FakeBlock(hidden) for _ in range(n_layers)])


def _fake_loaded(hidden: int = 4, n_layers: int = 3) -> LoadedModel:
    model = _FakeModel(hidden, n_layers)
    return LoadedModel(
        model=model,
        tokenizer=None,
        layers=model.blocks,
        hidden_size=hidden,
        device="cpu",
    )


# ---------------------------------------------------------------------------
# Tier 1 — synthetic reversibility + add math
# ---------------------------------------------------------------------------


def test_hook_noop_when_lam_zero() -> None:
    loaded = _fake_loaded()
    x = torch.randn(2, loaded.hidden_size)
    vec = torch.ones(loaded.hidden_size)

    with steering_hook(loaded, layer=1, vector=vec, lam=0.0):
        out = loaded.layers[1](x)[0]
    # lam=0 -> no hook -> identity
    assert torch.allclose(out, x)


def test_hook_noop_when_vector_none() -> None:
    loaded = _fake_loaded()
    x = torch.randn(2, loaded.hidden_size)

    with steering_hook(loaded, layer=0, vector=None, lam=5.0):
        out = loaded.layers[0](x)[0]
    assert torch.allclose(out, x)


def test_hook_adds_lam_times_vector() -> None:
    loaded = _fake_loaded()
    x = torch.zeros(3, loaded.hidden_size)
    vec = torch.tensor([1.0, 2.0, 3.0, 4.0])
    lam = 2.5

    with steering_hook(loaded, layer=2, vector=vec, lam=lam):
        out = loaded.layers[2](x)[0]
    # every token position gets lam*vec added
    expected = (lam * vec).expand(3, -1)
    assert torch.allclose(out, expected)


def test_hook_removed_after_context() -> None:
    loaded = _fake_loaded()
    x = torch.zeros(1, loaded.hidden_size)
    vec = torch.ones(loaded.hidden_size)

    with steering_hook(loaded, layer=0, vector=vec, lam=1.0):
        steered = loaded.layers[0](x)[0]
    after = loaded.layers[0](x)[0]
    # inside context: steered; after context: identity (hook removed)
    assert torch.allclose(steered, torch.ones(1, loaded.hidden_size))
    assert torch.allclose(after, x)


def test_hook_layer_out_of_range_raises() -> None:
    loaded = _fake_loaded(n_layers=2)
    vec = torch.ones(loaded.hidden_size)
    with pytest.raises(IndexError):
        with steering_hook(loaded, layer=2, vector=vec, lam=1.0):
            pass


def test_generation_result_tps() -> None:
    r = GenerationResult(text="hi", new_tokens=30, elapsed_s=2.0)
    assert r.tokens_per_second == 15.0
    z = GenerationResult(text="", new_tokens=0, elapsed_s=0.0)
    assert z.tokens_per_second == 0.0


# ---------------------------------------------------------------------------
# Tier 2 — tiny model: end-to-end reversibility through generate()
# ---------------------------------------------------------------------------

TINY_MODEL = "sshleifer/tiny-gpt2"


@pytest.fixture(scope="module")
def tiny_loaded():
    pytest.importorskip("transformers")
    from style_vectors.extract import load_model

    try:
        return load_model(TINY_MODEL, device="cpu")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"tiny model {TINY_MODEL} unavailable (offline?): {exc}")


def test_lam_zero_reproduces_base_output(tiny_loaded) -> None:
    from style_vectors.steer import generate

    vec = torch.ones(tiny_loaded.hidden_size)
    layer = max(0, len(tiny_loaded.layers) // 2)

    base = generate(tiny_loaded, "Hello there", vector=None, layer=layer, lam=0.0,
                    max_new_tokens=12)
    # lam=0 with a real vector present must STILL match base (no hook installed)
    lam0 = generate(tiny_loaded, "Hello there", vector=vec, layer=layer, lam=0.0,
                    max_new_tokens=12)
    assert base.text == lam0.text


def test_nonzero_lam_diverges_from_base(tiny_loaded) -> None:
    from style_vectors.steer import generate

    # A large, structured vector at a middle layer should change greedy output.
    vec = torch.arange(tiny_loaded.hidden_size, dtype=torch.float32)
    layer = max(0, len(tiny_loaded.layers) // 2)

    base = generate(tiny_loaded, "Hello there", vector=None, layer=layer, lam=0.0,
                    max_new_tokens=12)
    steered = generate(tiny_loaded, "Hello there", vector=vec, layer=layer, lam=50.0,
                       max_new_tokens=12)
    # Not a hard guarantee for every model, but tiny-gpt2 with a large lam
    # reliably perturbs the logits enough to change at least one token.
    assert steered.text != base.text
    assert steered.new_tokens > 0
