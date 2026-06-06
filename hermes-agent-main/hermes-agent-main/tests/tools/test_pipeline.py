"""Tests for Pipeline & Forecasting (Sales Persona Job 3.2).

Covers the JSON deal store (create/update/keying/validation), read-only listing
+ stalled detection, the weighted weekly forecast, the human-verdict outcome loop
(clean / corrected / rejected) including pipeline lessons + the Job 3.2 trust
counter, and the tool handlers. HERMES_HOME is redirected per test; gbrain points
at a missing binary so ingest is a no-op.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest

from tools import pipeline as pl
from tools import sales_trust as st


@pytest.fixture(autouse=True)
def tmp_hermes(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("GBRAIN_BIN", str(tmp_path / "no-such-gbrain"))
    return tmp_path


def _days_ago(n: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=n)).strftime("%Y-%m-%d")


class TestUpsertDeal:
    def test_create_basic_and_weighting(self):
        d = pl.upsert_deal("Acme Grocer", "proposal", amount=1000)
        assert d["deal_id"] == "acme-grocer"
        assert d["probability"] == 0.60
        assert d["weighted_amount"] == 600.0
        assert d["review_status"] == "new"
        assert d["last_touch"]  # defaulted to today

    def test_update_in_place_preserves_unset(self):
        pl.upsert_deal("Acme", "lead", amount=500, owner="dustin", notes="first")
        d2 = pl.upsert_deal("Acme", "qualified", amount=800)
        assert d2["stage"] == "qualified"
        assert d2["amount"] == 800
        assert d2["owner"] == "dustin"   # preserved
        assert d2["notes"] == "first"    # preserved
        assert d2["weighted_amount"] == 200.0  # 800 * 0.25
        # still a single record
        assert len(pl.list_deals()) == 1

    def test_explicit_deal_id(self):
        d = pl.upsert_deal("Big Box!", "lead", deal_id="bb-2026")
        assert d["deal_id"] == "bb-2026"

    def test_bad_stage(self):
        with pytest.raises(ValueError):
            pl.upsert_deal("X", "won")

    def test_missing_account(self):
        with pytest.raises(ValueError):
            pl.upsert_deal("", "lead")

    def test_negative_amount(self):
        with pytest.raises(ValueError):
            pl.upsert_deal("X", "lead", amount=-5)


class TestListAndStalled:
    def test_list_filters_and_sort(self):
        pl.upsert_deal("A", "negotiation", amount=1000, owner="d")  # w=800
        pl.upsert_deal("B", "lead", amount=2000, owner="e")         # w=200
        pl.upsert_deal("C", "closed_won", amount=100, owner="d")    # w=100
        rows = pl.list_deals()
        assert [r["deal_id"] for r in rows] == ["a", "b", "c"]  # by weighted desc
        assert [r["deal_id"] for r in pl.list_deals(owner="d")] == ["a", "c"]
        assert [r["deal_id"] for r in pl.list_deals(stage="lead")] == ["b"]
        assert {r["deal_id"] for r in pl.list_deals(open_only=True)} == {"a", "b"}

    def test_stalled_by_age(self):
        pl.upsert_deal("Old", "proposal", amount=100, last_touch=_days_ago(30))
        pl.upsert_deal("Fresh", "proposal", amount=100, last_touch=_days_ago(2))
        ids = {r["deal_id"] for r in pl.stalled_deals(days=14)}
        assert ids == {"old"}

    def test_stalled_includes_no_touch_and_excludes_closed(self):
        # A deal with an unparseable/empty last_touch counts as stalled.
        pl.upsert_deal("NoTouch", "lead")
        rec = pl.load_deal("notouch")
        rec["last_touch"] = ""
        pl._save_deal(rec)
        pl.upsert_deal("Won", "closed_won", amount=500, last_touch=_days_ago(90))
        ids = {r["deal_id"] for r in pl.stalled_deals(days=14)}
        assert "notouch" in ids
        assert "won" not in ids


class TestForecast:
    def test_weighted_totals_and_buckets(self):
        pl.upsert_deal("A", "proposal", amount=1000, expected_close="2026-06-08")    # w=600
        pl.upsert_deal("B", "negotiation", amount=500, expected_close="2026-06-08")  # w=400
        pl.upsert_deal("C", "closed_won", amount=9999, expected_close="2026-06-08")  # excluded
        fc = pl.forecast()
        assert fc["open_deals"] == 2
        assert fc["raw_pipeline"] == 1500.0
        assert fc["weighted_forecast"] == 1000.0
        assert len(fc["by_week"]) == 1
        assert fc["by_week"][0]["weighted"] == 1000.0
        stages = {r["stage"]: r["weighted"] for r in fc["by_stage"]}
        assert stages == {"proposal": 600.0, "negotiation": 400.0}

    def test_unscheduled_bucket(self):
        pl.upsert_deal("A", "lead", amount=1000)  # no expected_close
        fc = pl.forecast()
        assert fc["by_week"][0]["week"] == "unscheduled"

    def test_empty(self):
        fc = pl.forecast()
        assert fc["open_deals"] == 0 and fc["weighted_forecast"] == 0.0


class TestOutcomeTrust:
    def test_clean_advances_trust(self):
        pl.upsert_deal("A", "lead")
        out = pl.record_pipeline_outcome("a", approved=True, corrected=False)
        assert out["clean"] is True
        assert out["review_status"] == "approved"
        assert st.get_state("3.2")["consecutive_clean"] == 1
        assert out["trust_header"].startswith("Trust:")

    def test_corrected_resets_and_writes_lesson(self):
        pl.upsert_deal("A", "lead")
        pl.record_pipeline_outcome("a", approved=True)  # 1 clean
        pl.upsert_deal("B", "lead")
        out = pl.record_pipeline_outcome(
            "b", approved=True, corrected=True,
            lessons=[{"category": "staging", "rule": "Sample-sent != proposal; keep separate."}],
        )
        assert out["clean"] is False
        assert out["lessons_recorded"] == 1
        assert st.get_state("3.2")["consecutive_clean"] == 0
        assert "proposal" in pl.get_digest().lower() or "sample" in pl.get_digest().lower()

    def test_rejected(self):
        pl.upsert_deal("A", "lead")
        out = pl.record_pipeline_outcome("a", approved=False)
        assert out["review_status"] == "rejected"
        assert st.get_state("3.2")["consecutive_clean"] == 0

    def test_outcome_missing_deal_raises(self):
        with pytest.raises(ValueError):
            pl.record_pipeline_outcome("ghost")


class TestHandlers:
    def test_upsert_handler(self):
        out = json.loads(pl._handle_upsert_deal(
            {"account": "Foo", "stage": "proposal", "amount": 100}))
        assert out["deal"]["weighted_amount"] == 60.0
        assert out["trust_header"].startswith("Trust:")

    def test_upsert_handler_bad_stage(self):
        out = json.loads(pl._handle_upsert_deal(
            {"account": "Foo", "stage": "bogus"}))
        assert "error" in out

    def test_upsert_handler_missing_account(self):
        out = json.loads(pl._handle_upsert_deal({"stage": "lead"}))
        assert "error" in out

    def test_list_handler(self):
        pl.upsert_deal("A", "lead")
        out = json.loads(pl._handle_list_deals({"stage": "lead"}))
        assert out["count"] == 1

    def test_stalled_handler(self):
        pl.upsert_deal("Old", "lead", last_touch=_days_ago(40))
        out = json.loads(pl._handle_stalled_deals({"days": 14}))
        assert out["count"] == 1 and out["days"] == 14

    def test_forecast_handler(self):
        pl.upsert_deal("A", "negotiation", amount=1000)
        out = json.loads(pl._handle_forecast({}))
        assert out["forecast"]["weighted_forecast"] == 800.0
        assert out["trust_header"].startswith("Trust:")

    def test_record_outcome_handler_missing(self):
        out = json.loads(pl._handle_record_outcome({"deal_id": "ghost"}))
        assert "error" in out

    def test_record_outcome_handler_ok(self):
        pl.upsert_deal("A", "lead")
        out = json.loads(pl._handle_record_outcome({"deal_id": "a", "approved": True}))
        assert out["clean"] is True
