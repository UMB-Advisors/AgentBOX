"""Tests for the DSPy signature definitions.

Coverage:
* ``ClassifyAndFile`` and ``DraftReply`` import + compile cleanly (DSPy
  validates signature shape at import time).
* ``CATEGORY_DESCRIPTIONS`` has the same eight keys as the live
  ``dashboard/lib/classification/prompt.ts`` ``CATEGORIES`` array. If TS
  adds a category, this test fails — bump signatures.py to match.
* ``category_descriptions_block`` renders all eight in stable order.
"""

from __future__ import annotations

import re
from pathlib import Path

import dspy

from signatures import (
    CATEGORY_DESCRIPTIONS,
    ClassifyAndFile,
    DraftReply,
    category_descriptions_block,
)


def _ts_categories() -> list[str]:
    """Parse the live category enum out of the TS source.

    We deliberately scrape rather than import to keep this test free of any
    Node tooling. Drift between TS and Python here is the bug this test
    catches.
    """

    ts_path = (
        Path(__file__).resolve().parent.parent.parent.parent
        / "dashboard"
        / "lib"
        / "classification"
        / "prompt.ts"
    )
    text = ts_path.read_text(encoding="utf-8")
    # Match: export const CATEGORIES = [ ... ] as const;
    m = re.search(r"export const CATEGORIES\s*=\s*\[(.*?)\]\s*as const;", text, flags=re.DOTALL)
    assert m is not None, "could not find CATEGORIES export in prompt.ts"
    body = m.group(1)
    return [s.strip().strip("'\"") for s in body.split(",") if s.strip() and not s.strip().startswith("//")]


def test_category_descriptions_match_ts_enum() -> None:
    ts_categories = _ts_categories()
    py_categories = list(CATEGORY_DESCRIPTIONS.keys())
    assert py_categories == ts_categories, (
        f"category drift between TS and Python — TS={ts_categories} Py={py_categories}"
    )


def test_classify_signature_imports_cleanly() -> None:
    # DSPy validates signature shape on class creation. If `ClassifyAndFile`
    # has malformed fields, this would have raised already; the smoke test
    # is just that the class object exists and exposes its fields.
    sig_fields = ClassifyAndFile.model_fields
    assert "business_framing" in sig_fields
    assert "from_addr" in sig_fields
    assert "subject" in sig_fields
    assert "body" in sig_fields
    assert "category" in sig_fields
    assert "confidence" in sig_fields


def test_draft_signature_imports_cleanly() -> None:
    sig_fields = DraftReply.model_fields
    # Inputs
    for name in (
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
    ):
        assert name in sig_fields, f"missing input field: {name}"
    # Output
    assert "reply_body" in sig_fields


def test_signatures_compile_into_predictor() -> None:
    """``dspy.Predict(Sig)`` is the smoke test GEPA itself depends on."""

    classify = dspy.Predict(ClassifyAndFile)
    draft = dspy.Predict(DraftReply)
    assert classify.signature is ClassifyAndFile or classify.signature.__name__ == "ClassifyAndFile"
    assert draft.signature is DraftReply or draft.signature.__name__ == "DraftReply"


def test_category_descriptions_block_lists_all_eight() -> None:
    block = category_descriptions_block()
    for name in CATEGORY_DESCRIPTIONS:
        assert f"- {name}:" in block
    # Stable order — same as the dict insertion order.
    expected_order = list(CATEGORY_DESCRIPTIONS.keys())
    positions = [block.index(f"- {name}:") for name in expected_order]
    assert positions == sorted(positions)
