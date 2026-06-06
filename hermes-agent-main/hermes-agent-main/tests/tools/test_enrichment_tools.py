"""Tests for Lead Enrichment & Scoring (Sales Persona Job 2.1).

Covers account recording/validation, tier derivation, the prioritized list with
filters, the human-verdict outcome loop (clean/score-changed/rejected) including
rubric lessons + the Job 2.1 trust counter, the rubric reader, and tool handlers.
HERMES_HOME is redirected per test; gbrain points at a missing binary.
"""

import json

import pytest

from tools import enrichment_tools as en
from tools import sales_trust as st


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


class TestRecordAccount:
    def test_basic_and_tier(self):
        a = en.record_account("Acme Grocer", "specialty_grocer", 82, location="WA")
        assert a["tier"] == "A" and a["status"] == "new"
        assert en.record_account("Mid Co", "gift_shop", 55)["tier"] == "B"
        assert en.record_account("Low Co", "retail", 10)["tier"] == "C"

    def test_score_clamped(self):
        assert en.record_account("X", "retail", 250)["fit_score"] == 100.0
        assert en.record_account("Y", "retail", -5)["fit_score"] == 0.0

    def test_bad_type(self):
        with pytest.raises(ValueError):
            en.record_account("Z", "linkedin_lead", 50)

    def test_id_from_name(self):
        a = en.record_account("Big Box Stores!", "retail", 60)
        assert a["account_id"] == "big-box-stores"


class TestListing:
    def test_list_pending_only_new(self):
        en.record_account("A", "retail", 80)
        en.record_account("B", "retail", 70)
        en.record_outcome("a", approved=True)
        assert {x["account_id"] for x in en.list_pending()} == {"b"}

    def test_list_scored_sorted_and_filtered(self):
        en.record_account("A", "retail", 90)
        en.record_account("B", "retail", 50)
        en.record_account("C", "retail", 20)
        rows = en.list_scored()
        assert [r["fit_score"] for r in rows] == [90, 50, 20]
        assert [r["account_id"] for r in en.list_scored(tier="A")] == ["a"]
        assert [r["account_id"] for r in en.list_scored(min_score=60)] == ["a"]


class TestOutcome:
    def test_clean_advances_trust(self):
        en.record_account("A", "retail", 80)
        out = en.record_outcome("a", approved=True, score_changed=False)
        assert out["clean"] is True and out["status"] == "approved"
        assert st.get_state("2.1")["consecutive_clean"] == 1

    def test_score_changed_resets_and_writes_lesson(self):
        en.record_account("A", "retail", 80)
        en.record_outcome("a", approved=True)  # 1 clean
        en.record_account("B", "retail", 80)
        out = en.record_outcome(
            "b", approved=True, score_changed=True,
            lessons=[{"category": "fit-signal", "rule": "Downrank if no gifting SKU shelf."}],
        )
        assert out["clean"] is False
        assert out["lessons_recorded"] == 1
        assert st.get_state("2.1")["consecutive_clean"] == 0
        assert "scoring" in en.get_rubric().lower() or "Downrank" in en.get_rubric()

    def test_rejected(self):
        en.record_account("A", "retail", 80)
        out = en.record_outcome("a", approved=False)
        assert out["status"] == "rejected"
        assert st.get_state("2.1")["consecutive_clean"] == 0

    def test_outcome_missing_account_raises(self):
        with pytest.raises(ValueError):
            en.record_outcome("ghost")


class TestRubricAndTools:
    def test_get_rubric_reads_input_and_digest(self, tmp_path):
        en.base_dir().mkdir(parents=True, exist_ok=True)
        en.rubric_path().write_text("ICP: WA specialty grocers", encoding="utf-8")
        assert "WA specialty grocers" in en.get_rubric()

    def test_record_account_handler(self):
        out = json.loads(en._handle_record_account(
            {"name": "Foo", "account_type": "retail", "fit_score": 75}))
        assert out["account"]["tier"] == "A"
        assert out["trust_header"].startswith("Trust:")

    def test_record_account_handler_bad_type(self):
        out = json.loads(en._handle_record_account(
            {"name": "Foo", "account_type": "bad", "fit_score": 75}))
        assert "error" in out

    def test_list_scored_handler(self):
        en.record_account("A", "retail", 90)
        out = json.loads(en._handle_list_scored({"tier": "A"}))
        assert out["count"] == 1

    def test_record_outcome_handler_missing(self):
        out = json.loads(en._handle_record_outcome({"account_id": "ghost"}))
        assert "error" in out
